'use strict';
// C14 正式 Disk 数据面验收：真实 MongoDB 元数据 + ContentStore 文件修订。
// 仅在 PAGESAI_MONGO_TEST=1 时运行；使用临时回环 replica set，不读取生产配置。
// 依赖位于仓库外：NODE_PATH=/tmp/pagesai-mongo-build/node_modules。

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
const DEPLOYMENT_ID = '9a9f0d1f-2c43-4b9e-9f10-4f8bf6a2c001';
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

test('Disk 正式数据面：真实 Mongo 事务、ContentStore 修订、软删、分享与配额', {
  skip: ENABLED ? false : '设置 PAGESAI_MONGO_TEST=1 且提供仓库外 mongodb-memory-server 后运行',
  timeout: 240000
}, async (t) => {
  const { MongoBinary } = require('mongodb-memory-server');
  const { MongoClient } = require('mongodb');
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pagesai-disk-mongo-'));
  const dbPath = path.join(temporary, 'mongod');
  await fs.promises.mkdir(dbPath, { recursive: true });
  const port = await unusedPort();
  const binaryPath = await MongoBinary.getPath();
  const child = spawn(binaryPath, [
    '--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1',
    '--replSet', 'pagesai-disk-test', '--storageEngine', 'wiredTiger', '--nounixsocket', '--quiet'
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
      runtime: { db: client.db('disk_platform'), deploymentId: DEPLOYMENT_ID, initialize: true },
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

  async function init(user, input, headers = {}) {
    return platform.handle('initUpload', context({ user, body: input, headers }));
  }
  async function chunk(user, uploadId, index, data) {
    return platform.handle('putChunk', context({
      user, params: { uploadId, index: String(index) }, stream: Readable.from([Buffer.from(data)])
    }));
  }
  async function upload(user, { name, data, mimeType = 'text/plain', fileId = null, baseRevision = null, operationId = undefined }) {
    const initResult = await init(user, {
      name, size: data.length, sha256: digest(data), mimeType,
      ...(fileId ? { fileId, baseRevision } : {}),
      ...(operationId ? { operationId } : {})
    });
    assert.equal(initResult.status, 201, JSON.stringify(initResult.body));
    const uploadId = initResult.body.uploadId;
    const chunkSize = initResult.body.chunkSize;
    let index = 0;
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const result = await chunk(user, uploadId, index, data.subarray(offset, Math.min(offset + chunkSize, data.length)));
      assert.equal(result.status, 200, JSON.stringify(result.body));
      index += 1;
    }
    const completed = await platform.handle('completeUpload', context({ user, params: { uploadId }, body: {} }));
    assert.equal(completed.status, 201, JSON.stringify(completed.body));
    return completed.body.file;
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
      _id: 'pagesai-disk-test', members: [{ _id: 0, host: `127.0.0.1:${port}` }],
      settings: { electionTimeoutMillis: 500, heartbeatIntervalMillis: 100 }
    } });
    let primary = false;
    for (let attempt = 0; attempt < 200 && !primary; attempt += 1) {
      primary = Boolean((await admin.command({ hello: 1 })).isWritablePrimary);
      if (!primary) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(primary, true, '单节点 replica set 必须成为 Primary');
    await setup.close();
    client = new MongoClient(`mongodb://127.0.0.1:${port}/?replicaSet=pagesai-disk-test&directConnection=true`, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    metadata = new MongoStorageMetadata({ client, dbName: 'disk_platform' });
    await metadata.migrate({ deploymentId: DEPLOYMENT_ID, allowInitialize: true });
    await metadata.registerRegion({ declaration: declaration(regionRoot), rootAbs: regionRoot });
    platform = makePlatform();
    await platform.start();

    let smallFile;
    let largeFile;
    let shareToken;

    await t.test('init 必须声明 size 与 sha256；分块与完成写入 ContentStore 修订', async () => {
      const missing = await init(alice, { name: 'a.txt' });
      assert.equal(missing.status, 400);
      assert.equal(missing.body.code, 'INVALID_INPUT');
      assert.match(missing.body.message, /size/);

      const missingHash = await init(alice, { name: 'a.txt', size: 5 });
      assert.equal(missingHash.status, 400);
      assert.match(missingHash.body.message, /sha256/);

      smallFile = await upload(alice, { name: 'a.txt', data: Buffer.from('hello disk') });
      assert.equal(smallFile.size, 10);
      assert.equal(smallFile.revision, 1);
      assert.equal(smallFile.sha256, `sha256:${digest(Buffer.from('hello disk'))}`);

      const list = await platform.handle('listFiles', context({ user: alice }));
      assert.equal(list.status, 200);
      assert.equal(list.body.files.length, 1);
      assert.equal(list.body.quota.usedBytes, 10);
      assert.equal(list.body.quota.includesDeleted, true);
      assert.equal(list.body.regions[0], REGION);

      const info = await platform.handle('info', context({}));
      assert.equal(info.status, 200);
      assert.equal(info.body.storage, 'mongodb+content-store');
      assert.equal(info.body.region, REGION);
    });

    await t.test('operationId 重放返回同一上传声明，不产生新文件', async () => {
      const data = Buffer.from('idempotent upload');
      const operationId = 'op-disk-idempotent-0001';
      const first = await upload(alice, { name: 'idem.txt', data, operationId });
      const again = await init(alice, { name: 'idem.txt', size: data.length, sha256: digest(data), mimeType: 'text/plain', operationId });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(again.body.idempotent, true);
      assert.equal(again.body.fileId, first.fileId);
      const conflict = await init(alice, { name: 'other.txt', size: data.length, sha256: digest(data), operationId });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.code, 'OPERATION_CONFLICT');
    });

    await t.test('大于单个分块的文件可续传、按 Range 读取且哈希一致', async () => {
      const data = crypto.randomBytes(11 * 1024 * 1024 + 17);
      const initResult = await init(alice, { name: 'large.bin', size: data.length, sha256: digest(data), mimeType: 'application/octet-stream' });
      assert.equal(initResult.status, 201);
      const uploadId = initResult.body.uploadId;
      assert.equal(initResult.body.chunkSize, 5 * 1024 * 1024);
      assert.equal(initResult.body.totalChunks, 3);
      assert.equal((await chunk(alice, uploadId, 0, data.subarray(0, 5 * 1024 * 1024))).status, 200);
      assert.equal((await chunk(alice, uploadId, 2, Buffer.from('wrong order'))).status, 409);
      const resumed = await platform.handle('getUpload', context({ user: alice, params: { uploadId } }));
      assert.equal(resumed.body.upload.nextOffset, 5 * 1024 * 1024);
      assert.equal(resumed.body.upload.receivedChunks, 1);
      assert.equal((await chunk(alice, uploadId, 1, data.subarray(5 * 1024 * 1024, 10 * 1024 * 1024))).status, 200);
      assert.equal((await chunk(alice, uploadId, 2, data.subarray(10 * 1024 * 1024))).status, 200);
      const completed = await platform.handle('completeUpload', context({ user: alice, params: { uploadId }, body: {} }));
      assert.equal(completed.status, 201, JSON.stringify(completed.body));
      largeFile = completed.body.file;
      assert.equal(largeFile.size, data.length);

      const full = await platform.handle('getFileContent', context({ user: alice, params: { fileId: largeFile.fileId } }));
      assert.equal(full.status, 200);
      assert.ok(Buffer.isBuffer(full.body));
      assert.equal(full.body.length, data.length);
      assert.equal(digest(full.body), digest(data));

      const range = await platform.handle('getFileContent', context({
        user: alice, params: { fileId: largeFile.fileId }, headers: { range: 'bytes=100-199' }
      }));
      assert.equal(range.status, 206);
      assert.equal(range.headers['content-range'], `bytes 100-199/${data.length}`);
      assert.deepEqual(range.body, data.subarray(100, 200));

      const invalid = await platform.handle('getFileContent', context({
        user: alice, params: { fileId: largeFile.fileId }, headers: { range: `bytes=${data.length}-` }
      }));
      assert.equal(invalid.status, 416);

      const listed = await platform.handle('listFiles', context({ user: alice, query: { includeDeleted: '0' } }));
      const quota = listed.body.quota;
      assert.equal(quota.usedBytes, 10 + Buffer.from('idempotent upload').length + data.length);
      assert.equal(quota.reservedBytes, 0);
    });

    await t.test('覆盖写入使用 baseRevision 条件，旧修订仍可读', async () => {
      const next = Buffer.from('revision two');
      const stale = await init(alice, { name: 'a.txt', size: next.length, sha256: digest(next), fileId: smallFile.fileId, baseRevision: 99 });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.code, 'REVISION_CONFLICT');
      const updated = await upload(alice, { name: 'a.txt', data: next, fileId: smallFile.fileId, baseRevision: 1 });
      assert.equal(updated.revision, 2);
      assert.equal(updated.fileId, smallFile.fileId);
      const old = await metadata.getFile(REGION, smallFile.fileId, 1);
      assert.equal(old.size, 10);
      const current = await metadata.getFile(REGION, smallFile.fileId);
      assert.equal(current.revision, 2);
      const bobOverwrite = await init(bob, { name: 'a.txt', size: next.length, sha256: digest(next), fileId: smallFile.fileId, baseRevision: 2 });
      assert.equal(bobOverwrite.status, 403);
    });

    await t.test('软删保留内容与配额，分享与恢复遵守状态', async () => {
      const before = (await platform.handle('getQuota', context({ user: alice }))).body;
      const deleted = await platform.handle('deleteFile', context({ user: alice, params: { fileId: smallFile.fileId }, body: {} }));
      assert.equal(deleted.status, 200);
      assert.equal(deleted.body.status, 'deleted');
      const after = (await platform.handle('getQuota', context({ user: alice }))).body;
      assert.equal(after.usedBytes, before.usedBytes, '软删不移除逻辑字节');

      const hidden = await platform.handle('listFiles', context({ user: alice }));
      assert.equal(hidden.body.files.some((file) => file.fileId === smallFile.fileId), false);
      const visible = await platform.handle('listFiles', context({ user: alice, query: { includeDeleted: '1' } }));
      assert.equal(visible.body.files.some((file) => file.fileId === smallFile.fileId), true);

      const share = await platform.handle('createShare', context({ user: alice, params: { fileId: smallFile.fileId }, body: {} }));
      assert.equal(share.status, 409);
      assert.equal(share.body.code, 'FILE_DELETED');

      const ownerRead = await platform.handle('getFileContent', context({ user: alice, params: { fileId: smallFile.fileId } }));
      assert.equal(ownerRead.status, 200, '所有者仍可下载软删内容以自行决定恢复');

      const restored = await platform.handle('restoreFile', context({ user: alice, params: { fileId: smallFile.fileId }, body: {} }));
      assert.equal(restored.status, 200);
      assert.equal(restored.body.status, 'active');
    });

    await t.test('只读分享：公开读取、令牌不落明文、撤销与过期', async () => {
      const created = await platform.handle('createShare', context({ user: alice, params: { fileId: smallFile.fileId }, body: { expiresInSeconds: 60 } }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      shareToken = created.body.token;
      assert.match(shareToken, /^[A-Za-z0-9_-]{40,}$/);
      assert.equal(created.body.urlPath, `/api/disk/shares/${shareToken}/content`);
      const stored = await client.db('disk_platform').collection('disk_shares').findOne({ shareId: created.body.shareId });
      assert.ok(stored.tokenHash);
      assert.equal(JSON.stringify(stored).includes(shareToken), false, '分享令牌只以哈希持久化');
      const contentDoc = await metadata.getFile(REGION, smallFile.fileId);
      assert.equal(contentDoc.tombstone, false);
      assert.equal(contentDoc.revision, 2);

      const anonymous = await platform.handle('getShare', context({ params: { token: shareToken } }));
      assert.equal(anonymous.status, 200);
      assert.equal(anonymous.body.file.name, 'a.txt');
      const content = await platform.handle('getShareContent', context({ params: { token: shareToken } }));
      assert.equal(content.status, 200);
      assert.equal(content.body.toString('utf8'), 'revision two');
      const ranged = await platform.handle('getShareContent', context({ params: { token: shareToken }, headers: { range: 'bytes=0-3' } }));
      assert.equal(ranged.status, 206);

      const revoked = await platform.handle('revokeShare', context({ user: alice, params: { shareId: created.body.shareId } }));
      assert.equal(revoked.status, 200);
      const afterRevoke = await platform.handle('getShare', context({ params: { token: shareToken } }));
      assert.equal(afterRevoke.status, 410);
      assert.equal(afterRevoke.body.code, 'SHARE_REVOKED');

      const expiring = await platform.handle('createShare', context({ user: alice, params: { fileId: smallFile.fileId }, body: { expiresInSeconds: 30 } }));
      assert.equal(expiring.status, 201);
      nowValue += 31 * 1000;
      const expired = await platform.handle('getShare', context({ params: { token: expiring.body.token } }));
      assert.equal(expired.status, 410);
      assert.equal(expired.body.code, 'SHARE_EXPIRED');
      const tooLong = await platform.handle('createShare', context({ user: alice, params: { fileId: smallFile.fileId }, body: { expiresInSeconds: 99999999 } }));
      assert.equal(tooLong.status, 400);
    });

    await t.test('跨用户隔离：列表、详情、内容、分享与上传任务均 403/404', async () => {
      const list = await platform.handle('listFiles', context({ user: bob }));
      assert.equal(list.status, 200);
      assert.equal(list.body.files.length, 0);
      const detail = await platform.handle('getFile', context({ user: bob, params: { fileId: smallFile.fileId } }));
      assert.equal(detail.status, 403);
      const content = await platform.handle('getFileContent', context({ user: bob, params: { fileId: smallFile.fileId } }));
      assert.equal(content.status, 403);
      const share = await platform.handle('createShare', context({ user: bob, params: { fileId: smallFile.fileId }, body: {} }));
      assert.equal(share.status, 403);
      const anonymous = await platform.handle('listFiles', context({}));
      assert.equal(anonymous.status, 401);
      const anonymousWrite = await platform.handle('initUpload', context({ body: { name: 'x', size: 1, sha256: digest(Buffer.from('x')) } }));
      assert.equal(anonymousWrite.status, 403);
    });

    await t.test('配额在 init 阶段原子拒绝，不占用已有用户配额', async () => {
      const tiny = makePlatform({ quotaBytes: 1024 });
      await tiny.start();
      const tooBig = await tiny.handle('initUpload', context({
        user: bob, body: { name: 'big.bin', size: 2048, sha256: digest(Buffer.alloc(2048)) }
      }));
      assert.equal(tooBig.status, 413);
      assert.equal(tooBig.body.code, 'QUOTA_EXCEEDED');
      const quota = (await tiny.handle('getQuota', context({ user: bob }))).body;
      assert.equal(quota.usedBytes, 0);
      assert.equal(quota.reservedBytes, 0);
    });

    await t.test('取消上传释放预留配额，重复 complete 幂等', async () => {
      const data = Buffer.from('cancel me');
      const started = await init(bob, { name: 'cancel.bin', size: data.length, sha256: digest(data) });
      assert.equal(started.status, 201);
      const reserved = (await platform.handle('getQuota', context({ user: bob }))).body;
      assert.equal(reserved.reservedBytes, data.length);
      const cancelled = await platform.handle('abortUpload', context({ user: bob, params: { uploadId: started.body.uploadId } }));
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.status, 'cancelled');
      const released = (await platform.handle('getQuota', context({ user: bob }))).body;
      assert.equal(released.reservedBytes, 0);

      const replay = await upload(alice, { name: 'once.txt', data: Buffer.from('once') });
      const uploadDoc = await client.db('disk_platform').collection('disk_uploads').findOne({ fileId: replay.fileId });
      const again = await platform.handle('completeUpload', context({ user: alice, params: { uploadId: uploadDoc.uploadId }, body: {} }));
      assert.equal(again.status, 200);
      assert.equal(again.body.idempotent, true);
      assert.equal(again.body.file.revision, 1);
    });
  } finally {
    if (platform) await platform.stop().catch(() => {});
    if (metadata) await metadata.close().catch(() => {});
    if (client) await client.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
});
