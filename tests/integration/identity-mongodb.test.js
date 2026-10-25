'use strict';
// 真实 MongoDB 验收：PAGESAI_MONGO_TEST=1，并通过 NODE_PATH 指向仓库外依赖。
// 测试只启动本机回环单节点 replica set，不读取生产配置或连接外部服务。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const { MongoIdentityStore, IDENTITY_SCHEMA_VERSION } = require(path.join(root, 'core', 'identity', 'mongo-store.js'));
const { IdentityService } = require(path.join(root, 'core', 'identity', 'service.js'));
const { sha256 } = require(path.join(root, 'core', 'identity', 'store.js'));
const { loadConfig } = require(path.join(root, 'core', 'config', 'index.js'));
const { createCore, createServer } = require(path.join(root, 'core', 'server.js'));
const { codes } = require(path.join(root, 'core', 'errors.js'));

const ENABLED = process.env.PAGESAI_MONGO_TEST === '1';
const DEPLOYMENT_ID = 'd9b522f5-df0c-4dd0-9914-9c344c563324';

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('MongoDB 身份事务、部署校验与同目录重启持久性', {
  skip: ENABLED ? false : '设置 PAGESAI_MONGO_TEST=1 且提供仓库外 mongodb-memory-server 后运行',
  timeout: 240000
}, async (t) => {
  const { MongoBinary } = require('mongodb-memory-server');
  const { MongoClient } = require('mongodb');
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pagesai-mongo-it-'));
  const dbPath = path.join(temporaryRoot, 'data');
  await fs.promises.mkdir(dbPath, { recursive: true });
  const port = await unusedPort();
  let mongod = null;
  let binaryPath = null;
  let uri = null;
  let replicaInitialized = false;
  const stores = new Set();

  async function startDatabase() {
    binaryPath = binaryPath || await MongoBinary.getPath();
    const child = spawn(binaryPath, [
      '--dbpath', dbPath,
      '--port', String(port),
      '--bind_ip', '127.0.0.1',
      '--replSet', 'pagesai-identity-test',
      '--storageEngine', 'wiredTiger',
      '--nounixsocket',
      '--quiet'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = '';
    let spawnError = null;
    child.stdout.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-16000); });
    child.stderr.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-16000); });
    child.once('error', (error) => { spawnError = error; });
    mongod = child;

    const directUri = `mongodb://127.0.0.1:${port}/?directConnection=true`;
    let setupClient = null;
    for (let attempt = 0; attempt < 200 && !setupClient; attempt += 1) {
      if (spawnError || child.exitCode !== null) {
        throw new Error(`测试 mongod 启动失败: ${spawnError || child.exitCode}\n${logs}`);
      }
      const candidate = new MongoClient(directUri, { serverSelectionTimeoutMS: 150 });
      try {
        await candidate.connect();
        setupClient = candidate;
      } catch (error) {
        await candidate.close();
        if (attempt === 199) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    try {
      const admin = setupClient.db('admin');
      if (!replicaInitialized) {
        await admin.command({
          replSetInitiate: {
            _id: 'pagesai-identity-test',
            members: [{ _id: 0, host: `127.0.0.1:${port}` }],
            settings: { electionTimeoutMillis: 500, heartbeatIntervalMillis: 100 }
          }
        });
        replicaInitialized = true;
      }
      let primary = false;
      for (let attempt = 0; attempt < 200 && !primary; attempt += 1) {
        primary = Boolean((await admin.command({ hello: 1 })).isWritablePrimary);
        if (!primary) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!primary) throw new Error('单节点 MongoDB replica set 未成为 Primary');
    } finally {
      await setupClient.close();
    }
    uri = `mongodb://127.0.0.1:${port}/?replicaSet=pagesai-identity-test&directConnection=true`;
  }

  async function stopDatabase() {
    if (!mongod) return;
    const child = mongod;
    mongod = null;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }

  async function closeStores() {
    for (const store of stores) await store.close();
    stores.clear();
  }

  async function openStore(dbName, { allowInitialize = false, deploymentId = DEPLOYMENT_ID } = {}) {
    const store = new MongoIdentityStore({
      uri,
      dbName,
      clientOptions: { serverSelectionTimeoutMS: 10000, maxPoolSize: 10 }
    });
    stores.add(store);
    await store.migrate({ targetVersion: IDENTITY_SCHEMA_VERSION, deploymentId, allowInitialize });
    return store;
  }

  function serviceFor(store, mail = null) {
    return new IdentityService({ store, mail });
  }

  try {
    await startDatabase();

    await t.test('空库与错误部署拒绝就绪，显式迁移可幂等执行', async () => {
      const empty = new MongoIdentityStore({ uri, dbName: 'guarded_empty' });
      stores.add(empty);
      await assert.rejects(
        empty.migrate({ targetVersion: IDENTITY_SCHEMA_VERSION, deploymentId: DEPLOYMENT_ID }),
        (err) => err.code === codes.CONFIG_INVALID && /拒绝自动创建空生产库/.test(err.message)
      );
      await empty.close();
      stores.delete(empty);

      const rawClient = new MongoClient(uri);
      await rawClient.connect();
      await rawClient.db('unowned_nonempty').collection('existing_data').insertOne({ value: 1 });
      await rawClient.close();
      const unowned = new MongoIdentityStore({ uri, dbName: 'unowned_nonempty' });
      stores.add(unowned);
      await assert.rejects(
        unowned.migrate({ targetVersion: IDENTITY_SCHEMA_VERSION, deploymentId: DEPLOYMENT_ID, allowInitialize: true }),
        (err) => err.code === codes.CONFIG_INVALID && /非空数据库/.test(err.message)
      );

      const store = await openStore('guarded', { allowInitialize: true });
      assert.equal(await store.getSchemaVersion(), IDENTITY_SCHEMA_VERSION);
      await store.migrate({ targetVersion: IDENTITY_SCHEMA_VERSION, deploymentId: DEPLOYMENT_ID });
      const wrong = new MongoIdentityStore({ uri, dbName: 'guarded' });
      stores.add(wrong);
      await assert.rejects(
        wrong.migrate({
          targetVersion: IDENTITY_SCHEMA_VERSION,
          deploymentId: '3a8a57fa-531e-4f15-a853-b58e859916ce',
          allowInitialize: true
        }),
        (err) => err.code === codes.CONFIG_INVALID && /deploymentId/.test(err.message)
      );
    });

    await t.test('跨连接并发 bootstrap 只提交一名管理员和一次关闭控制', async () => {
      const participants = await Promise.all(Array.from({ length: 5 }, async () => {
        const store = await openStore('bootstrap_race', { allowInitialize: true });
        return { store, service: serviceFor(store) };
      }));
      const results = await Promise.allSettled(participants.map(({ service }, index) => service.bootstrapAdmin({
        username: `leader${index}`,
        password: 'password-1234'
      })));
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      for (const result of results.filter((entry) => entry.status === 'rejected')) {
        assert.equal(result.reason.code, codes.BOOTSTRAP_CLOSED, result.reason.message);
      }
      assert.equal(await participants[0].store.countActiveAdmins(), 1);
      assert.equal((await participants[0].store.getBootstrapControl()).closed, true);
    });

    await t.test('并发降级与停用受共同事务锁保护，不会失去最后管理员', async () => {
      const store1 = await openStore('last_admin_race', { allowInitialize: true });
      const service1 = serviceFor(store1);
      const { user: admin1 } = await service1.bootstrapAdmin({ username: 'adminone', password: 'password-1234' });
      const { user: admin2 } = await service1.register({ username: 'admintwo', password: 'password-1234' });
      const login1 = await service1.login({ username: 'adminone', password: 'password-1234' });
      await service1.setRole(login1.token, admin2.id, 'admin');
      const login2 = await service1.login({ username: 'admintwo', password: 'password-1234' });

      const store2 = await openStore('last_admin_race');
      const service2 = serviceFor(store2);
      const results = await Promise.allSettled([
        service1.setRole(login1.token, admin1.id, 'user'),
        service2.setStatus(login2.token, admin2.id, 'disabled')
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
      assert.equal(results.find((result) => result.status === 'rejected').reason.code, codes.LAST_ADMIN_PROTECTED);
      assert.equal(await store1.countActiveAdmins(), 1);
    });

    await t.test('用户条件更新、停用递增 authVersion 并原子撤销全部会话', async () => {
      const store = await openStore('disable_revoke', { allowInitialize: true });
      const service = serviceFor(store);
      await service.bootstrapAdmin({ username: 'supervisor', password: 'password-1234' });
      const admin = await service.login({ username: 'supervisor', password: 'password-1234' });
      const { user } = await service.register({ username: 'ordinary', password: 'password-1234' });
      const sessions = await Promise.all(Array.from({ length: 3 }, () => service.login({
        username: 'ordinary', password: 'password-1234'
      })));
      await service.setStatus(admin.token, user.id, 'disabled');
      const persisted = await store.getUserById(user.id);
      assert.equal(persisted.authVersion, 1);
      assert.equal(persisted.version, 1);
      for (const session of sessions) {
        assert.ok((await store.getSession(sha256(session.token))).revokedAt);
        await assert.rejects(service.authenticate(session.token), (err) => err.code === codes.SESSION_REVOKED);
      }
      await assert.rejects(store.updateUser(user.id, 0, { status: 'active' }), (err) => err.code === codes.CONFLICT);
      await assert.rejects(service.login({ username: 'ordinary', password: 'password-1234' }), (err) => err.code === codes.ACCOUNT_DISABLED);
    });

    await t.test('正式 HTTP 入口显式选择 MongoDB，迁移完成后才监听', async () => {
      const config = loadConfig({
        env: {
          PAGESAI_DATABASE_ENGINE: 'mongodb',
          PAGESAI_DATABASE_INITIALIZE: '1',
          PAGESAI_DEPLOYMENT_ID: DEPLOYMENT_ID,
          PAGESAI_MONGO_DB: 'http_boot'
        },
        dataRoot: path.join(temporaryRoot, 'http-data')
      });
      const core = createCore({
        config,
        mongoUri: uri,
        mongodb: { dbName: 'http_boot', clientOptions: { serverSelectionTimeoutMS: 10000 } }
      });
      assert.ok(core.store instanceof MongoIdentityStore);
      const app = createServer(core);
      const address = await app.listen({ port: 0 });
      try {
        const ready = await fetch(`${address.url}/readyz`);
        assert.equal(ready.status, 200);
        const bootstrap = await fetch(`${address.url}/api/admin/bootstrap`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'httpboss', password: 'password-1234' })
        });
        assert.equal(bootstrap.status, 201);
      } finally {
        await app.close();
      }
    });

    await t.test('MongoDB 不可用时拒绝监听，不回落内存', async () => {
      const config = loadConfig({
        env: {
          PAGESAI_DATABASE_ENGINE: 'mongodb',
          PAGESAI_DATABASE_INITIALIZE: '1',
          PAGESAI_DEPLOYMENT_ID: DEPLOYMENT_ID,
          PAGESAI_MONGO_DB: 'unreachable'
        },
        dataRoot: path.join(temporaryRoot, 'unreachable-data')
      });
      const core = createCore({
        config,
        mongoUri: 'mongodb://127.0.0.1:1/?directConnection=true',
        mongodb: { dbName: 'unreachable', clientOptions: { serverSelectionTimeoutMS: 150 } }
      });
      const app = createServer(core);
      await assert.rejects(app.listen({ port: 0 }));
      assert.equal(app.server.listening, false);
      await app.close();
    });

    await t.test('用户、会话、挑战与 bootstrap 控制在 mongod 同目录重启后保持', async () => {
      const sent = [];
      const mail = { available: true, configured: true, async sendVerification(input) { sent.push(input); } };
      let store = await openStore('restart_persistence', { allowInitialize: true });
      let service = serviceFor(store, mail);
      await service.bootstrapAdmin({ username: 'persistentboss', password: 'password-1234' });
      const admin = await service.login({ username: 'persistentboss', password: 'password-1234' });
      service.configureRegistration({ requireEmailVerification: true });
      const registration = await service.register({
        username: 'pendinguser', password: 'password-1234', email: 'pending@example.com'
      });
      assert.equal(registration.user.status, 'pending_email');
      assert.equal(sent.length, 1);

      await closeStores();
      await stopDatabase();
      await startDatabase();

      store = await openStore('restart_persistence');
      service = serviceFor(store, mail);
      assert.equal((await service.authenticate(admin.token)).username, 'persistentboss');
      await assert.rejects(
        service.bootstrapAdmin({ username: 'anotherboss', password: 'password-1234' }),
        (err) => err.code === codes.BOOTSTRAP_CLOSED
      );
      const activated = await service.verifyEmail({ email: 'pending@example.com', code: sent[0].code });
      assert.equal(activated.user.status, 'active');
      assert.equal(await store.getVerification('pending@example.com', 'register'), null);
      assert.equal((await store.getUserById(registration.user.id)).emailVerified, true);
    });
  } finally {
    await closeStores();
    await stopDatabase();
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  }
});
