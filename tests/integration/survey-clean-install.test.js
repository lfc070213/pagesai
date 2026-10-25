'use strict';
// C27：仓库外临时干净安装（核心 + Survey），真实 MongoDB、真实 HTTP 与网页。
// 不读取生产配置；账号与附件均为合成内容；仅在 PAGESAI_MONGO_TEST=1 时运行。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const ENABLED = process.env.PAGESAI_MONGO_TEST === '1';
const sourceRoot = path.join(__dirname, '..', '..');
const PASSWORD = 'survey-e2e-password';

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
    '--replSet', 'pagesai-survey-e2e', '--storageEngine', 'wiredTiger', '--nounixsocket', '--quiet'
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
    _id: 'pagesai-survey-e2e', members: [{ _id: 0, host: `127.0.0.1:${port}` }],
    settings: { electionTimeoutMillis: 500, heartbeatIntervalMillis: 100 }
  } });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await admin.command({ hello: 1 })).isWritablePrimary) break;
    if (attempt === 199) throw new Error('mongod 未成为 Primary');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await setup.close();
  const uri = `mongodb://127.0.0.1:${port}/?replicaSet=pagesai-survey-e2e&directConnection=true`;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  return { child, client, uri };
}

async function stopMongo(mongo) {
  if (!mongo) return;
  await Promise.race([mongo.client.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (!mongo.child.killed) {
    mongo.child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => { mongo.child.kill('SIGKILL'); resolve(); }, 5000);
      mongo.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  // 释放子进程管道，避免测试进程被残留句柄拖住。
  mongo.child.stdout?.destroy();
  mongo.child.stderr?.destroy();
  mongo.child.unref?.();
}

async function cleanInstall(root) {
  const installRoot = path.join(root, 'clean-install');
  const dataRoot = path.join(root, 'clean-data');
  await fs.promises.mkdir(installRoot, { recursive: true });
  for (const directory of ['core', 'config', 'contracts']) {
    await fs.promises.cp(path.join(sourceRoot, directory), path.join(installRoot, directory), { recursive: true });
  }
  await fs.promises.mkdir(path.join(installRoot, 'modules', 'survey'), { recursive: true });
  for (const entry of ['manifest.json', 'config.schema.json', 'server', 'web']) {
    await fs.promises.cp(path.join(sourceRoot, 'modules', 'survey', entry), path.join(installRoot, 'modules', 'survey', entry), { recursive: true });
  }
  await fs.promises.mkdir(path.join(installRoot, 'tools'), { recursive: true });
  await fs.promises.copyFile(path.join(sourceRoot, 'tools', 'init.js'), path.join(installRoot, 'tools', 'init.js'));
  await fs.promises.copyFile(path.join(sourceRoot, 'package.json'), path.join(installRoot, 'package.json'));
  const configPath = path.join(installRoot, 'config.json');
  await exec(process.execPath, [
    'tools/init.js', '--data-root', dataRoot, '--modules', 'survey', '--install-root', installRoot,
    '--config', configPath, '--json'
  ], { cwd: installRoot, env: { PATH: process.env.PATH || '/usr/bin:/bin' } });
  const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
  config.moduleConfig = { survey: { dataFile: path.join(dataRoot, 'survey', 'data.json'), maxAttachmentBytes: 1024 * 1024 } };
  await fs.promises.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { installRoot, dataRoot, configPath, config };
}

// 先断开所有 keep-alive 连接再关闭运行时，避免测试失败时 finally 卡住。
async function shutdown(rt) {
  if (!rt) return;
  try { rt.app.server.closeAllConnections?.(); } catch {}
  await Promise.race([rt.app.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 3000))]);
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

test('Survey 单装：网页、编辑、发布、匿名填写、统计、附件、CSV、关闭与重启持久化', {
  skip: ENABLED ? false : '设置 PAGESAI_MONGO_TEST=1，使用仓库外 /tmp/pagesai-mongo-build 依赖运行',
  timeout: 300000
}, async () => {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pagesai-survey-clean-'));
  let mongo; let runtime;
  try {
    mongo = await startMongo(temporary);
    const installation = await cleanInstall(temporary);
    const env = { PATH: process.env.PATH || '/usr/bin:/bin', PAGESAI_MONGO_URL: mongo.uri };
    const { startRuntime } = require(path.join(installation.installRoot, 'core', 'runtime.js'));
    runtime = await startRuntime({ configPath: installation.configPath, env, port: 0 });
    let base = runtime.url;
    let api = client(base);

    // 网页静态资源与 CSP
    const html = (await api.ok('/survey')).toString();
    assert.match(html, /id="fill-root"/);
    assert.match(html, /src="\/survey-app.js"/);
    assert.match(html, /href="\/survey-app.css"/);
    const page = await api.call('/survey');
    assert.match(page.headers.get('content-security-policy') || '', /default-src 'self'/);
    const script = (await api.ok('/survey-app.js')).toString();
    assert.match(script, /\/api\/survey\/surveys/);
    assert.match(script, /#fill\//);
    assert.doesNotMatch(script, /x-dev-user/);
    assert.match((await api.ok('/survey-app.css')).toString(), /\.fill-card/);

    await api.ok('/api/auth/register', { method: 'POST', json: { username: 'survey_a', password: PASSWORD } });
    const alice = await api.login('survey_a');
    await api.ok('/api/auth/register', { method: 'POST', json: { username: 'survey_b', password: PASSWORD } });
    const bob = await api.login('survey_b');

    const created = await api.ok('/api/survey/surveys', {
      method: 'POST', cookie: alice.cookie,
      json: {
        title: '课程反馈',
        description: '匿名填写',
        questions: [
          { type: 'single', title: '满意度', required: true, options: ['满意', '一般'] },
          { type: 'multiple', title: '关注点', options: ['课程', '作业'] },
          { type: 'text', title: '建议' },
          { type: 'file', title: '证明材料' }
        ]
      }
    });
    const surveyId = created.survey.id;
    assert.equal(created.survey.status, 'draft');
    assert.equal((await api.call(`/api/survey/surveys/${surveyId}`, { cookie: bob.cookie })).status, 403);

    const published = await api.ok(`/api/survey/surveys/${surveyId}/publish`, { method: 'POST', cookie: alice.cookie, json: {} });
    assert.equal(published.version, 1);
    const slug = published.slug;
    assert.ok(slug);
    const publicSurvey = await api.ok(`/api/survey/public/${slug}`);
    assert.equal(publicSurvey.survey.title, '课程反馈');
    assert.equal(publicSurvey.survey.acceptingResponses, true);
    assert.equal(publicSurvey.survey.questions[0].id, 'q1');

    const fileText = 'survey attachment';
    const submitted = await api.ok(`/api/survey/public/${slug}/responses`, {
      method: 'POST',
      json: {
        answers: {
          q1: 'o1',
          q2: ['o1', 'o2'],
          q3: '希望增加案例',
          q4: { filename: 'proof.txt', contentType: 'text/plain', dataBase64: Buffer.from(fileText).toString('base64') }
        }
      }
    });
    assert.equal(submitted.response.surveyId, surveyId);

    const stats = await api.ok(`/api/survey/surveys/${surveyId}/stats`, { cookie: alice.cookie });
    assert.equal(stats.stats.responseCount, 1);
    assert.equal(stats.stats.questions[0].options[0].count, 1);
    assert.equal((await api.call(`/api/survey/surveys/${surveyId}/stats`, { cookie: bob.cookie })).status, 403);

    const responses = await api.ok(`/api/survey/surveys/${surveyId}/responses`, { cookie: alice.cookie });
    assert.equal(responses.responseCount, 1);
    const fileAnswer = responses.responses[0].answers.q4;
    assert.equal(fileAnswer.filename, 'proof.txt');
    const attachment = await api.ok(`/api/survey/surveys/${surveyId}/attachments/${fileAnswer.attachmentId}`, { cookie: alice.cookie });
    assert.equal(Buffer.from(attachment.dataBase64, 'base64').toString('utf8'), fileText);
    assert.equal((await api.call(`/api/survey/surveys/${surveyId}/attachments/${fileAnswer.attachmentId}`, { cookie: bob.cookie })).status, 403);

    const csv = await api.call(`/api/survey/surveys/${surveyId}/export.csv`, { cookie: alice.cookie });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') || '', /text\/csv/);
    const csvText = csv.body.toString('utf8');
    assert.match(csvText, /response_id,submitted_at/);
    assert.match(csvText, /希望增加案例/);
    assert.match(csvText, /proof\.txt/);

    await api.ok(`/api/survey/surveys/${surveyId}/close`, { method: 'POST', cookie: alice.cookie, json: {} });
    const closed = await api.call(`/api/survey/public/${slug}/responses`, { method: 'POST', json: { answers: { q1: 'o2' } } });
    assert.equal(closed.status, 409);
    assert.equal(closed.body.code, 'SURVEY_CLOSED');

    // 重启后仍可读取问卷、公开快照、答卷与附件
    await shutdown(runtime);
    runtime = null;
    runtime = await startRuntime({ configPath: installation.configPath, env, port: 0 });
    base = runtime.url;
    api = client(base);
    const afterRestart = await api.ok(`/api/survey/surveys/${surveyId}`, { cookie: alice.cookie });
    assert.equal(afterRestart.survey.status, 'closed');
    assert.equal((await api.ok(`/api/survey/public/${slug}`)).survey.closed, true);
    const persisted = await api.ok(`/api/survey/surveys/${surveyId}/responses`, { cookie: alice.cookie });
    assert.equal(persisted.responseCount, 1);
    const persistedAttachment = await api.ok(
      `/api/survey/surveys/${surveyId}/attachments/${persisted.responses[0].answers.q4.attachmentId}`,
      { cookie: alice.cookie }
    );
    assert.equal(Buffer.from(persistedAttachment.dataBase64, 'base64').toString('utf8'), fileText);
  } catch (error) {
    console.error('[survey-e2e] failed:', error && error.stack ? error.stack : error);
    if (error && error.body) console.error('[survey-e2e] body:', JSON.stringify(error.body));
    throw error;
  } finally {
    await shutdown(runtime);
    await stopMongo(mongo);
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
});
