'use strict';
// C14：仓库外临时干净安装（核心 + Disk），真实 MongoDB、真实 HTTP 与网页。
// 不读取生产配置；文件使用合成内容；仅在 PAGESAI_MONGO_TEST=1 时运行。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const ENABLED = process.env.PAGESAI_MONGO_TEST === '1';
const sourceRoot = path.join(__dirname, '..', '..');
const PASSWORD = 'disk-e2e-password';

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startMongo(root) {
  const { MongoBinary } = require('mongodb-memory-server');
  const { MongoClient } = require('mongodb');
  const dbPath = path.join(root, 'mongo-data');
  await fs.promises.mkdir(dbPath, { recursive: true });
  const port = await unusedPort();
  const binary = await MongoBinary.getPath();
  const child = spawn(binary, [
    '--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1',
    '--replSet', 'pagesai-disk-e2e', '--storageEngine', 'wiredTiger', '--nounixsocket', '--quiet'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-12000); });
  child.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-12000); });
  const direct = `mongodb://127.0.0.1:${port}/?directConnection=true`;
  let setup;
  for (let attempt = 0; attempt < 200 && !setup; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`mongod 启动失败：${logs}`);
    const candidate = new MongoClient(direct, { serverSelectionTimeoutMS: 150 });
    try { await candidate.connect(); setup = candidate; }
    catch (error) {
      await candidate.close();
      if (attempt === 199) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const admin = setup.db('admin');
  await admin.command({ replSetInitiate: {
    _id: 'pagesai-disk-e2e', members: [{ _id: 0, host: `127.0.0.1:${port}` }],
    settings: { electionTimeoutMillis: 500, heartbeatIntervalMillis: 100 }
  } });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await admin.command({ hello: 1 })).isWritablePrimary) break;
    if (attempt === 199) throw new Error('mongod 未成为 Primary');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await setup.close();
  const uri = `mongodb://127.0.0.1:${port}/?replicaSet=pagesai-disk-e2e&directConnection=true`;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  return { child, client, uri };
}

async function stopMongo(mongo) {
  if (!mongo) return;
  await mongo.client.close().catch(() => {});
  if (mongo.child.exitCode === null && mongo.child.signalCode === null) {
    mongo.child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => { mongo.child.kill('SIGKILL'); resolve(); }, 5000);
      mongo.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

async function cleanInstall(root) {
  const installRoot = path.join(root, 'clean-install');
  const dataRoot = path.join(root, 'clean-data');
  await fs.promises.mkdir(installRoot, { recursive: true });
  for (const directory of ['core', 'config', 'contracts']) {
    await fs.promises.cp(path.join(sourceRoot, directory), path.join(installRoot, directory), { recursive: true });
  }
  await fs.promises.mkdir(path.join(installRoot, 'modules', 'disk'), { recursive: true });
  for (const entry of ['manifest.json', 'config.schema.json', 'server', 'web']) {
    await fs.promises.cp(path.join(sourceRoot, 'modules', 'disk', entry), path.join(installRoot, 'modules', 'disk', entry), { recursive: true });
  }
  await fs.promises.mkdir(path.join(installRoot, 'tools'), { recursive: true });
  await fs.promises.copyFile(path.join(sourceRoot, 'tools', 'init.js'), path.join(installRoot, 'tools', 'init.js'));
  await fs.promises.copyFile(path.join(sourceRoot, 'package.json'), path.join(installRoot, 'package.json'));
  const configPath = path.join(installRoot, 'config.json');
  await exec(process.execPath, [
    'tools/init.js', '--data-root', dataRoot, '--modules', 'disk', '--install-root', installRoot,
    '--config', configPath, '--json'
  ], { cwd: installRoot, env: { PATH: process.env.PATH || '/usr/bin:/bin' } });
  const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
  config.moduleConfig = { disk: { quotaBytes: 32 * 1024 * 1024, chunkSizeBytes: 5 * 1024 * 1024, maxChunkBytes: 8 * 1024 * 1024 } };
  await fs.promises.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { installRoot, dataRoot, configPath, config };
}

function client(base) {
  async function call(route, { method = 'GET', cookie, json, body, headers = {} } = {}) {
    const requestHeaders = { ...headers };
    if (cookie) requestHeaders.cookie = cookie;
    if (json !== undefined) { requestHeaders['content-type'] = 'application/json'; body = JSON.stringify(json); }
    const response = await fetch(base + route, { method, headers: requestHeaders, body });
    const type = response.headers.get('content-type') || '';
    const payload = type.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, body: payload };
  }
  async function ok(route, options) {
    const result = await call(route, options);
    assert.ok(result.status >= 200 && result.status < 300, `${options && options.method || 'GET'} ${route}: ${result.status} ${JSON.stringify(result.body)}`);
    return result.body;
  }
  async function login(username) {
    const response = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD })
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return { cookie: response.headers.get('set-cookie').split(';', 1)[0], body: JSON.parse(text) };
  }
  return { call, ok, login };
}

test('Disk 单装：网页、分块大文件、Range、修订、软删、分享、跨用户与重启持久化', {
  skip: ENABLED ? false : '设置 PAGESAI_MONGO_TEST=1，使用仓库外 /tmp/pagesai-mongo-build 依赖运行',
  timeout: 300000
}, async () => {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pagesai-disk-clean-'));
  let mongo; let runtime;
  try {
    mongo = await startMongo(temporary);
    const installation = await cleanInstall(temporary);
    const env = { PATH: process.env.PATH || '/usr/bin:/bin', PAGESAI_MONGO_URL: mongo.uri };
    const { startRuntime } = require(path.join(installation.installRoot, 'core', 'runtime.js'));
    runtime = await startRuntime({ configPath: installation.configPath, env, port: 0 });
    let base = runtime.url;
    let api = client(base);

    const health = await api.ok('/api/disk/health');
    assert.equal(health.ok, true);
    assert.deepEqual(health.regions, ['disk.user-files']);
    assert.equal(health.storage, 'mongodb+content-store');
    assert.equal((await api.ok('/api/disk/info')).region, 'disk.user-files');

    const html = (await api.ok('/disk')).toString();
    assert.match(html, /id="appView"/);
    assert.match(html, /src="\/disk-app.js"/);
    assert.match(html, /href="\/disk-app.css"/);
    const page = await api.call('/disk');
    assert.match(page.headers.get('content-security-policy') || '', /default-src 'self'/);
    const script = (await api.ok('/disk-app.js')).toString();
    assert.match(script, /\/api\/disk\/files/);
    assert.doesNotMatch(script, /x-dev-user/);
    assert.match((await api.ok('/disk-app.css')).toString(), /\.workspace/);

    await api.ok('/api/auth/register', { method: 'POST', json: { username: 'diska', password: PASSWORD } });
    const alice = await api.login('diska');
    await api.ok('/api/auth/register', { method: 'POST', json: { username: 'diskb', password: PASSWORD } });
    const bob = await api.login('diskb');
    assert.equal((await api.call('/api/disk/files')).status, 401);

    const data = crypto.randomBytes(7 * 1024 * 1024 + 123);
    const hash = digest(data);
    const initialized = await api.ok('/api/disk/uploads/init', {
      method: 'POST', cookie: alice.cookie,
      json: { name: '合成大文件.bin', size: data.length, sha256: hash, mimeType: 'application/octet-stream' }
    });
    const { uploadId, chunkSize } = initialized;
    assert.equal(chunkSize, 5 * 1024 * 1024);
    assert.equal(initialized.totalChunks, 2);
    for (let index = 0, offset = 0; offset < data.length; index += 1, offset += chunkSize) {
      const end = Math.min(offset + chunkSize, data.length);
      await api.ok(`/api/disk/uploads/${uploadId}/chunks/${index}/data`, {
        method: 'PUT', cookie: alice.cookie, body: data.subarray(offset, end),
        headers: { 'content-type': 'application/octet-stream' }
      });
    }
    const uploadState = await api.ok(`/api/disk/uploads/${uploadId}`, { cookie: alice.cookie });
    assert.equal(uploadState.upload.receivedBytes, data.length);
    const completed = await api.ok(`/api/disk/uploads/${uploadId}/complete`, { method: 'POST', cookie: alice.cookie, json: {} });
    const file = completed.file;
    assert.equal(file.size, data.length);
    assert.equal(file.revision, 1);
    assert.equal(completed.sha256, `sha256:${hash}`);

    const listed = await api.ok('/api/disk/files', { cookie: alice.cookie });
    assert.equal(listed.files.length, 1);
    assert.equal(listed.quota.usedBytes, data.length);
    const regions = await api.ok('/api/disk/regions', { cookie: alice.cookie });
    assert.equal(regions.defaultRegion, 'disk.user-files');
    assert.equal(regions.regions.length, 1);

    const full = await api.ok(`/api/disk/files/${file.fileId}/content`, { cookie: alice.cookie });
    assert.equal(full.length, data.length);
    assert.equal(digest(full), hash);
    const ranged = await api.call(`/api/disk/files/${file.fileId}/content`, {
      cookie: alice.cookie, headers: { range: 'bytes=1000-2023' }
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes 1000-2023/${data.length}`);
    assert.deepEqual(ranged.body, data.subarray(1000, 2024));
    assert.equal((await api.call(`/api/disk/files/${file.fileId}/content`, { headers: { range: `bytes=${data.length}-` }, cookie: alice.cookie })).status, 416);
    assert.equal((await api.call(`/api/disk/files/${file.fileId}`, { cookie: bob.cookie })).status, 403);
    assert.equal((await api.call(`/api/disk/files/${file.fileId}/content`, { cookie: bob.cookie })).status, 403);

    const next = Buffer.from('revision two via clean install');
    const second = await api.ok('/api/disk/uploads/init', {
      method: 'POST', cookie: alice.cookie,
      json: { name: file.name, size: next.length, sha256: digest(next), mimeType: 'application/octet-stream', fileId: file.fileId, baseRevision: 1 }
    });
    await api.ok(`/api/disk/uploads/${second.uploadId}/chunks/0/data`, {
      method: 'PUT', cookie: alice.cookie, body: next, headers: { 'content-type': 'application/octet-stream' }
    });
    const updated = await api.ok(`/api/disk/uploads/${second.uploadId}/complete`, { method: 'POST', cookie: alice.cookie, json: {} });
    assert.equal(updated.file.revision, 2);
    const stale = await api.call('/api/disk/uploads/init', {
      method: 'POST', cookie: alice.cookie,
      json: { name: file.name, size: next.length, sha256: digest(next), mimeType: 'application/octet-stream', fileId: file.fileId, baseRevision: 1 }
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'REVISION_CONFLICT');
    assert.equal((await api.ok(`/api/disk/files/${file.fileId}/content`, { cookie: alice.cookie })).toString(), next.toString());

    const share = await api.ok(`/api/disk/files/${file.fileId}/shares`, { method: 'POST', cookie: alice.cookie, json: { expiresInSeconds: 120 } });
    assert.match(share.token, /^[A-Za-z0-9_-]{40,}$/);
    const publicMeta = await api.ok(`/api/disk/shares/${share.token}`);
    assert.equal(publicMeta.fileId, file.fileId);
    const publicContent = await api.ok(`/api/disk/shares/${share.token}/content`);
    assert.equal(publicContent.toString(), next.toString());
    assert.equal((await api.call(`/api/disk/shares/${share.token}/content`, { headers: { range: 'bytes=0-7' } })).status, 206);
    const publicList = await api.call('/api/disk/files');
    assert.equal(publicList.status, 401);

    const deleted = await api.ok(`/api/disk/files/${file.fileId}`, { method: 'DELETE', cookie: alice.cookie });
    assert.equal(deleted.status, 'deleted');
    assert.equal((await api.call(`/api/disk/shares/${share.token}`)).status, 410);
    const quotaAfterDelete = await api.ok('/api/disk/quota', { cookie: alice.cookie });
    assert.equal(quotaAfterDelete.usedBytes, next.length, '覆盖后只计当前修订；软删不移除逻辑字节');
    await api.ok(`/api/disk/files/${file.fileId}/restore`, { method: 'POST', cookie: alice.cookie, json: {} });
    assert.equal((await api.call(`/api/disk/shares/${share.token}`)).status, 200);

    await api.ok(`/api/disk/shares/${share.shareId}`, { method: 'DELETE', cookie: alice.cookie });
    const revoked = await api.call(`/api/disk/shares/${share.token}`);
    assert.equal(revoked.status, 410);
    assert.equal(revoked.body.code, 'SHARE_REVOKED');

    // 重启后同一 Cookie 仍有效，文件与修订仍在原区域。
    const contentRoot = path.join(installation.config.storage['storage.disk.root']);
    assert.equal(fs.existsSync(contentRoot), true);
    const before = fs.readdirSync(contentRoot, { recursive: true }).filter((entry) => String(entry).endsWith('.bin') || String(entry).includes(file.fileId));
    assert.ok(before.length > 0, '内容必须落在声明的区域根下');

    await runtime.app.close();
    runtime = null;
    const restarted = await startRuntime({ configPath: installation.configPath, env, port: 0 });
    runtime = restarted;
    base = restarted.url;
    api = client(base);
    const after = await api.ok(`/api/disk/files/${file.fileId}/content`, { cookie: alice.cookie });
    assert.equal(after.toString(), next.toString());
    const afterList = await api.ok('/api/disk/files', { cookie: alice.cookie });
    // 修订序列：覆盖 1→2、软删 →3、恢复 →4；重启后必须仍是同一修订。
    assert.equal(afterList.files[0].revision, 4);
    assert.equal(afterList.quota.reservedBytes, 0);
  } finally {
    if (runtime) await runtime.app.close().catch(() => {});
    await stopMongo(mongo);
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
});
