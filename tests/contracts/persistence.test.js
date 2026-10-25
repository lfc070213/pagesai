'use strict';
// C02 持久化契约测试：区域与变更日志跨进程/重启保留，且重启后仍拒绝隐式换根。
// 运行：node --test tests/contracts/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const coreRoot = path.join(__dirname, '..', '..', 'core');
const { PersistentStorageRegistry } = require(path.join(coreRoot, 'storage', 'persistence.js'));
const { codes } = require(path.join(coreRoot, 'errors.js'));

const DATA_ROOT = path.join(os.tmpdir(), 'pagesai-persist-data');

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

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagesai-persist-'));
  return path.join(dir, name);
}

test('区域与变更记录写入磁盘，重建实例后仍可读', () => {
  const filePath = tmpFile('regions.json');
  const a = new PersistentStorageRegistry({ filePath, dataRoot: DATA_ROOT });
  assert.equal(a.load().restored, false);
  a.registerRegion(region());
  const actor = { kind: 'user', userId: 'u1' };
  const rec = a.recordChange({ operationId: 'op-00000001', regionId: 'paper.uploads', fileId: 'f1', op: 'create', actor, path: 'a.pdf' });
  assert.equal(rec.revision, 1);
  assert.ok(fs.existsSync(filePath));

  const b = new PersistentStorageRegistry({ filePath, dataRoot: DATA_ROOT });
  assert.equal(b.load().restored, true);
  assert.equal(b.describe('paper.uploads').physicalRoot, path.join(DATA_ROOT, 'paper'));
  assert.equal(b.currentRevision('paper.uploads', 'f1'), 1);
  assert.equal(b.changesSince({ regionId: 'paper.uploads' }).reset, true);
  assert.equal(b.changesSince({ regionId: 'paper.uploads' }).records.length, 1);
  // 幂等性跨重启仍然成立
  const replay = b.recordChange({ operationId: 'op-00000001', regionId: 'paper.uploads', fileId: 'f1', op: 'create', actor, path: 'a.pdf' });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.revision, 1);
});

test('重启后继承的游标可继续增量读取', () => {
  const filePath = tmpFile('cursor.json');
  const a = new PersistentStorageRegistry({ filePath, dataRoot: DATA_ROOT });
  a.registerRegion(region());
  const actor = { kind: 'service', serviceId: 'paper' };
  const r1 = a.recordChange({ operationId: 'op-00000011', regionId: 'paper.uploads', fileId: 'f1', op: 'create', actor });
  const b = new PersistentStorageRegistry({ filePath, dataRoot: DATA_ROOT });
  const r2 = b.recordChange({ operationId: 'op-00000012', regionId: 'paper.uploads', fileId: 'f2', op: 'create', actor });
  const inc = b.changesSince({ regionId: 'paper.uploads', cursor: r1.cursor });
  assert.equal(inc.reset, false);
  assert.deepEqual(inc.records.map((r) => r.fileId), ['f2']);
  assert.equal(inc.nextCursor, r2.cursor);
});

test('重启后仍拒绝隐式数据根变更（未确认时配置与磁盘状态都不变）', () => {
  const filePath = tmpFile('drift.json');
  const a = new PersistentStorageRegistry({ filePath, dataRoot: DATA_ROOT });
  a.registerRegion(region());
  const b = new PersistentStorageRegistry({ filePath, dataRoot: DATA_ROOT });
  assert.throws(
    () => b.applyConfig({ 'storage.paper.root': path.join(DATA_ROOT, 'moved') }),
    (err) => err.code === codes.IMPLICIT_DATA_ROOT_CHANGE
  );
  assert.equal(b.describe('paper.uploads').physicalRoot, path.join(DATA_ROOT, 'paper'));
  // 显式确认后允许，并落盘
  b.applyConfig({ 'storage.paper.root': path.join(DATA_ROOT, 'moved') }, { confirmDataRootChange: true });
  const c = new PersistentStorageRegistry({ filePath, dataRoot: DATA_ROOT });
  assert.equal(c.describe('paper.uploads').physicalRoot, path.join(DATA_ROOT, 'moved'));
});

test('持久化文件损坏时拒绝启动，而不是静默重建空状态', () => {
  const filePath = tmpFile('broken.json');
  fs.writeFileSync(filePath, '{ not json');
  assert.throws(() => new PersistentStorageRegistry({ filePath, dataRoot: DATA_ROOT }), (err) => err.code === codes.CONFIG_INVALID);
  fs.writeFileSync(filePath, JSON.stringify({ formatVersion: 999, regions: [], revisions: [], changeLog: [], changes: [], cursorSeq: 0 }));
  assert.throws(() => new PersistentStorageRegistry({ filePath, dataRoot: DATA_ROOT }), (err) => err.code === codes.CONFIG_INVALID);
});

test('持久化文件权限为 0600（不含秘密，但仍不应全局可读）', () => {
  const filePath = tmpFile('perm.json');
  const reg = new PersistentStorageRegistry({ filePath, dataRoot: DATA_ROOT });
  reg.registerRegion(region());
  const mode = fs.statSync(filePath).mode & 0o777;
  assert.equal(mode, 0o600);
});