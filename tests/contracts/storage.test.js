'use strict';
// P2 / C01 契约测试：存储区域登记、隐式数据根变更拒绝、授权、路径越界、幂等与条件写入、游标对账。
// 运行：node --test tests/contracts/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const coreRoot = path.join(__dirname, '..', '..', 'core');
const { StorageRegistry, validateRegion } = require(path.join(coreRoot, 'storage', 'registry.js'));
const { codes } = require(path.join(coreRoot, 'errors.js'));

const DATA_ROOT = path.join(os.tmpdir(), 'pagesai-test-data');

function region(overrides = {}) {
  return {
    regionId: 'paper.uploads',
    module: 'paper',
    physicalRoot: { configKey: 'storage.paper.root', defaultSubpath: 'paper', allowImplicitChange: false },
    ownership: { rule: 'per-user', ownerField: 'userId' },
    allowedOperations: ['read', 'write', 'delete', 'rename', 'mkdir'],
    disk: { visible: true, syncable: true, readOnly: false },
    quota: { basis: 'logical-bytes', accounting: 'per-user', dedupeByFileId: true },
    ...overrides
  };
}

test('合法区域可登记，非法区域 ID 被契约拒绝', () => {
  const reg = new StorageRegistry({ dataRoot: DATA_ROOT });
  const info = reg.registerRegion(region());
  assert.equal(info.regionId, 'paper.uploads');
  assert.equal(info.physicalRoot, path.join(DATA_ROOT, 'paper'));
  assert.throws(() => validateRegion(region({ regionId: 'Not_A_Region' })), (err) => err.code === codes.CONFIG_INVALID);
  assert.throws(() => validateRegion(region({ disk: {} })), (err) => err.code === codes.CONFIG_INVALID);
  assert.throws(() => reg.describe('survey.attachments'), (err) => err.code === codes.REGION_UNKNOWN);
});

test('隐式数据根变更被拒绝；显式确认后才允许', () => {
  const reg = new StorageRegistry({ dataRoot: DATA_ROOT, configValues: { 'storage.paper.root': path.join(DATA_ROOT, 'paper-a') } });
  reg.registerRegion(region());
  assert.throws(
    () => reg.applyConfig({ 'storage.paper.root': path.join(DATA_ROOT, 'paper-b') }),
    (err) => err.code === codes.IMPLICIT_DATA_ROOT_CHANGE
  );
  // 失败后内存配置必须回滚，不能留下「看起来已迁移」的状态
  assert.equal(reg.describe('paper.uploads').physicalRoot, path.join(DATA_ROOT, 'paper-a'));
  const applied = reg.applyConfig({ 'storage.paper.root': path.join(DATA_ROOT, 'paper-b') }, { confirmDataRootChange: true });
  assert.equal(applied.drifted.length, 1);
  assert.equal(reg.describe('paper.uploads').physicalRoot, path.join(DATA_ROOT, 'paper-b'));
});

test('授权：区域归属、允许操作、按用户所有权、Disk 只读视图', () => {
  const reg = new StorageRegistry({ dataRoot: DATA_ROOT });
  reg.registerRegion(region());
  reg.registerRegion(region({ regionId: 'mail.maildir', module: 'mail', disk: { visible: false }, ownership: { rule: 'global' } }));

  assert.doesNotThrow(() => reg.authorize({ regionId: 'paper.uploads', moduleId: 'paper', operation: 'read', userId: 'u1' }));
  assert.throws(() => reg.authorize({ regionId: 'paper.uploads', moduleId: 'survey', operation: 'read', userId: 'u1' }), (err) => err.code === codes.REGION_NOT_AUTHORIZED);
  assert.throws(() => reg.authorize({ regionId: 'paper.uploads', moduleId: 'paper', operation: 'delete' }), (err) => err.code === codes.REGION_NOT_AUTHORIZED);
  // Disk 视图可见但只读：写操作必须被拒
  reg.registerRegion(region({ regionId: 'pages.site', module: 'pages', disk: { visible: true, readOnly: true }, ownership: { rule: 'per-user' } }));
  assert.doesNotThrow(() => reg.authorize({ regionId: 'pages.site', moduleId: 'disk', operation: 'read', userId: 'u1', viaDisk: true }));
  assert.throws(() => reg.authorize({ regionId: 'pages.site', moduleId: 'disk', operation: 'write', userId: 'u1', viaDisk: true }), (err) => err.code === codes.REGION_NOT_AUTHORIZED);
  // Maildir 不进入 Disk 视图
  assert.throws(() => reg.authorize({ regionId: 'mail.maildir', moduleId: 'disk', operation: 'read' }), (err) => err.code === codes.REGION_NOT_AUTHORIZED);
});

test('路径越界被拒绝，合法相对路径落在区域内', () => {
  const reg = new StorageRegistry({ dataRoot: DATA_ROOT });
  reg.registerRegion(region());
  const abs = reg.resolvePath({ regionId: 'paper.uploads', userId: 'u1', relPath: 'docs/a.pdf' });
  assert.equal(abs, path.join(DATA_ROOT, 'paper', 'u1', 'docs', 'a.pdf'));
  assert.throws(() => reg.resolvePath({ regionId: 'paper.uploads', userId: 'u1', relPath: '../../etc/passwd' }), (err) => err.code === codes.PATH_ESCAPE);
  assert.throws(() => reg.resolvePath({ regionId: 'paper.uploads', userId: 'u1', relPath: '/etc/passwd' }), (err) => err.code === codes.PATH_ESCAPE);
  assert.throws(() => reg.resolvePath({ regionId: 'paper.uploads', userId: 'u1', relPath: 'a/./b' }), (err) => err.code === codes.PATH_ESCAPE);
});

test('变更记录：幂等、修订递增、条件写入冲突、墓碑限制', () => {
  const reg = new StorageRegistry({ dataRoot: DATA_ROOT });
  reg.registerRegion(region());
  const actor = { kind: 'user', userId: 'u1' };

  const first = reg.recordChange({ operationId: 'op-00000001', regionId: 'paper.uploads', fileId: 'f1', op: 'create', actor, path: 'a.pdf' });
  assert.equal(first.revision, 1);
  assert.equal(first.status, 'committed');

  const replay = reg.recordChange({ operationId: 'op-00000001', regionId: 'paper.uploads', fileId: 'f1', op: 'create', actor, path: 'a.pdf' });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.revision, 1);
  assert.equal(reg.currentRevision('paper.uploads', 'f1'), 1);

  assert.throws(() => reg.recordChange({ operationId: 'op-00000001', regionId: 'paper.uploads', fileId: 'f1', op: 'delete', actor }), (err) => err.code === codes.CONFLICT);

  // 条件写入：基础修订过期 → 冲突，不静默覆盖
  assert.throws(
    () => reg.recordChange({ operationId: 'op-00000002', regionId: 'paper.uploads', fileId: 'f1', op: 'update', baseRevision: 0, actor }),
    (err) => err.code === codes.CONFLICT && err.details.conflict.kind === 'both-modified'
  );
  const ok = reg.recordChange({ operationId: 'op-00000003', regionId: 'paper.uploads', fileId: 'f1', op: 'update', baseRevision: 1, actor });
  assert.equal(ok.revision, 2);

  // 墓碑只能由明确 delete 产生
  assert.throws(() => reg.recordChange({ operationId: 'op-00000004', regionId: 'paper.uploads', fileId: 'f1', op: 'update', actor, tombstone: true }), (err) => err.code === codes.INVALID_INPUT);
  const del = reg.recordChange({ operationId: 'op-00000005', regionId: 'paper.uploads', fileId: 'f1', op: 'delete', baseRevision: 2, actor, tombstone: true });
  assert.equal(del.tombstone, true);
});

test('增量游标：首次调用要求全量对账，游标过期不被当作「远端为空」', () => {
  const reg = new StorageRegistry({ dataRoot: DATA_ROOT });
  reg.registerRegion(region());
  const actor = { kind: 'service', serviceId: 'paper' };
  const a = reg.recordChange({ operationId: 'op-00000011', regionId: 'paper.uploads', fileId: 'f1', op: 'create', actor });
  reg.recordChange({ operationId: 'op-00000012', regionId: 'paper.uploads', fileId: 'f2', op: 'create', actor });

  const cold = reg.changesSince({ regionId: 'paper.uploads' });
  assert.equal(cold.reset, true);

  const inc = reg.changesSince({ regionId: 'paper.uploads', cursor: a.cursor });
  assert.equal(inc.reset, false);
  assert.equal(inc.records.length, 1);
  assert.equal(inc.records[0].fileId, 'f2');

  const stale = reg.changesSince({ regionId: 'paper.uploads', cursor: String(Number(a.cursor) - 2) });
  assert.equal(stale.reset, true);
  assert.equal(stale.reason, 'cursor-expired');
});

test('同一物理文件在多个区域入口不重复计入配额（按文件 ID 去重的事实前提）', () => {
  const reg = new StorageRegistry({ dataRoot: DATA_ROOT });
  reg.registerRegion(region());
  reg.registerRegion(region({ regionId: 'disk.view', module: 'disk', disk: { visible: true, syncable: true, readOnly: true } }));
  const a = reg.describe('paper.uploads');
  const b = reg.describe('disk.view');
  assert.equal(a.quota.dedupeByFileId, true);
  assert.equal(b.quota.dedupeByFileId, true);
  // 区域根可以不同，但稳定文件 ID 是去重依据；这里验证契约字段存在而非物理实现
  assert.equal(typeof a.physicalRoot, 'string');
  assert.equal(typeof b.physicalRoot, 'string');
});

test('契约文件本身可解析（防止 schema 漂移）', () => {
  for (const f of ['storage-region.schema.json', 'file-change.schema.json', 'module-manifest.schema.json']) {
    const p = path.join(__dirname, '..', '..', 'contracts', f);
    assert.ok(fs.existsSync(p), f + ' 缺失');
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(p, 'utf8')), f + ' 不是合法 JSON');
  }
});
