'use strict';
// C08/C09 真实 MongoDB 验收：仅在本机回环单节点 replica set 上运行。
// 普通 npm test 会明确跳过；本测试不读取生产配置或连接外部数据库。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');

const root = path.join(__dirname, '..', '..');
const { MongoStorageMetadata, STORAGE_SCHEMA_VERSION } = require(path.join(root, 'core', 'storage', 'mongo-metadata'));
const { FileContentStore } = require(path.join(root, 'core', 'storage', 'content-store'));
const { StorageRegistry } = require(path.join(root, 'core', 'storage', 'registry'));
const { createModuleFileAdapter } = require(path.join(root, 'core', 'storage', 'module-file-adapter'));
const { createBackup, verifyBackup, restoreBackup, diagnoseStorage } = require(path.join(root, 'core', 'storage', 'backup'));
const { codes } = require(path.join(root, 'core', 'errors'));

const ENABLED = process.env.PAGESAI_MONGO_TEST === '1';
const DEPLOYMENT_ID = 'da10a219-e831-45ef-b9d0-a21c52d13a8f';

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
async function readAll(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function declaration(rootAbs) {
  return {
    regionId: 'paper.library', module: 'paper',
    physicalRoot: { configKey: 'storage.paper.root', defaultSubpath: 'paper', allowImplicitChange: false },
    ownership: { rule: 'per-user', ownerField: 'userId' },
    allowedOperations: ['read', 'write', 'delete'],
    disk: { visible: true, syncable: true, writableViaModuleAdapter: true },
    quota: { basis: 'logical-bytes', accounting: 'per-user', dedupeByFileId: true }
  };
}
function backupConfig(dataRoot, rootAbs, dbName) {
  return {
    schemaVersion: 1, product: 'pagesai', deploymentId: DEPLOYMENT_ID,
    dataRoot, storage: { 'storage.paper.root': rootAbs }, regions: [declaration(rootAbs)],
    database: { engine: 'mongodb', name: dbName, initialize: true, stateDir: path.join(dataRoot, 'state') }
  };
}

test('MongoDB 文件事务、恢复、持久游标与真实文件根隔离备份恢复', {
  skip: ENABLED ? false : '设置 PAGESAI_MONGO_TEST=1 且提供仓库外 mongodb-memory-server 后运行',
  timeout: 240000
}, async (t) => {
  const { MongoBinary } = require('mongodb-memory-server');
  const { MongoClient } = require('mongodb');
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pagesai-storage-mongo-'));
  const dbPath = path.join(temporary, 'mongod');
  await fs.promises.mkdir(dbPath, { recursive: true });
  const port = await unusedPort();
  const binaryPath = await MongoBinary.getPath();
  const child = spawn(binaryPath, [
    '--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1',
    '--replSet', 'pagesai-storage-test', '--storageEngine', 'wiredTiger', '--nounixsocket', '--quiet'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  let spawnError = null;
  child.stdout.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-16000); });
  child.stderr.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-16000); });
  child.once('error', (error) => { spawnError = error; });
  let client = null;
  const metadataInstances = new Set();

  async function openMetadata(dbName, { allowInitialize = false } = {}) {
    const metadata = new MongoStorageMetadata({ client, dbName });
    metadataInstances.add(metadata);
    await metadata.migrate({ deploymentId: DEPLOYMENT_ID, allowInitialize });
    return metadata;
  }
  function adapterFor(metadata, dataRoot, rootAbs) {
    const registry = new StorageRegistry({ dataRoot, configValues: { 'storage.paper.root': rootAbs } });
    registry.registerRegion(declaration(rootAbs));
    const content = new FileContentStore({ metadata });
    return { content, adapter: createModuleFileAdapter({ moduleId: 'paper', regionId: 'paper.library', registry, content }) };
  }
  async function put(adapter, input) {
    return adapter.put({ ...input, stream: Readable.from([input.payload]) });
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
      _id: 'pagesai-storage-test', members: [{ _id: 0, host: `127.0.0.1:${port}` }],
      settings: { electionTimeoutMillis: 500, heartbeatIntervalMillis: 100 }
    } });
    let primary = false;
    for (let attempt = 0; attempt < 200 && !primary; attempt += 1) {
      primary = Boolean((await admin.command({ hello: 1 })).isWritablePrimary);
      if (!primary) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(primary, true, '单节点 replica set 必须成为 Primary');
    await setup.close();
    client = new MongoClient(`mongodb://127.0.0.1:${port}/?replicaSet=pagesai-storage-test&directConnection=true`, { serverSelectionTimeoutMS: 10000 });
    await client.connect();

    const sourceDataRoot = path.join(temporary, 'source-data');
    const sourceRoot = path.join(sourceDataRoot, 'paper');
    const sourceDb = 'storage_source';
    let metadata = await openMetadata(sourceDb, { allowInitialize: true });
    await metadata.registerRegion({ declaration: declaration(sourceRoot), rootAbs: sourceRoot });
    let { content, adapter } = adapterFor(metadata, sourceDataRoot, sourceRoot);
    const actor = { kind: 'user', userId: 'mongo-user' };
    const firstPayload = Buffer.alloc(96 * 1024, 0x37);

    await t.test('并发提交只有一个成功，operationId 重试与配额账本保持原子性', async () => {
      const common = { actor, path: 'docs/race.bin', fileId: 'race', size: firstPayload.length, sha256: digest(firstPayload), baseRevision: 0, quotaBytes: 1024 * 1024, payload: firstPayload };
      const results = await Promise.allSettled([
        put(adapter, { ...common, operationId: 'race-a' }),
        put(adapter, { ...common, operationId: 'race-b' })
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
      assert.equal(results.find((result) => result.status === 'rejected').reason.code, codes.CONFLICT);
      const winner = results.find((result) => result.status === 'fulfilled').value;
      const replay = await put(adapter, { ...common, operationId: winner.operationId });
      assert.equal(replay.idempotent, true);
      assert.equal(replay.revision, 1);
      assert.deepEqual(await readAll((await adapter.openRead({ actor, fileId: 'race' })).stream), firstPayload);
      const quota = await adapter.quotaUsage({ actor });
      assert.equal(quota.used, firstPayload.length);
      assert.equal(quota.reserved, 0);
      assert.equal((await adapter.changesSince({ actor })).records.length, 1);
    });

    const crashPayload = Buffer.from('persisted across metadata restart');
    await t.test('committing 崩溃由新元数据连接恢复，续传检查点不丢', async () => {
      const upload = await adapter.beginUpload({ actor, path: 'docs/crash.bin', fileId: 'crash', operationId: 'crash-mongo', size: crashPayload.length, sha256: digest(crashPayload) });
      await adapter.writeChunk(upload.uploadId, 0, Readable.from([crashPayload.subarray(0, 8)]), { actor });
      await metadata.close();
      metadataInstances.delete(metadata);

      metadata = await openMetadata(sourceDb);
      await metadata.registerRegion({ declaration: declaration(sourceRoot), rootAbs: sourceRoot });
      ({ content, adapter } = adapterFor(metadata, sourceDataRoot, sourceRoot));
      const resumed = await content.requireUpload(upload.uploadId);
      assert.equal(resumed.nextOffset, 8);
      await adapter.writeChunk(upload.uploadId, 8, Readable.from([crashPayload.subarray(8)]), { actor });
      await content.assemble(await content.requireUpload(upload.uploadId));
      await metadata.markCommitting(upload.uploadId, { baseRevision: 0, metadata: {}, path: 'docs/crash.bin' });

      await metadata.close();
      metadataInstances.delete(metadata);
      metadata = await openMetadata(sourceDb);
      await metadata.registerRegion({ declaration: declaration(sourceRoot), rootAbs: sourceRoot });
      ({ content, adapter } = adapterFor(metadata, sourceDataRoot, sourceRoot));
      const recovery = await content.recover();
      assert.equal(recovery.failed.length, 0);
      assert.equal(recovery.recovered.length, 1);
      const opened = await adapter.openRead({ actor, fileId: 'crash' });
      assert.equal(opened.contentHash, digest(crashPayload));
      assert.deepEqual(await readAll(opened.stream), crashPayload);
    });

    let firstRevision;
    let sourceConfig;
    let backupDir;
    await t.test('真实 Mongo JSONL 与原始文件根备份可在隔离 DB/根恢复且引用哈希不变', async () => {
      const secondPayload = Buffer.from('second persistent revision');
      await put(adapter, { actor, path: 'docs/crash.bin', fileId: 'crash', operationId: 'crash-update', size: secondPayload.length, sha256: digest(secondPayload), baseRevision: 1, payload: secondPayload });
      firstRevision = await metadata.getFile('paper.library', 'crash', 1);
      const current = await metadata.getFile('paper.library', 'crash');
      const cursorPage = await adapter.changesSince({ actor });
      const incremental = await adapter.changesSince({ actor, cursor: cursorPage.nextCursor });
      assert.equal(incremental.reset, false);
      assert.equal(incremental.records.length, 0);
      const diagnostic = await diagnoseStorage({ content, regionIds: ['paper.library'], deep: true });
      assert.equal(diagnostic.ok, true);

      sourceConfig = backupConfig(sourceDataRoot, sourceRoot, sourceDb);
      const quiesceCalls = [];
      const backup = await createBackup({
        client, dbName: sourceDb, config: sourceConfig, regions: await metadata.listRegions(),
        outDir: path.join(temporary, 'backup'), label: 'isolated-drill',
        quiesce: async (paused) => { quiesceCalls.push(paused); }
      });
      backupDir = backup.backupDir;
      assert.deepEqual(quiesceCalls, [true, false]);
      const verified = await verifyBackup(backupDir);
      assert.equal(verified.ok, true);
      assert.ok(verified.checkedReferences >= 3, '当前文件与历史修订均须复核');
      assert.equal(fs.readFileSync(path.join(backupDir, 'data', 'paper.library', current.contentPath)).equals(secondPayload), true);
      assert.equal(fs.readFileSync(path.join(backupDir, 'data', 'paper.library', firstRevision.contentPath)).equals(crashPayload), true);

      const restoredDataRoot = path.join(temporary, 'isolated-data');
      const restored = await restoreBackup({ backupDir, client, targetDbName: 'storage_restored', targetDataRoot: restoredDataRoot, isolated: true });
      assert.equal(restored.ok, true);
      const restoredMetadata = await openMetadata('storage_restored');
      const restoredRoot = restored.config.storage['storage.paper.root'];
      await restoredMetadata.registerRegion({ declaration: declaration(restoredRoot), rootAbs: restoredRoot });
      const restoredRuntime = adapterFor(restoredMetadata, restoredDataRoot, restoredRoot);
      const restoredCurrent = await restoredMetadata.getFile('paper.library', 'crash');
      const restoredOld = await restoredMetadata.getFile('paper.library', 'crash', 1);
      assert.equal(restoredCurrent.contentPath, current.contentPath);
      assert.equal(restoredCurrent.contentHash, current.contentHash);
      assert.equal(restoredOld.contentHash, firstRevision.contentHash);
      assert.deepEqual(await readAll((await restoredRuntime.adapter.openRead({ actor, fileId: 'crash' })).stream), secondPayload);
      assert.deepEqual(await readAll((await restoredRuntime.adapter.openRead({ actor, fileId: 'crash', revision: 1 })).stream), crashPayload);
      assert.equal((await diagnoseStorage({ content: restoredRuntime.content, regionIds: ['paper.library'], deep: true })).ok, true);
      await assert.rejects(restoreBackup({ backupDir, client, targetDbName: sourceDb, targetDataRoot: path.join(temporary, 'other-root'), isolated: true }), (error) => error.code === codes.RESTORE_INVALID);
      await assert.rejects(restoreBackup({ backupDir, client, targetDbName: 'not_isolated', targetDataRoot: path.join(temporary, 'not-isolated'), isolated: false }), (error) => error.code === codes.RESTORE_INVALID);
    });

    await t.test('错根、错部署、错版本和错恢复配置均拒绝，失败清理隔离目标', async () => {
      const wrongRootConfig = backupConfig(sourceDataRoot, path.join(sourceDataRoot, 'wrong'), sourceDb);
      await assert.rejects(createBackup({ client, dbName: sourceDb, config: wrongRootConfig, regions: await metadata.listRegions(), outDir: path.join(temporary, 'wrong-root-backup'), quiesce: async () => {} }), (error) => error.code === codes.BACKUP_INVALID);
      const wrongDeployment = { ...sourceConfig, deploymentId: '157a913f-4638-45a4-b391-f8e70d94a0e4' };
      await assert.rejects(createBackup({ client, dbName: sourceDb, config: wrongDeployment, regions: await metadata.listRegions(), outDir: path.join(temporary, 'wrong-deployment-backup'), quiesce: async () => {} }), (error) => error.code === codes.BACKUP_INVALID);

      const wrongVersionDir = path.join(temporary, 'wrong-version-backup');
      await fs.promises.cp(backupDir, wrongVersionDir, { recursive: true });
      const manifestPath = path.join(wrongVersionDir, 'manifest.json');
      const wrongManifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      wrongManifest.storageSchemaVersion = STORAGE_SCHEMA_VERSION + 1;
      await fs.promises.writeFile(manifestPath, JSON.stringify(wrongManifest));
      await assert.rejects(verifyBackup(wrongVersionDir), (error) => error.code === codes.BACKUP_INVALID);

      const wrongRestoreConfig = backupConfig(path.join(temporary, 'declared-elsewhere'), path.join(temporary, 'declared-elsewhere', 'paper'), 'storage_restored_2');
      await assert.rejects(restoreBackup({ backupDir, client, targetDbName: 'storage_restored_2', targetDataRoot: path.join(temporary, 'actual-root'), config: wrongRestoreConfig, isolated: true }), (error) => error.code === codes.RESTORE_INVALID);

      const failedDir = path.join(temporary, 'failed-restore-backup');
      await fs.promises.cp(backupDir, failedDir, { recursive: true });
      const failedManifestPath = path.join(failedDir, 'manifest.json');
      const failedManifest = JSON.parse(await fs.promises.readFile(failedManifestPath, 'utf8'));
      failedManifest.database.collections[0].count += 1;
      await fs.promises.writeFile(failedManifestPath, JSON.stringify(failedManifest));
      const failedTarget = path.join(temporary, 'failed-target');
      await assert.rejects(restoreBackup({ backupDir: failedDir, client, targetDbName: 'failed_restore', targetDataRoot: failedTarget, isolated: true }), (error) => error.code === codes.RESTORE_INVALID);
      assert.equal(fs.existsSync(failedTarget), false);
      assert.equal((await client.db('failed_restore').listCollections({}, { nameOnly: true }).toArray()).length, 0);
    });
  } finally {
    for (const metadata of metadataInstances) await metadata.close();
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
