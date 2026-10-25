'use strict';
// C28：仓库外临时干净安装（核心 + Paper），真实 MongoDB、真实 HTTP 与网页。
// 翻译/问答/检索全部指向本机回环假适配器；不读取生产配置，不连接生产模型或数据库。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');

const exec = promisify(execFile);
const ENABLED = process.env.PAGESAI_MONGO_TEST === '1';
const sourceRoot = path.join(__dirname, '..', '..');
const PASSWORD = 'paper-e2e-password';
const { buildPdf } = require(path.join(sourceRoot, 'modules', 'paper', 'tests', 'helpers.js'));

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
    '--replSet', 'pagesai-paper-e2e', '--storageEngine', 'wiredTiger', '--nounixsocket', '--quiet'
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
    _id: 'pagesai-paper-e2e', members: [{ _id: 0, host: `127.0.0.1:${port}` }],
    settings: { electionTimeoutMillis: 500, heartbeatIntervalMillis: 100 }
  } });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await admin.command({ hello: 1 })).isWritablePrimary) break;
    if (attempt === 199) throw new Error('mongod 未成为 Primary');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await setup.close();
  const uri = `mongodb://127.0.0.1:${port}/?replicaSet=pagesai-paper-e2e&directConnection=true`;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  return { child, client, uri };
}

async function stopMongo(mongo) {
  if (!mongo) return;
  await Promise.race([
    mongo.client.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (mongo.child.exitCode === null && mongo.child.signalCode === null && !mongo.child.killed) {
    mongo.child.kill('SIGTERM');
    await Promise.race([once(mongo.child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
  if (mongo.child.exitCode === null && mongo.child.signalCode === null) mongo.child.kill('SIGKILL');
  mongo.child.stdout?.destroy();
  mongo.child.stderr?.destroy();
  mongo.child.unref?.();
}

// 本机回环假适配器：只验证协议形状与状态机，不代表任何真实模型质量。
async function startAdapters() {
  const state = { delayMs: 0, translateCalls: [], askCalls: [], searchCalls: [], authorizations: [] };
  const server = http.createServer(async (req, res) => {
    const json = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    let raw = '';
    try {
      for await (const chunk of req) raw += chunk;
    } catch {
      return undefined;
    }
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
    state.authorizations.push(String(req.headers.authorization || ''));
    if (req.url === '/translate') {
      state.translateCalls.push(body);
      if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      const segments = Array.isArray(body.segments) ? body.segments : [];
      return json(200, { translations: segments.map((item) => `译：${item.text}`) });
    }
    if (req.url === '/ask') {
      state.askCalls.push(body);
      const segments = Array.isArray(body.segments) ? body.segments : [];
      return json(200, {
        answer: `答案：${body.question}`,
        // 第二个引用不存在，必须被服务端丢弃而不是伪造。
        citations: [segments[0] ? segments[0].sid : '0:0', '99:99']
      });
    }
    if (req.url === '/search') {
      state.searchCalls.push(body);
      const segments = Array.isArray(body.segments) ? body.segments : [];
      const last = segments[segments.length - 1];
      return json(200, { results: last ? [{ sid: last.sid }] : [] });
    }
    return json(404, { error: 'unknown adapter route' });
  });
  server.on('clientError', (err, socket) => socket.destroy());
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    base,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function cleanInstall(root, adapterBase) {
  const installRoot = path.join(root, 'clean-install');
  const dataRoot = path.join(root, 'clean-data');
  await fs.promises.mkdir(installRoot, { recursive: true });
  for (const directory of ['core', 'config', 'contracts']) {
    await fs.promises.cp(path.join(sourceRoot, directory), path.join(installRoot, directory), { recursive: true });
  }
  await fs.promises.mkdir(path.join(installRoot, 'modules', 'paper'), { recursive: true });
  for (const entry of ['manifest.json', 'config.schema.json', 'server', 'web']) {
    await fs.promises.cp(path.join(sourceRoot, 'modules', 'paper', entry), path.join(installRoot, 'modules', 'paper', entry), { recursive: true });
  }
  await fs.promises.mkdir(path.join(installRoot, 'tools'), { recursive: true });
  await fs.promises.copyFile(path.join(sourceRoot, 'tools', 'init.js'), path.join(installRoot, 'tools', 'init.js'));
  await fs.promises.copyFile(path.join(sourceRoot, 'package.json'), path.join(installRoot, 'package.json'));
  const configPath = path.join(installRoot, 'config.json');
  await exec(process.execPath, [
    'tools/init.js', '--data-root', dataRoot, '--modules', 'paper', '--install-root', installRoot,
    '--config', configPath, '--json'
  ], { cwd: installRoot, env: { PATH: process.env.PATH || '/usr/bin:/bin' } });
  const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
  const paperRoot = path.join(dataRoot, 'paper');
  await fs.promises.mkdir(paperRoot, { recursive: true });
  config.moduleConfig = { paper: {
    dataFile: path.join(paperRoot, 'store.json'),
    uploadsDir: path.join(paperRoot, 'uploads'),
    translateBatchSize: 1,
    translateAdapter: { endpoint: `${adapterBase}/translate`, apiKey: 'paper-test-key', model: 'fake-translate', timeoutMs: 10000 },
    qaAdapter: { endpoint: `${adapterBase}/ask`, apiKey: 'paper-test-key', model: 'fake-qa', timeoutMs: 10000 },
    searchAdapter: { endpoint: `${adapterBase}/search`, apiKey: 'paper-test-key', timeoutMs: 10000 }
  } };
  await fs.promises.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { installRoot, dataRoot, configPath, config };
}

function client(base) {
  async function call(route, { method = 'GET', cookie, json, body, headers = {} } = {}) {
    const requestHeaders = { connection: 'close', ...headers };
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
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ username, password: PASSWORD })
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return { cookie: response.headers.get('set-cookie').split(';', 1)[0], body: JSON.parse(text) };
  }
  return { call, ok, login };
}

// 先断开所有 keep-alive 连接再关闭运行时，避免测试失败时 finally 卡住。
async function shutdown(rt) {
  if (!rt) return;
  try { rt.app.server.closeAllConnections?.(); } catch {}
  await Promise.race([rt.app.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5000))]);
}

async function waitFor(check, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待超时：${label}`);
}

const TEXT_DOC = 'Retrieval augments reading. Alignment keeps sentences paired. Evaluation is reproducible.';

test('Paper 单装：网页、上传、原件、翻译、问答、停止恢复与重启持久化', {
  skip: ENABLED ? false : '设置 PAGESAI_MONGO_TEST=1，使用仓库外 /tmp/pagesai-mongo-build 依赖运行',
  timeout: 300000
}, async () => {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pagesai-paper-clean-'));
  let mongo; let runtime; let adapters;
  try {
    mongo = await startMongo(temporary);
    adapters = await startAdapters();
    const installation = await cleanInstall(temporary, adapters.base);
    const env = { PATH: process.env.PATH || '/usr/bin:/bin', PAGESAI_MONGO_URL: mongo.uri };
    const { startRuntime } = require(path.join(installation.installRoot, 'core', 'runtime.js'));
    runtime = await startRuntime({ configPath: installation.configPath, env, port: 0 });
    let api = client(runtime.url);

    // 网页静态资源、CSP 与同源约束
    const html = (await api.ok('/paper')).toString();
    assert.match(html, /id="doc-list"/);
    assert.match(html, /src="\/paper-app.js"/);
    assert.match(html, /href="\/paper-app.css"/);
    assert.match(html, /id="ask-form"/);
    const page = await api.call('/paper');
    const csp = page.headers.get('content-security-policy') || '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.match((await api.ok('/paper/')).toString(), /id="reader"/);
    const script = (await api.ok('/paper-app.js')).toString();
    assert.match(script, /\/api\/paper\/docs/);
    assert.match(script, /#doc\//);
    assert.match(script, /inline=1/);
    assert.doesNotMatch(script, /x-dev-user/);
    assert.match((await api.ok('/paper-app.css')).toString(), /\.reader/);

    await api.ok('/api/auth/register', { method: 'POST', json: { username: 'paper_a', password: PASSWORD } });
    const alice = await api.login('paper_a');
    await api.ok('/api/auth/register', { method: 'POST', json: { username: 'paper_b', password: PASSWORD } });
    const bob = await api.login('paper_b');

    // 未登录不得读、写、下载
    assert.equal((await api.call('/api/paper/docs')).status, 403);
    const anonymousFile = await api.call('/api/paper/docs/whatever/file');
    assert.equal(anonymousFile.status, 403);

    // 原始流上传纯文本
    const textUpload = await api.call('/api/paper/docs/upload?filename=reading.txt', {
      method: 'POST', cookie: alice.cookie, body: TEXT_DOC,
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
    assert.equal(textUpload.status, 201, JSON.stringify(textUpload.body));
    const textDoc = textUpload.body.doc;
    assert.equal(textDoc.fileAvailable, true);
    assert.equal(textDoc.kind, 'text');
    assert.ok(textDoc.segmentCount >= 3);

    // JSON Base64 上传 PDF
    const pdf = buildPdf('PDF layer sentence one. PDF layer sentence two.');
    const pdfUpload = await api.ok('/api/paper/docs', {
      method: 'POST', cookie: alice.cookie,
      json: { filename: 'paper.pdf', contentBase64: pdf.toString('base64') }
    });
    const pdfDoc = pdfUpload.doc;
    assert.equal(pdfDoc.mime, 'application/pdf');
    assert.equal(pdfDoc.fileAvailable, true);
    assert.ok(pdfDoc.pageCount >= 1);

    // 跨用户隔离
    assert.equal((await api.call(`/api/paper/docs/${textDoc.id}`, { cookie: bob.cookie })).status, 403);
    assert.equal((await api.call(`/api/paper/docs/${textDoc.id}`, { method: 'DELETE', cookie: bob.cookie })).status, 403);
    assert.equal((await api.call(`/api/paper/docs/${textDoc.id}/translate`, { method: 'POST', cookie: bob.cookie, json: {} })).status, 403);
    assert.equal((await api.call(`/api/paper/docs/${textDoc.id}/ask`, { method: 'POST', cookie: bob.cookie, json: { question: '讲什么' } })).status, 403);
    assert.equal((await api.call(`/api/paper/docs/${textDoc.id}/file`, { cookie: bob.cookie })).status, 403);
    assert.equal((await api.ok('/api/paper/docs', { cookie: bob.cookie })).docs.length, 0);
    assert.equal((await api.ok('/api/paper/docs', { cookie: alice.cookie })).docs.length, 2);

    // 原件：attachment / inline / HEAD / Range 全部由同一份落盘字节提供
    const original = await api.call(`/api/paper/docs/${textDoc.id}/file`, { cookie: alice.cookie });
    assert.equal(original.status, 200);
    assert.match(original.headers.get('content-disposition') || '', /^attachment/);
    assert.match(original.headers.get('accept-ranges') || '', /bytes/);
    assert.equal(original.body.toString('utf8'), TEXT_DOC);

    const inline = await api.call(`/api/paper/docs/${pdfDoc.id}/file?inline=1`, { cookie: alice.cookie });
    assert.equal(inline.status, 200);
    assert.match(inline.headers.get('content-disposition') || '', /^inline/);
    assert.deepEqual(inline.body, pdf);

    const head = await api.call(`/api/paper/docs/${pdfDoc.id}/file`, { method: 'HEAD', cookie: alice.cookie });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), pdf.length);
    assert.equal(head.body.length, 0);

    const ranged = await fetch(`${runtime.url}/api/paper/docs/${textDoc.id}/file`, {
      headers: { cookie: alice.cookie, range: 'bytes=0-9', connection: 'close' }
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes 0-9/${Buffer.byteLength(TEXT_DOC)}`);
    assert.equal(Buffer.from(await ranged.arrayBuffer()).toString('utf8'), TEXT_DOC.slice(0, 10));

    // 翻译：逐批调用回环适配器，结果按 sid 持久化
    const translated = await api.ok(`/api/paper/docs/${textDoc.id}/translate`, {
      method: 'POST', cookie: alice.cookie, json: { targetLang: 'zh' }
    });
    assert.equal(translated.job.status, 'done');
    assert.equal(translated.job.progress, 1);
    assert.equal(translated.job.total, textDoc.segmentCount);
    const translationState = await api.ok(`/api/paper/docs/${textDoc.id}/translate?targetLang=zh&include=text`, { cookie: alice.cookie });
    assert.equal(translationState.job.status, 'done');
    const fullDoc = await api.ok(`/api/paper/docs/${textDoc.id}`, { cookie: alice.cookie });
    const sids = fullDoc.doc.blocks.flatMap((block) => block.segments.map((segment) => segment.sid));
    assert.equal(Object.keys(translationState.translations).length, sids.length);
    for (const sid of sids) assert.match(translationState.translations[sid], /^译：/);
    assert.equal(adapters.state.translateCalls.length, sids.length);
    for (const call of adapters.state.translateCalls) {
      assert.equal(call.targetLang, 'zh');
      assert.equal(call.model, 'fake-translate');
    }
    assert.ok(adapters.state.authorizations.every((value) => value === 'Bearer paper-test-key'));

    // 问答：检索适配器命中末句，非法引用被丢弃
    const answer = await api.ok(`/api/paper/docs/${textDoc.id}/ask`, {
      method: 'POST', cookie: alice.cookie, json: { question: '这篇论文讲了什么？', topK: 3 }
    });
    assert.match(answer.answer, /^答案：/);
    assert.equal(answer.search.source, 'adapter');
    assert.equal(answer.search.configured, true);
    assert.equal(answer.degraded, null);
    assert.equal(answer.citations.length, 1);
    assert.equal(answer.citationsIgnored, 1);
    assert.equal(answer.citations[0].sid, sids[sids.length - 1]);
    assert.ok(answer.citations[0].text);
    assert.ok(Array.isArray(answer.retrieved) && answer.retrieved.includes(answer.citations[0].sid));
    assert.equal(adapters.state.searchCalls.length, 1);
    assert.equal(adapters.state.askCalls.length, 1);

    // 停止再继续：已完成的句子保留，未完成的不会被重复翻译
    const second = await api.ok('/api/paper/docs/upload?filename=second.txt', {
      method: 'POST', cookie: alice.cookie,
      body: 'Alpha sentence. Beta sentence. Gamma sentence. Delta sentence.',
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
    const secondDoc = second.doc;
    adapters.state.delayMs = 120;
    const background = api.call(`/api/paper/docs/${secondDoc.id}/translate`, {
      method: 'POST', cookie: alice.cookie, json: { targetLang: 'zh' }
    });
    await waitFor(async () => {
      const state = await api.ok(`/api/paper/docs/${secondDoc.id}/translate?targetLang=zh`, { cookie: alice.cookie });
      return state.job.status === 'running' && state.job.done >= 1 ? state : null;
    }, '第二次翻译进入运行中');
    const stopped = await api.ok(`/api/paper/docs/${secondDoc.id}/translate/stop`, {
      method: 'POST', cookie: alice.cookie, json: { targetLang: 'zh' }
    });
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.job.status, 'stopped');
    const stopResponse = await background;
    assert.equal(stopResponse.status, 200);
    assert.equal(stopResponse.body.stopped, true);
    const stoppedState = await api.ok(`/api/paper/docs/${secondDoc.id}/translate?targetLang=zh&include=text`, { cookie: alice.cookie });
    assert.equal(stoppedState.job.status, 'stopped');
    assert.ok(stoppedState.job.done >= 1);
    assert.ok(stoppedState.job.done < stoppedState.job.total);
    assert.equal(Object.keys(stoppedState.translations).length, stoppedState.job.done);

    adapters.state.delayMs = 0;
    const beforeResume = adapters.state.translateCalls.length;
    const resumed = await api.ok(`/api/paper/docs/${secondDoc.id}/translate`, {
      method: 'POST', cookie: alice.cookie, json: { targetLang: 'zh' }
    });
    assert.equal(resumed.job.status, 'done');
    assert.equal(resumed.job.progress, 1);
    assert.ok(adapters.state.translateCalls.length - beforeResume <= resumed.job.total - stoppedState.job.done);
    const resumedState = await api.ok(`/api/paper/docs/${secondDoc.id}/translate?targetLang=zh&include=text`, { cookie: alice.cookie });
    assert.equal(Object.keys(resumedState.translations).length, resumedState.job.total);

    // 运行中关闭模块：任务收敛为 interrupted（可恢复），重启后状态与译文仍在
    const third = await api.ok('/api/paper/docs/upload?filename=third.txt', {
      method: 'POST', cookie: alice.cookie,
      body: 'One sentence here. Two sentence here. Three sentence here.',
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
    const thirdDoc = third.doc;
    adapters.state.delayMs = 120;
    const interruptedBackground = api.call(`/api/paper/docs/${thirdDoc.id}/translate`, {
      method: 'POST', cookie: alice.cookie, json: { targetLang: 'zh' }
    });
    await waitFor(async () => {
      const state = await api.ok(`/api/paper/docs/${thirdDoc.id}/translate?targetLang=zh`, { cookie: alice.cookie });
      return state.job.status === 'running' && state.job.done >= 1 ? state : null;
    }, '第三次翻译进入运行中');
    await runtime.core.modules.disable('paper');
    const interrupted = await interruptedBackground;
    assert.equal(interrupted.status, 502);
    assert.equal(interrupted.body.code, 'paper.translate_failed');
    assert.equal(interrupted.body.details.job.status, 'interrupted');

    await shutdown(runtime);
    runtime = await startRuntime({ configPath: installation.configPath, env, port: 0 });
    api = client(runtime.url);

    const afterRestart = await api.ok(`/api/paper/docs/${thirdDoc.id}/translate?targetLang=zh&include=text`, { cookie: alice.cookie });
    assert.equal(afterRestart.job.status, 'interrupted');
    assert.ok(afterRestart.job.done >= 1);
    assert.equal(Object.keys(afterRestart.translations).length, afterRestart.job.done);
    assert.match(afterRestart.job.error, /中断|停止/);

    // 重启后文档、译文与原件都还在
    const restartedDoc = await api.ok(`/api/paper/docs/${textDoc.id}`, { cookie: alice.cookie });
    assert.equal(restartedDoc.doc.segmentCount, textDoc.segmentCount);
    const restartedOriginal = await api.call(`/api/paper/docs/${textDoc.id}/file`, { cookie: alice.cookie });
    assert.equal(restartedOriginal.body.toString('utf8'), TEXT_DOC);

    adapters.state.delayMs = 0;
    const recovered = await api.ok(`/api/paper/docs/${thirdDoc.id}/translate`, {
      method: 'POST', cookie: alice.cookie, json: { targetLang: 'zh' }
    });
    assert.equal(recovered.job.status, 'done');
    assert.equal(recovered.job.progress, 1);
    const recoveredState = await api.ok(`/api/paper/docs/${thirdDoc.id}/translate?targetLang=zh&include=text`, { cookie: alice.cookie });
    assert.equal(Object.keys(recoveredState.translations).length, recoveredState.job.total);

    // 删除：译文、任务与原件一起清理，其他用户仍不可访问
    await api.ok(`/api/paper/docs/${pdfDoc.id}`, { method: 'DELETE', cookie: alice.cookie });
    assert.equal((await api.call(`/api/paper/docs/${pdfDoc.id}`, { cookie: alice.cookie })).status, 404);
    assert.equal((await api.call(`/api/paper/docs/${pdfDoc.id}/file`, { cookie: alice.cookie })).status, 404);
    assert.equal((await api.ok('/api/paper/docs', { cookie: alice.cookie })).docs.length, 3);
  } catch (error) {
    console.error('[paper-e2e] failed:', error && error.stack ? error.stack : error);
    if (error && error.body) console.error('[paper-e2e] body:', JSON.stringify(error.body));
    throw error;
  } finally {
    await shutdown(runtime);
    if (adapters) await adapters.close().catch(() => {});
    await stopMongo(mongo);
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
});