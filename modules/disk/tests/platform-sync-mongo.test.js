'use strict';
// C16 同步服务端协议验收：文件夹、条件移动、变更游标、墓碑、设备令牌。
// 仅在 PAGESAI_MONGO_TEST=1 时运行；使用临时回环 replica set，不读取生产配置。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');

const root = path.join(__dirname, '..', '..', '..');
const { MongoStorageMetadata } = require(path.join(root, 'core', 'storage', 'mongo-metadata'));
const { FileContentStore } = require(path.join(root, 'core', 'storage', 'content-store'));
const { StorageRegistry } = require(path.join(root, 'core', 'storage', 'registry'));
const { createModuleFileAdapter } = require(path.join(root, 'core', 'storage', 'module-file-adapter'));
const { DiskPlatform } = require(path.join(root, 'modules', 'disk', 'server', 'platform'));

const ENABLED = process.env.PAGESAI_MONGO_TEST === '1';
const DEPLOYMENT_ID = '9a9f0d1f-2c43-4b9e-9f10-4f8bf6a2c002';
const REGION = 'disk.user-files';

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function declaration(rootAbs) {
  return {
    regionId: REGION,
    module: 'disk',
    physicalRoot: { configKey: 'storage.disk.root', defaultSubpath: 'disk', allowImplicitChange: false },
    ownership: { rule: 'per-user', ownerField: 'userId' },
    allowedOperations: ['read', 'write', 'delete', 'rename', 'mkdir'],
    disk: { visible: true, syncable: true },
    quota: { basis: 'logical-bytes', accounting: 'per-user' }
  };
}
function context({ user = null, params = {}, query = {}, body = {}, headers = {}, stream = null } = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) search.set(key, String(value));
  return {
    req: { method: 'GET', headers, url: undefined },
    res: {},
    url: new URL(`http://127.0.0.1/api/disk${search.toString() ? `?${search.toString()}` : ''}`),
    params,
    query,
    body,
    ...(stream ? { stream } : {}),
    user
  };
}

test('Disk 同步协议：文件夹、条件移动、游标、墓碑与设备令牌', {
  skip: ENABLED ? false : '设置 PAGESAI_MONGO_TEST=1 且提供仓库外 mongodb-memory-server 后运行',
  timeout: 240000
}, async (t) => {
  const { MongoBinary } = require('mongodb-memory-server');
  const { MongoClient } = require('mongodb');
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pagesai-disk-sync-'));
  const dbPath = path.join(temporary, 'mongod');
  await fs.promises.mkdir(dbPath, { recursive: true });
  const port = await unusedPort();
  const binaryPath = await MongoBinary.getPath();
  const child = spawn(binaryPath, [
    '--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1',
    '--replSet', 'pagesai-disk-sync', '--storageEngine', 'wiredTiger', '--nounixsocket', '--quiet'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  let spawnError = null;
  child.stdout.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-16000); });
  child.stderr.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-16000); });
  child.once('error', (error) => { spawnError = error; });
  let client = null;
  let metadata = null;
  let platform = null;
  const dataRoot = path.join(temporary, 'data');
  const regionRoot = path.join(dataRoot, 'disk');
  let nowValue = Date.parse('2026-10-24T08:00:00.000Z');
  const clock = () => nowValue;
  const logger = { info() {}, warn() {}, error() {} };

  function makePlatform(config = {}) {
    return new DiskPlatform({
      config: { quotaBytes: 32 * 1024 * 1024, chunkSizeBytes: 5 * 1024 * 1024, maxChunkBytes: 8 * 1024 * 1024, ...config },
      logger,
      clock,
      runtime: { db: client.db('disk_sync'), deploymentId: DEPLOYMENT_ID, initialize: true },
      fileAdapter: ({ moduleId, regionId }) => {
        const registry = new StorageRegistry({ dataRoot, configValues: { 'storage.disk.root': regionRoot } });
        registry.registerRegion(declaration(regionRoot));
        const content = new FileContentStore({ metadata });
        return createModuleFileAdapter({ moduleId, regionId, registry, content });
      }
    });
  }

  const alice = { id: 'user-a', username: 'alice' };
  const bob = { id: 'user-b', username: 'bob' };
  const bearer = (token) => ({ authorization: `Bearer ${token}` });

  async function call(method, ctx) { return platform.handle(method, ctx); }
  async function upload(user, { name, data, folderId = null, fileId = null, baseRevision = null }) {
    const init = await call('initUpload', context({
      user, body: {
        name, size: data.length, sha256: digest(data), mimeType: 'text/plain',
        ...(folderId ? { folderId } : {}),
        ...(fileId ? { fileId, baseRevision } : {})
      }
    }));
    assert.equal(init.status, 201, JSON.stringify(init.body));
    const result = await call('putChunk', context({
      user, params: { uploadId: init.body.uploadId, index: '0' }, stream: Readable.from([data])
    }));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const completed = await call('completeUpload', context({ user, params: { uploadId: init.body.uploadId }, body: {} }));
    assert.equal(completed.status, 201, JSON.stringify(completed.body));
    return completed.body.file;
  }
  async function folder(user, name, parentId = null, operationId = undefined) {
    const result = await call('createFolder', context({ user, body: { name, parentId, ...(operationId ? { operationId } : {}) } }));
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.folder;
  }

  try {
    const directUri = `mongodb://127.0.0.1:${port}/?directConnection=true`;
    let setup = null;
    for (let attempt = 0; attempt < 200 && !setup; attempt += 1) {
      if (spawnError || child.exitCode !== null) throw new Error(`测试 mongod 启动失败: ${spawnError || child.exitCode}\n${logs}`);
      const candidate = new MongoClient(directUri, { serverSelectionTimeoutMS: 150 });
      try { await candidate.connect(); setup = candidate; }
      catch (error) {
        await candidate.close();
        if (attempt === 199) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    const admin = setup.db('admin');
    await admin.command({ replSetInitiate: {
      _id: 'pagesai-disk-sync', members: [{ _id: 0, host: `127.0.0.1:${port}` }],
      settings: { electionTimeoutMillis: 500, heartbeatIntervalMillis: 100 }
    } });
    let primary = false;
    for (let attempt = 0; attempt < 200 && !primary; attempt += 1) {
      primary = Boolean((await admin.command({ hello: 1 })).isWritablePrimary);
      if (!primary) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(primary, true, '单节点 replica set 必须成为 Primary');
    await setup.close();
    client = new MongoClient(`mongodb://127.0.0.1:${port}/?replicaSet=pagesai-disk-sync&directConnection=true`, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    await fs.promises.mkdir(regionRoot, { recursive: true });
    metadata = new MongoStorageMetadata({ client, dbName: 'disk_sync' });
    await metadata.migrate({ deploymentId: DEPLOYMENT_ID, allowInitialize: true });
    await metadata.registerRegion({ declaration: declaration(regionRoot), rootAbs: regionRoot });
    platform = makePlatform();
    await platform.start();

    await t.test('文件夹树、操作幂等与文件条件移动', async () => {
      const rootFolder = await folder(alice, 'Documents', null, 'mkdir-docs');
      const replay = await call('createFolder', context({ user: alice, body: { name: 'Documents', parentId: null, operationId: 'mkdir-docs' } }));
      assert.equal(replay.status, 200, JSON.stringify(replay.body));
      assert.equal(replay.body.folder.folderId, rootFolder.folderId);
      const child = await folder(alice, 'Projects', rootFolder.folderId);
      const file = await upload(alice, { name: 'notes.txt', data: Buffer.from('hello sync'), folderId: child.folderId });
      assert.equal(file.folderId, child.folderId);

      const moved = await call('patchFile', context({
        user: alice, params: { fileId: file.fileId }, body: { folderId: rootFolder.folderId, baseRevision: file.revision }
      }));
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      assert.equal(moved.body.file.folderId, rootFolder.folderId);
      assert.equal(moved.body.file.revision, file.revision + 1);
      const stale = await call('patchFile', context({
        user: alice, params: { fileId: file.fileId }, body: { name: 'stale.txt', baseRevision: file.revision }
      }));
      assert.equal(stale.status, 409);
      assert.equal(stale.body.code, 'REVISION_CONFLICT');

      const renamed = await call('patchFolder', context({
        user: alice, params: { folderId: child.folderId }, body: { name: 'Work', baseRevision: child.revision }
      }));
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
      assert.equal(renamed.body.folder.name, 'Work');
      const cycle = await call('patchFolder', context({
        user: alice, params: { folderId: rootFolder.folderId }, body: { parentId: child.folderId, baseRevision: rootFolder.revision }
      }));
      assert.equal(cycle.status, 400, JSON.stringify(cycle.body));
    });

    await t.test('增量游标返回有序变更、墓碑与跨用户隔离', async () => {
      const state = await call('getSyncState', context({ user: alice }));
      assert.equal(state.status, 200);
      assert.equal(state.body.epoch, DEPLOYMENT_ID);

      const tree = await call('getSyncTree', context({ user: alice }));
      assert.equal(tree.status, 200);
      assert.equal(tree.body.files.length, 1);
      assert.equal(tree.body.folders.length, 2);
      const cursor = tree.body.cursor;

      const target = tree.body.files[0];
      const removed = await call('deleteFile', context({
        user: alice, params: { fileId: target.fileId }, body: { baseRevision: target.revision }
      }));
      assert.equal(removed.status, 200, JSON.stringify(removed.body));

      const changes = await call('getSyncChanges', context({ user: alice, query: { cursor: String(cursor), limit: 100 } }));
      assert.equal(changes.status, 200, JSON.stringify(changes.body));
      assert.equal(changes.body.changes.length, 1);
      assert.equal(changes.body.changes[0].kind, 'file');
      assert.equal(changes.body.changes[0].action, 'delete');
      assert.equal(changes.body.changes[0].file.fileId, target.fileId);
      assert.ok(changes.body.cursor > cursor);

      const restored = await call('restoreFile', context({
        user: alice, params: { fileId: target.fileId }, body: { baseRevision: removed.body.revision }
      }));
      assert.equal(restored.status, 200, JSON.stringify(restored.body));
      const again = await call('getSyncChanges', context({ user: alice, query: { cursor: String(changes.body.cursor) } }));
      assert.equal(again.body.changes[0].action, 'upsert');
      assert.equal(again.body.changes[0].file.revision, restored.body.revision);

      const bobChanges = await call('getSyncChanges', context({ user: bob, query: { cursor: '0' } }));
      assert.equal(bobChanges.status, 200);
      assert.equal(bobChanges.body.changes.length, 0);
      const forbidden = await call('patchFile', context({
        user: bob, params: { fileId: target.fileId }, body: { name: 'hijack.txt', baseRevision: 1 }
      }));
      assert.equal(forbidden.status, 403);

      const future = await call('getSyncChanges', context({ user: alice, query: { cursor: '999999' } }));
      assert.equal(future.status, 410);
      assert.equal(future.body.code, 'SYNC_CURSOR_EXPIRED');
      const wrongEpoch = await call('getSyncChanges', context({ user: alice, query: { cursor: '0', epoch: 'other' } }));
      assert.equal(wrongEpoch.status, 410);
      assert.equal(wrongEpoch.body.code, 'SYNC_EPOCH_MISMATCH');
    });

    await t.test('递归删除文件夹为每个后代写墓碑', async () => {
      const parent = await folder(alice, 'Archive');
      const child = await folder(alice, '2026', parent.folderId);
      const file = await upload(alice, { name: 'old.txt', data: Buffer.from('old'), folderId: child.folderId });
      const before = await call('getSyncState', context({ user: alice }));
      const deleted = await call('deleteFolder', context({ user: alice, params: { folderId: parent.folderId } }));
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
      assert.equal(deleted.body.deletedFolders, 2);
      assert.equal(deleted.body.deletedFiles, 1);
      const changes = await call('getSyncChanges', context({ user: alice, query: { cursor: String(before.body.seq), limit: 100 } }));
      assert.equal(changes.body.changes.length, 3);
      assert.deepEqual(changes.body.changes.map((item) => item.kind).sort(), ['file', 'folder', 'folder']);
      assert.ok(changes.body.changes.every((item) => item.action === 'delete'));
      const tree = await call('getSyncTree', context({ user: alice }));
      assert.equal(tree.body.files.some((item) => item.fileId === file.fileId), false);
    });

    await t.test('游标保留窗口到期后要求全量对账', async () => {
      const narrow = makePlatform({ syncHistoryLimit: 2 });
      await narrow.start();
      for (const name of ['a', 'b', 'c']) {
        const result = await narrow.handle('createFolder', context({ user: alice, body: { name } }));
        assert.equal(result.status, 201, JSON.stringify(result.body));
      }
      const old = await narrow.handle('getSyncChanges', context({ user: alice, query: { cursor: '0' } }));
      assert.equal(old.status, 410);
      assert.equal(old.body.code, 'SYNC_CURSOR_EXPIRED');
    });

    await t.test('设备配对、令牌访问与撤销', async () => {
      const created = await call('createPairingCode', context({ user: alice }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const code = created.body.code;
      const paired = await call('pairDevice', context({ body: { code, deviceName: 'Alice Mac', platform: 'macos', protocolVersion: 1 } }));
      assert.equal(paired.status, 201, JSON.stringify(paired.body));
      const token = paired.body.token;
      assert.equal((await call('pairDevice', context({ body: { code, deviceName: 'again', platform: 'macos' } })).then((r) => r.status)), 409);

      const stateViaDevice = await call('getSyncState', context({ headers: bearer(token) }));
      assert.equal(stateViaDevice.status, 200, JSON.stringify(stateViaDevice.body));
      const treeViaDevice = await call('getSyncTree', context({ headers: bearer(token) }));
      assert.equal(treeViaDevice.status, 200);
      const list = await call('listDevices', context({ user: alice }));
      assert.equal(list.status, 200);
      assert.equal(list.body.devices.length, 1);
      const deviceId = list.body.devices[0].deviceId;

      assert.equal((await call('listDevices', context({ user: bob }))).body.devices.length, 0);
      assert.equal((await call('revokeDevice', context({ user: bob, params: { deviceId } }))).status, 403);
      const revoked = await call('revokeDevice', context({ user: alice, params: { deviceId } }));
      assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
      const rejected = await call('getSyncState', context({ headers: bearer(token) }));
      assert.equal(rejected.status, 401);
      assert.equal(rejected.body.code, 'DEVICE_REVOKED');

      const expiredCode = await call('createPairingCode', context({ user: alice }));
      nowValue += 11 * 60 * 1000;
      const expired = await call('pairDevice', context({ body: { code: expiredCode.body.code, deviceName: 'late', platform: 'windows' } }));
      assert.equal(expired.status, 410);
      assert.equal(expired.body.code, 'PAIRING_EXPIRED');
    });
  } finally {
    if (platform) await platform.stop().catch(() => {});
    if (client) await client.close().catch(() => {});
    if (metadata) await metadata.close().catch(() => {});
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
});
