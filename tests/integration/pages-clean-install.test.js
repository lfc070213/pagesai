'use strict';
// C10-C13：仓库外临时干净安装 + 真实 MongoDB + 真实 HTTP/SSE/子进程。
// 不读取生产配置或生产 env；本地协议桩和 deterministic-test 都不是外部模型验收。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');

const exec = promisify(execFile);
const ENABLED = process.env.PAGESAI_MONGO_TEST === '1';
const sourceRoot = path.join(__dirname, '..', '..');
const PASSWORD = 'pages-e2e-password';

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
    '--replSet', 'pagesai-clean-e2e', '--storageEngine', 'wiredTiger', '--nounixsocket', '--quiet'
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
    _id: 'pagesai-clean-e2e', members: [{ _id: 0, host: `127.0.0.1:${port}` }],
    settings: { electionTimeoutMillis: 500, heartbeatIntervalMillis: 100 }
  } });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await admin.command({ hello: 1 })).isWritablePrimary) break;
    if (attempt === 199) throw new Error('mongod 未成为 Primary');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await setup.close();
  const uri = `mongodb://127.0.0.1:${port}/?replicaSet=pagesai-clean-e2e&directConnection=true`;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  return { child, client, uri };
}

async function stopMongo(mongo) {
  if (!mongo) return;
  await mongo.client.close().catch(() => {});
  if (mongo.child.exitCode === null && mongo.child.signalCode === null) {
    mongo.child.kill('SIGTERM');
    await Promise.race([once(mongo.child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
  if (mongo.child.exitCode === null && mongo.child.signalCode === null) mongo.child.kill('SIGKILL');
}

async function cleanInstall(root) {
  const installRoot = path.join(root, 'clean-install');
  const dataRoot = path.join(root, 'clean-data');
  await fs.promises.mkdir(installRoot, { recursive: true });
  for (const directory of ['core', 'config', 'contracts']) {
    await fs.promises.cp(path.join(sourceRoot, directory), path.join(installRoot, directory), { recursive: true });
  }
  await fs.promises.mkdir(path.join(installRoot, 'modules', 'pages'), { recursive: true });
  for (const entry of ['manifest.json', 'config.schema.json', 'server', 'worker', 'web']) {
    await fs.promises.cp(path.join(sourceRoot, 'modules', 'pages', entry), path.join(installRoot, 'modules', 'pages', entry), { recursive: true });
  }
  await fs.promises.mkdir(path.join(installRoot, 'tools'), { recursive: true });
  await fs.promises.copyFile(path.join(sourceRoot, 'tools', 'init.js'), path.join(installRoot, 'tools', 'init.js'));
  await fs.promises.copyFile(path.join(sourceRoot, 'package.json'), path.join(installRoot, 'package.json'));
  const configPath = path.join(installRoot, 'config.json');
  await exec(process.execPath, [
    'tools/init.js', '--data-root', dataRoot, '--modules', 'pages', '--install-root', installRoot,
    '--config', configPath, '--json'
  ], { cwd: installRoot, env: { PATH: process.env.PATH || '/usr/bin:/bin' } });
  const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
  config.moduleConfig = { pages: {
    allowTestModel: true, taskTimeoutMs: 1500, maxConcurrentTasks: 1,
    workerMemoryMB: 64, backendMemoryMB: 64, backendStartTimeoutMs: 5000
  } };
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
    assert.ok(result.status >= 200 && result.status < 300, `${options && options.method || 'GET'} ${route}: ${result.status} ${result.body}`);
    return result.body;
  }
  async function login(username) {
    const response = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD })
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';', 1)[0];
    return { cookie, body: await response.json() };
  }
  return { call, ok, login };
}

async function readSse(base, route, cookie) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('SSE 读取超时')), 15000);
  try {
    const response = await fetch(base + route, { headers: { cookie }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    const decoder = new TextDecoder(); let buffer = ''; const events = [];
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop();
      for (const frame of frames) {
        if (!frame || frame.startsWith(':')) continue;
        const event = { id: null, event: 'message', data: '' };
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('id:')) event.id = line.slice(3).trim();
          else if (line.startsWith('event:')) event.event = line.slice(6).trim();
          else if (line.startsWith('data:')) event.data += `${line.slice(5).trimStart()}\n`;
        }
        event.data = event.data.replace(/\n$/, '');
        events.push(event);
      }
    }
    return events;
  } finally { clearTimeout(timer); }
}

async function waitTask(api, id, cookie, expected = null) {
  let latest = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const body = await api.ok(`/api/pages/tasks/${id}`, { cookie });
    latest = body.task;
    const terminal = ['succeeded', 'failed', 'cancelled'].includes(body.task.status);
    if ((expected && body.task.status === expected) || (!expected && terminal) || (expected && terminal)) return body.task;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`任务未进入预期状态：${id} expected=${expected} latest=${JSON.stringify(latest)}`);
}

async function protocolStub() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ authorization: req.headers.authorization, input });
    if (input.model === 'fail') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"local stub failure"}'); return; }
    if (input.model === 'hang') return;
    const result = JSON.stringify({ files: { 'index.html': '<!doctype html><title>Protocol stub</title><h1>LOCAL_PROTOCOL_STUB</h1>' }, summary: '本地协议桩响应' });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: result } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, url: `http://127.0.0.1:${server.address().port}/v1` };
}

const BACKEND_SOURCE = `const http = require('node:http');
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: true, method: req.method, path: req.url, body: Buffer.concat(chunks).toString('utf8'),
    tenant: req.headers['x-pages-tenant-id'], cookie: req.headers.cookie || null,
    authorization: req.headers.authorization || null, database: process.env.DATABASE_URL.split('/').pop().split('?')[0] }));
});
server.listen(Number(process.env.PORT), '127.0.0.1');`;

test('C10-C13 干净安装、控制台资源、Mongo 持久任务/SSE、发布恢复与租户后端真实 HTTP E2E', {
  skip: ENABLED ? false : '设置 PAGESAI_MONGO_TEST=1，使用仓库外 /tmp/pagesai-mongo-build 依赖运行',
  timeout: 240000
}, async (t) => {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pagesai-clean-e2e-'));
  let mongo; let runtime; let stub;
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin', PAGESAI_ALLOW_TEST_MODEL: '1',
    PAGESAI_E2E_MODEL_KEY: 'local-protocol-key'
  };
  try {
    mongo = await startMongo(temporary);
    const installation = await cleanInstall(temporary);
    env.PAGESAI_MONGO_URL = mongo.uri;
    const { startRuntime } = require(path.join(installation.installRoot, 'core', 'runtime.js'));
    runtime = await startRuntime({ configPath: installation.configPath, env, port: 0 });
    let base = runtime.url; let api = client(base);
    stub = await protocolStub();

    const html = await api.ok('/', {});
    assert.match(html.toString(), /id="authView"/);
    assert.match(html.toString(), /src="\/pages-console.js"/);
    const script = await api.ok('/pages-console.js', {});
    assert.match(script.toString(), /EventSource/);
    assert.match(script.toString(), /\/api\/auth\/login/);
    assert.doesNotMatch(script.toString(), /x-pages-user-id|x-pagesai-user/);
    assert.match((await api.ok('/pages-console.css', {})).toString(), /\.workspace/);

    await api.ok('/api/admin/bootstrap', { method: 'POST', json: { username: 'e2eadmin', password: PASSWORD } });
    const admin = await api.login('e2eadmin');
    await api.ok('/api/auth/register', { method: 'POST', json: { username: 'e2euser', password: PASSWORD } });
    const user = await api.login('e2euser');
    await api.ok('/api/auth/register', { method: 'POST', json: { username: 'otheruser', password: PASSWORD } });
    const other = await api.login('otheruser');

    const forbidden = await api.call('/api/pages/admin/models/local-test', { method: 'PUT', cookie: user.cookie, json: { kind: 'deterministic-test', enabled: true } });
    assert.equal(forbidden.status, 403);
    await api.ok('/api/pages/admin/models/local-test', { method: 'PUT', cookie: admin.cookie, json: { kind: 'deterministic-test', enabled: true } });
    const badReference = await api.call('/api/pages/admin/models/bad-ref', { method: 'PUT', cookie: admin.cookie, json: { kind: 'openai-compatible', baseUrl: stub.url, model: 'success', keyRef: 'literal-secret', enabled: true } });
    assert.equal(badReference.status, 400);

    const created = await api.ok('/api/pages/sites', { method: 'POST', cookie: user.cookie, json: { name: '干净安装验收站点' } });
    const siteId = created.site.id;
    assert.equal((await api.call(`/api/pages/sites/${siteId}`, { cookie: other.cookie })).status, 403);
    const material = Buffer.from('material-e2e: 无外部资源');
    const materialName = 'notes.txt';
    await api.ok(`/api/pages/sites/${siteId}/materials/${materialName}`, {
      method: 'PUT', cookie: user.cookie, body: material,
      headers: { 'content-type': 'application/octet-stream', 'x-file-size': String(material.length), 'x-file-sha256': crypto.createHash('sha256').update(material).digest('hex') }
    });
    assert.equal((await api.call(`/api/pages/sites/${siteId}/materials/${materialName}`, { cookie: other.cookie })).status, 403);

    const started = await api.ok(`/api/pages/sites/${siteId}/ai`, { method: 'POST', cookie: user.cookie, json: { modelId: 'local-test', prompt: '创建离线验收页面', materials: [materialName] } });
    assert.match(started.note, /仅测试/);
    const taskId = started.task.id;
    const events = await readSse(base, `/api/pages/tasks/${taskId}/events`, user.cookie);
    assert.ok(events.some((event) => event.event === 'reasoning'));
    assert.ok(events.some((event) => event.event === 'done' && JSON.parse(event.data).status === 'succeeded'));
    assert.equal(events.at(-1).event, 'end');
    const replay = await readSse(base, `/api/pages/tasks/${taskId}/events?after=0`, user.cookie);
    assert.ok(replay.some((event) => event.event === 'done'));
    const succeeded = await waitTask(api, taskId, user.cookie, 'succeeded');
    assert.equal(succeeded.result.requiresPublish, true);
    const artifact = await api.ok(`/api/pages/tasks/${taskId}/artifact`, { cookie: user.cookie });
    assert.equal(artifact.taskId, taskId);
    assert.equal((await api.call(`/api/pages/tasks/${taskId}`, { cookie: other.cookie })).status, 403);

    let detail = await api.ok(`/api/pages/sites/${siteId}`, { cookie: user.cookie });
    const previewPath = detail.site.previewPath;
    const preview = await api.call(previewPath);
    assert.equal(preview.status, 200);
    assert.match(preview.body.toString(), /创建离线验收页面/);
    assert.match(preview.headers.get('content-security-policy'), /^sandbox allow-scripts/);
    assert.equal((await api.call(`/api/pages/public/${detail.site.slug}/`)).status, 404);
    const traversal = await api.call(`/api/pages/sites/${siteId}/files/%252e%252e%252fsecret.txt`, { method: 'PUT', cookie: user.cookie, json: { content: 'no' } });
    assert.equal(traversal.status, 400);

    const published1 = await api.ok(`/api/pages/sites/${siteId}/publish`, { method: 'POST', cookie: user.cookie });
    assert.equal(published1.version, 1);
    const publicPath = published1.publicPath;
    assert.match((await api.call(publicPath)).body.toString(), /创建离线验收页面/);
    await api.ok(`/api/pages/sites/${siteId}/files/index.html`, { method: 'PUT', cookie: user.cookie, json: { content: '<!doctype html><title>v2</title><h1>VERSION_TWO</h1>' } });
    assert.match((await api.call(previewPath)).body.toString(), /VERSION_TWO/);
    assert.doesNotMatch((await api.call(publicPath)).body.toString(), /VERSION_TWO/);
    await api.ok(`/api/pages/sites/${siteId}/publish`, { method: 'POST', cookie: user.cookie });
    assert.match((await api.call(publicPath)).body.toString(), /VERSION_TWO/);
    await api.ok(`/api/pages/sites/${siteId}/files/index.html`, { method: 'PUT', cookie: user.cookie, json: { content: '<!doctype html><h1>UNPUBLISHED_THREE</h1>' } });
    assert.match((await api.call(previewPath)).body.toString(), /UNPUBLISHED_THREE/);
    assert.doesNotMatch((await api.call(publicPath)).body.toString(), /UNPUBLISHED_THREE/);
    await api.ok(`/api/pages/sites/${siteId}/rollback`, { method: 'POST', cookie: user.cookie, json: { version: 1 } });
    assert.match((await api.call(publicPath)).body.toString(), /创建离线验收页面/);
    assert.match((await api.call(previewPath)).body.toString(), /创建离线验收页面/);

    await api.ok('/api/pages/admin/models/protocol-stub', { method: 'PUT', cookie: admin.cookie, json: {
      kind: 'openai-compatible', baseUrl: stub.url, model: 'success', keyRef: 'env:PAGESAI_E2E_MODEL_KEY', enabled: true
    } });
    const protocol = await api.ok(`/api/pages/sites/${siteId}/ai`, { method: 'POST', cookie: user.cookie, json: { modelId: 'protocol-stub', prompt: '协议适配器本地桩测试' } });
    const protocolResult = await waitTask(api, protocol.task.id, user.cookie, 'succeeded');
    assert.equal(protocolResult.status, 'succeeded', JSON.stringify(protocolResult.error));
    assert.equal(protocolResult.result.testModel, false);
    assert.ok(stub.requests.some((request) => request.authorization === 'Bearer local-protocol-key'));
    assert.match((await api.ok(`/api/pages/sites/${siteId}/files/index.html`, { cookie: user.cookie })).file.content, /LOCAL_PROTOCOL_STUB/);

    for (const [modelName, expected, code] of [['fail', 'failed', 'OPENAI_HTTP_500'], ['hang', 'cancelled', 'TASK_TIMEOUT']]) {
      await api.ok('/api/pages/admin/models/protocol-stub', { method: 'PUT', cookie: admin.cookie, json: { kind: 'openai-compatible', baseUrl: stub.url, model: modelName, keyRef: 'env:PAGESAI_E2E_MODEL_KEY', enabled: true } });
      const task = await api.ok(`/api/pages/sites/${siteId}/ai`, { method: 'POST', cookie: user.cookie, json: { modelId: 'protocol-stub', prompt: `${modelName} 显式失败测试` } });
      const terminal = await waitTask(api, task.task.id, user.cookie, expected);
      assert.equal(terminal.error.code, code);
    }
    await api.ok('/api/pages/admin/models/protocol-stub', { method: 'PUT', cookie: admin.cookie, json: { kind: 'openai-compatible', baseUrl: stub.url, model: 'hang', keyRef: 'env:PAGESAI_E2E_MODEL_KEY', enabled: true } });
    const cancelling = await api.ok(`/api/pages/sites/${siteId}/ai`, { method: 'POST', cookie: user.cookie, json: { modelId: 'protocol-stub', prompt: '用户停止测试' } });
    await waitTask(api, cancelling.task.id, user.cookie, 'running');
    await api.ok(`/api/pages/tasks/${cancelling.task.id}/cancel`, { method: 'POST', cookie: user.cookie });
    assert.equal((await waitTask(api, cancelling.task.id, user.cookie, 'cancelled')).error.code, 'USER_CANCELLED');

    const backend = await api.ok(`/api/pages/sites/${siteId}/backend`, { method: 'POST', cookie: user.cookie, json: { source: BACKEND_SOURCE } });
    assert.equal(backend.backend.status, 'running');
    const tenantRoute = backend.backend.routePath;
    assert.notEqual(backend.backend.databaseName, installation.config.database.name);
    assert.equal((await api.call(`/api/pages/sites/${siteId}`, { method: 'DELETE', cookie: user.cookie })).status, 409);
    const tenant = await api.call(`${tenantRoute}echo?x=1`, {
      method: 'POST', cookie: user.cookie,
      headers: { authorization: 'Bearer must-not-forward', 'x-pages-tenant-id': 'forged', 'content-type': 'application/json' },
      body: JSON.stringify({ proxied: true })
    });
    assert.equal(tenant.status, 200);
    assert.equal(tenant.body.body, '{"proxied":true}');
    assert.equal(tenant.body.tenant, siteId);
    assert.equal(tenant.body.cookie, null);
    assert.equal(tenant.body.authorization, null);
    assert.equal(tenant.body.database, backend.backend.databaseName);
    await api.ok(`/api/pages/sites/${siteId}/backend/stop`, { method: 'POST', cookie: user.cookie });
    assert.equal((await api.call(tenantRoute)).status, 503);
    await api.ok(`/api/pages/sites/${siteId}/backend/start`, { method: 'POST', cookie: user.cookie });
    assert.equal((await api.call(tenantRoute)).status, 200);

    const hanging = await api.ok(`/api/pages/sites/${siteId}/ai`, { method: 'POST', cookie: user.cookie, json: { modelId: 'protocol-stub', prompt: '重启取消运行任务' } });
    await waitTask(api, hanging.task.id, user.cookie, 'running');
    const queued = await api.ok(`/api/pages/sites/${siteId}/ai`, { method: 'POST', cookie: user.cookie, json: { modelId: 'local-test', prompt: '重启后恢复持久队列' } });
    assert.equal(queued.task.status, 'queued');
    await runtime.app.close(); runtime = null;
    runtime = await startRuntime({ configPath: installation.configPath, env, port: 0 });
    base = runtime.url; api = client(base);
    const userAfterRestart = await api.login('e2euser');
    const recovered = await waitTask(api, queued.task.id, userAfterRestart.cookie, 'succeeded');
    assert.equal(recovered.result.testModel, true);
    const interrupted = await api.ok(`/api/pages/tasks/${hanging.task.id}`, { cookie: userAfterRestart.cookie });
    assert.equal(interrupted.task.status, 'cancelled');
    assert.equal(interrupted.task.error.code, 'SERVICE_STOPPED');
    assert.equal((await api.call(publicPath)).status, 200);
    assert.equal((await api.call(tenantRoute)).status, 200, 'desiredStatus=running 的后端必须跨重启恢复');
    const persistedBackend = await api.ok(`/api/pages/sites/${siteId}/backend`, { cookie: userAfterRestart.cookie });
    assert.equal(persistedBackend.backend.databaseName, backend.backend.databaseName);

    const modelDocument = await mongo.client.db(installation.config.database.name).collection('pages_models').findOne({ _id: 'protocol-stub' });
    assert.equal(modelDocument.keyRef, 'env:PAGESAI_E2E_MODEL_KEY');
    assert.equal(JSON.stringify(modelDocument).includes('local-protocol-key'), false);
    const taskDocument = await mongo.client.db(installation.config.database.name).collection('pages_tasks').findOne({ _id: protocol.task.id });
    assert.equal(JSON.stringify(taskDocument).includes('local-protocol-key'), false);
    const regions = await mongo.client.db(installation.config.database.name).collection('storage_regions').find({}).toArray();
    for (const id of ['pages.sites', 'pages.materials', 'pages.ai-workspace', 'pages.backends']) {
      assert.ok(regions.some((region) => region.regionId === id || region._id === id), `缺少区域 ${id}`);
    }
    t.diagnostic('仅验证本地 deterministic-test 与本地 OpenAI 协议桩；未访问外部模型，未执行真实浏览器自动化。');
  } finally {
    if (runtime) await runtime.app.close().catch(() => {});
    if (stub) await new Promise((resolve) => stub.server.close(resolve));
    await stopMongo(mongo);
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
});
