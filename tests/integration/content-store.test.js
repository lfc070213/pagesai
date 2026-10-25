'use strict';
// C07/C08 普通测试：临时文件根 + 显式内存元数据，不冒充真实 Mongo 验收。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const root = path.join(__dirname, '..', '..');
const { FileContentStore, EMPTY_SHA256 } = require(path.join(root, 'core', 'storage', 'content-store'));
const { InMemoryStorageMetadata } = require(path.join(root, 'core', 'storage', 'memory-metadata'));
const { StorageRegistry } = require(path.join(root, 'core', 'storage', 'registry'));
const { createModuleFileAdapter, createDiskFileAdapter } = require(path.join(root, 'core', 'storage', 'module-file-adapter'));
const { createCore, createServer } = require(path.join(root, 'core', 'server'));
const { InMemoryIdentityStore } = require(path.join(root, 'core', 'identity', 'store'));
const { loadConfig } = require(path.join(root, 'core', 'config'));
const { codes } = require(path.join(root, 'core', 'errors'));

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function declaration(rootAbs, overrides = {}) {
  return {
    regionId: 'paper.library', module: 'paper',
    physicalRoot: { configKey: 'storage.paper.root', defaultSubpath: 'paper', allowImplicitChange: false },
    ownership: { rule: 'per-user', ownerField: 'userId' },
    allowedOperations: ['read', 'write', 'delete', 'rename', 'mkdir'],
    disk: { visible: true, syncable: true, readOnly: false, writableViaModuleAdapter: true },
    quota: { basis: 'logical-bytes', accounting: 'per-user', dedupeByFileId: true },
    ...overrides
  };
}

async function fixture(overrides = {}) {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pagesai-content-'));
  const rootAbs = path.join(temporary, 'paper');
  const metadata = new InMemoryStorageMetadata();
  await metadata.migrate({ deploymentId: 'test-content' });
  const declarationValue = declaration(rootAbs, overrides);
  await metadata.registerRegion({ declaration: declarationValue, rootAbs });
  const registry = new StorageRegistry({ dataRoot: temporary, configValues: { 'storage.paper.root': rootAbs } });
  registry.registerRegion(declarationValue);
  const content = new FileContentStore({ metadata });
  const actor = { kind: 'user', userId: 'user-a' };
  const adapter = createModuleFileAdapter({ moduleId: 'paper', regionId: 'paper.library', registry, content });
  return { temporary, rootAbs, metadata, registry, content, actor, adapter };
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('真实文件根分块上传、续传、sha256、条件提交与 operationId 幂等', async (t) => {
  const f = await fixture();
  t.after(() => fs.promises.rm(f.temporary, { recursive: true, force: true }));
  const first = Buffer.alloc(70 * 1024, 0x5a);
  const second = Buffer.from('第二块内容'.repeat(1000));
  const payload = Buffer.concat([first, second]);
  const upload = await f.adapter.beginUpload({
    actor: f.actor, path: 'docs/a.bin', fileId: 'file-a', operationId: 'operation-a',
    size: payload.length, sha256: digest(payload)
  });
  await f.adapter.writeChunk(upload.uploadId, 0, Readable.from([first]), { actor: f.actor });
  const resumed = await f.content.requireUpload(upload.uploadId);
  assert.equal(resumed.nextOffset, first.length);
  await assert.rejects(
    f.adapter.writeChunk(upload.uploadId, 0, Readable.from([second]), { actor: f.actor }),
    (error) => error.code === codes.CONFLICT
  );
  await f.adapter.writeChunk(upload.uploadId, first.length, Readable.from([second.subarray(0, 7), second.subarray(7)]), { actor: f.actor });
  const committed = await f.adapter.commitUpload({ actor: f.actor, uploadId: upload.uploadId, baseRevision: 0, path: 'docs/a.bin' });
  assert.equal(committed.revision, 1);
  assert.equal(committed.contentHash, digest(payload));
  const opened = await f.adapter.openRead({ actor: f.actor, fileId: 'file-a' });
  assert.deepEqual(await readAll(opened.stream), payload);
  assert.equal(opened.size, payload.length);

  const replay = await f.adapter.put({
    actor: f.actor, path: 'docs/a.bin', fileId: 'file-a', operationId: 'operation-a',
    size: payload.length, sha256: digest(payload), stream: Readable.from([payload])
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.revision, 1);
  assert.equal((await f.adapter.changesSince({ actor: f.actor })).records.length, 1);
  await assert.rejects(f.adapter.put({
    actor: f.actor, path: 'docs/a.bin', fileId: 'file-a', operationId: 'operation-a',
    size: 1, sha256: digest(Buffer.from('x')), stream: Readable.from([Buffer.from('x')])
  }), (error) => error.code === codes.CONFLICT);

  const update = Buffer.from('version two');
  await assert.rejects(f.adapter.put({
    actor: f.actor, path: 'docs/a.bin', fileId: 'file-a', operationId: 'operation-b', baseRevision: 0,
    size: update.length, sha256: digest(update), stream: Readable.from([update])
  }), (error) => error.code === codes.CONFLICT);
  const secondCommit = await f.adapter.put({
    actor: f.actor, path: 'docs/a.bin', fileId: 'file-a', operationId: 'operation-c', baseRevision: 1,
    size: update.length, sha256: digest(update), stream: Readable.from([update])
  });
  assert.equal(secondCommit.revision, 2);
  const old = await f.adapter.openRead({ actor: f.actor, fileId: 'file-a', revision: 1 });
  assert.deepEqual(await readAll(old.stream), payload, '旧修订仍有确定内容引用');
});

test('崩溃在 committing 后可恢复；取消与 ENOSPC 有确定状态且不产生事件/墓碑', async (t) => {
  const f = await fixture();
  t.after(() => fs.promises.rm(f.temporary, { recursive: true, force: true }));
  const payload = Buffer.alloc(128 * 1024, 7);
  const upload = await f.adapter.beginUpload({ actor: f.actor, path: 'crash.bin', fileId: 'crash-file', operationId: 'crash-op', size: payload.length, sha256: digest(payload) });
  await f.adapter.writeChunk(upload.uploadId, 0, Readable.from([payload]), { actor: f.actor });
  await f.content.assemble(await f.content.requireUpload(upload.uploadId));
  await f.metadata.markCommitting(upload.uploadId, { baseRevision: 0, metadata: {}, path: 'crash.bin' });
  // 模拟进程崩溃：保留同一元数据与文件根，换掉 ContentStore 实例。
  const restarted = new FileContentStore({ metadata: f.metadata });
  const recovery = await restarted.recover();
  assert.equal(recovery.recovered.length, 1);
  const opened = await restarted.openRead({ regionId: 'paper.library', fileId: 'crash-file' });
  assert.deepEqual(await readAll(opened.stream), payload);
  assert.equal(recovery.failed.length, 0);

  const cancelPayload = Buffer.from('cancel me');
  const cancelled = await f.adapter.beginUpload({ actor: f.actor, path: 'cancel.bin', fileId: 'cancel-file', operationId: 'cancel-op', size: cancelPayload.length, sha256: digest(cancelPayload) });
  await f.adapter.abortUpload(cancelled.uploadId);
  assert.equal((await f.content.requireUpload(cancelled.uploadId)).status, 'cancelled');
  await assert.rejects(f.adapter.commitUpload({ actor: f.actor, uploadId: cancelled.uploadId }), (error) => error.code === codes.UPLOAD_STATE);

  const fullPayload = Buffer.from('disk full payload');
  const full = await f.adapter.beginUpload({ actor: f.actor, path: 'full.bin', fileId: 'full-file', operationId: 'full-op', size: fullPayload.length, sha256: digest(fullPayload) });
  const failing = Readable.from((async function* () {
    yield fullPayload.subarray(0, 3);
    throw Object.assign(new Error('simulated ENOSPC'), { code: 'ENOSPC' });
  })());
  await assert.rejects(f.adapter.writeChunk(full.uploadId, 0, failing, { actor: f.actor }), (error) => error.code === codes.DISK_FULL && error.status === 507);
  assert.equal((await f.content.requireUpload(full.uploadId)).status, 'failed');
  const events = await f.adapter.changesSince({ actor: f.actor });
  assert.equal(events.records.length, 1, '失败与取消不得写事件');
  assert.deepEqual(events.records[0].fileId, 'crash-file');
  assert.equal(events.records[0].tombstone, false);
});

test('零字节、配额、跨用户拒绝；Disk 与模块同提交且装卸不改变路径/哈希/引用', async (t) => {
  const f = await fixture();
  t.after(() => fs.promises.rm(f.temporary, { recursive: true, force: true }));
  const empty = await f.adapter.put({
    actor: f.actor, path: 'empty.txt', fileId: 'empty-file', operationId: 'empty-op',
    size: 0, sha256: EMPTY_SHA256, stream: Readable.from([]), quotaBytes: 5
  });
  assert.equal(empty.size, 0);
  const opened = await f.adapter.openRead({ actor: f.actor, fileId: 'empty-file' });
  assert.equal((await readAll(opened.stream)).length, 0);
  await assert.rejects(f.adapter.put({
    actor: f.actor, path: 'large.txt', fileId: 'large-file', operationId: 'large-op',
    size: 6, sha256: digest(Buffer.alloc(6)), stream: Readable.from([Buffer.alloc(6)]), quotaBytes: 5
  }), (error) => error.code === codes.QUOTA_EXCEEDED);

  const payload = Buffer.from('same commit contract');
  const moduleCommit = await f.adapter.put({
    actor: f.actor, path: 'shared.txt', fileId: 'shared-file', operationId: 'module-op',
    size: payload.length, sha256: digest(payload), stream: Readable.from([payload])
  });
  const before = await f.metadata.getFile('paper.library', 'shared-file');
  const disk = createDiskFileAdapter({ regionId: 'paper.library', registry: f.registry, content: f.content });
  const afterMount = await disk.openRead({ actor: f.actor, fileId: 'shared-file' });
  assert.equal(afterMount.contentHash, moduleCommit.contentHash);
  assert.equal(afterMount.path, before.path);
  await afterMount.close();
  const next = Buffer.from('written via Disk');
  const diskCommit = await disk.put({
    actor: f.actor, path: 'shared.txt', fileId: 'shared-file', operationId: 'disk-op', baseRevision: 1,
    size: next.length, sha256: digest(next), stream: Readable.from([next])
  });
  assert.equal(diskCommit.revision, 2);
  const after = await f.metadata.getFile('paper.library', 'shared-file');
  assert.equal(after.ownerId, before.ownerId);
  assert.ok(after.contentPath.startsWith(before.contentPath.split('/r')[0] + path.sep + 'r'));
  // 卸载只是不再持有适配器，没有移动/重写/删除数据面的动作。
  void disk;
  const remounted = createDiskFileAdapter({ regionId: 'paper.library', registry: f.registry, content: f.content });
  const reopened = await remounted.openRead({ actor: f.actor, fileId: 'shared-file' });
  assert.equal(reopened.contentHash, digest(next));
  await reopened.close();
  assert.equal((await remounted.changesSince({ actor: f.actor })).records.length, 3);

  const other = { kind: 'user', userId: 'user-b' };
  await assert.rejects(remounted.openRead({ actor: other, ownerId: 'user-a', fileId: 'shared-file' }), (error) => error.code === codes.FORBIDDEN);
  await assert.rejects(remounted.beginUpload({ actor: other, ownerId: 'user-a', path: 'steal', fileId: 'steal', operationId: 'steal-op', size: 0, sha256: EMPTY_SHA256 }), (error) => error.code === codes.FORBIDDEN);
  const beforeErrorEvents = (await f.adapter.changesSince({ actor: f.actor })).records.length;
  await assert.rejects(f.adapter.deleteFile({ actor: f.actor, fileId: 'missing', operationId: 'missing-delete', baseRevision: null }), (error) => error.code === codes.NOT_FOUND);
  assert.equal((await f.adapter.changesSince({ actor: f.actor })).records.length, beforeErrorEvents, '错误删除不得生成墓碑');
});

test('公共 HTTP transport 上传/下载真实 >64KiB 与 100MiB 文件，支持 Range、重试和跨用户隔离', { timeout: 60000 }, async (t) => {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pagesai-content-http-'));
  const rootAbs = path.join(temporary, 'paper');
  const region = declaration(rootAbs);
  const config = {
    ...loadConfig({ env: {}, dataRoot: temporary }),
    regions: [region], storage: { 'storage.paper.root': rootAbs }
  };
  const identityStore = new InMemoryIdentityStore();
  const core = createCore({ config, store: identityStore });
  core.modules.entries.set('content-fixture', {
    manifest: { capabilities: {} }, state: { installed: true, enabled: true, configured: true, ready: true }, startError: null,
    instance: { routes: [
      {
        method: 'PUT', path: '/files/:fileId', transport: { kind: 'upload', maxBytes: 100 * 1024 * 1024, accepts: ['application/octet-stream'] },
        handler: async ({ user, params, query, stream, signal }) => {
          const adapter = core.fileAdapter({ moduleId: 'paper', regionId: 'paper.library' });
          const result = await adapter.put({
            actor: { kind: 'user', userId: user.id }, path: query.path, fileId: params.fileId,
            operationId: query.operationId, size: Number(query.size), sha256: query.sha256,
            baseRevision: query.baseRevision === undefined ? null : Number(query.baseRevision), stream, signal
          });
          return { body: result };
        }
      },
      {
        method: 'GET', path: '/files/:fileId', transport: { kind: 'download' },
        handler: ({ user, params, signal }) => core.fileAdapter({ moduleId: 'paper', regionId: 'paper.library' }).openRead({ actor: { kind: 'user', userId: user.id }, fileId: params.fileId, signal })
      }
    ] }
  });
  const app = createServer(core);
  const address = await app.listen({ port: 0 });
  t.after(async () => { await app.close(); await fs.promises.rm(temporary, { recursive: true, force: true }); });
  async function token(username) {
    await core.identity.register({ username, password: 'password-1234' });
    return (await core.identity.login({ username, password: 'password-1234' })).token;
  }
  const alice = await token('alice');
  const bob = await token('bob');
  async function upload(fileId, operationId, body, auth = alice, baseRevision = 0) {
    const query = new URLSearchParams({ path: 'docs/file.bin', operationId, size: String(body.length), sha256: digest(body), baseRevision: String(baseRevision) });
    return fetch(`${address.url}/files/${fileId}?${query}`, { method: 'PUT', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/octet-stream' }, body });
  }
  const medium = Buffer.alloc(200 * 1024, 0x42);
  const mediumResult = await upload('medium', 'http-medium-op', medium);
  const mediumText = await mediumResult.text();
  assert.equal(mediumResult.status, 200, mediumText);
  const retry = await upload('medium', 'http-medium-op', medium);
  assert.equal((await retry.json()).idempotent, true);
  const range = await fetch(`${address.url}/files/medium`, { headers: { authorization: `Bearer ${alice}`, range: 'bytes=65535-65540' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 6);
  assert.equal(range.headers.get('content-range'), `bytes 65535-65540/${medium.length}`);
  const denied = await fetch(`${address.url}/files/medium`, { headers: { authorization: `Bearer ${bob}` } });
  assert.equal(denied.status, 403);

  const chunk = Buffer.alloc(64 * 1024);
  for (let i = 0; i < chunk.length; i++) chunk[i] = i % 239;
  const large = Buffer.concat(Array.from({ length: 1600 }, () => chunk)); // 100 MiB
  const largeResult = await upload('large', 'http-large-op', large);
  const largeText = await largeResult.text();
  assert.equal(largeResult.status, 200, largeText);
  assert.equal(JSON.parse(largeText).contentHash, digest(large));
  const tail = await fetch(`${address.url}/files/large`, { headers: { authorization: `Bearer ${alice}`, range: 'bytes=-65536' } });
  assert.equal(tail.status, 206);
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), chunk);
  const physical = await fstatTree(rootAbs);
  assert.ok(physical.some((entry) => entry.size === large.length), '内容必须真实落入文件根');
  assert.equal(JSON.stringify(core.storageMetadata).includes(large.toString('base64')), false);
});

async function fstatTree(rootAbs) {
  const result = [];
  async function walk(dir) {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) result.push(await fs.promises.stat(absolute));
    }
  }
  await walk(rootAbs);
  return result;
}
