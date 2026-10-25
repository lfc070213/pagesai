'use strict';
// 集成测试共用装置：真实 mongod 副本集、临时安装树、真实进程启动与等待。
// 只在仓库外的临时目录写数据；不读取生产配置、不连接生产 MongoDB。
// 运行前需设置：
//   NODE_PATH=/tmp/pagesai-mongo-build/node_modules
//   PAGESAI_MONGO_TEST=1
//   MONGOMS_DOWNLOAD_DIR=/tmp/pagesai-mongo-build/binaries

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { once } = require('node:events');

const sourceRoot = path.join(__dirname, '..', '..', '..');
const BASE_ENV = {
  PATH: process.env.PATH || '/usr/bin:/bin',
  ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}),
  HOME: process.env.HOME || os.homedir()
};

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startMongo(root, { replSet = 'pagesai-deploy-e2e' } = {}) {
  const { MongoBinary } = require('mongodb-memory-server');
  const { MongoClient } = require('mongodb');
  const dbPath = path.join(root, 'mongo-data');
  await fs.promises.mkdir(dbPath, { recursive: true });
  const port = await unusedPort();
  const binary = await MongoBinary.getPath();
  const child = spawn(binary, [
    '--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1',
    '--replSet', replSet, '--storageEngine', 'wiredTiger', '--nounixsocket', '--quiet'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-12000); });
  child.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-12000); });
  const direct = `mongodb://127.0.0.1:${port}/?directConnection=true`;
  let setup;
  for (let attempt = 0; attempt < 200 && !setup; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`mongod 启动失败：${logs}`);
    const candidate = new MongoClient(direct, { serverSelectionTimeoutMS: 150 });
    try { await candidate.connect(); setup = candidate; } catch (error) {
      await candidate.close();
      if (attempt === 199) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const admin = setup.db('admin');
  await admin.command({ replSetInitiate: {
    _id: replSet, members: [{ _id: 0, host: `127.0.0.1:${port}` }],
    settings: { electionTimeoutMillis: 500, heartbeatIntervalMillis: 100 }
  } });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await admin.command({ hello: 1 })).isWritablePrimary) break;
    if (attempt === 199) throw new Error('mongod 未成为 Primary');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await setup.close();
  const uri = `mongodb://127.0.0.1:${port}/?replicaSet=${replSet}&directConnection=true`;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  return { child, client, uri, port, logs: () => logs };
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

const INSTALL_ENTRIES = ['package.json', 'package-lock.json', 'core', 'config', 'contracts', 'modules', 'deploy', 'tools', 'admin'];

/** 把公开版复制成仓库外的独立安装根，避免测试写入共享源码树。 */
async function copyInstall(destination) {
  await fs.promises.mkdir(destination, { recursive: true });
  for (const entry of INSTALL_ENTRIES) {
    const from = path.join(sourceRoot, entry);
    if (!fs.existsSync(from)) continue;
    await fs.promises.cp(from, path.join(destination, entry), { recursive: true });
  }
  return destination;
}

function runNode(installRoot, args, { env = {}, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, {
      cwd: installRoot,
      env: { ...BASE_ENV, ...env },
      timeout,
      maxBuffer: 16 * 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error.code === 'number' ? error.code : (error ? 1 : 0),
        error,
        stdout: String(stdout || ''),
        stderr: String(stderr || '')
      });
    });
  });
}

/** 启动真实子进程，按行解析 stdout 的 JSON 事件；失败时抛出收集到的输出。 */
function startProcess(installRoot, script, args, { env = {}, timeoutMs = 60000 } = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: installRoot,
    env: { ...BASE_ENV, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  const events = [];
  const waiters = [];
  const notify = () => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      const found = events.find((event) => event.event === waiter.event);
      if (found) { waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(found); }
    }
  };
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    const lines = stdout.split('\n');
    stdout = lines.pop();
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch { events.push({ event: 'line', line }); }
    }
    notify();
  });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-20000); });

  const stopped = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  function waitEvent(name) {
    const existing = events.find((event) => event.event === name);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { event: name, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`等待事件 ${name} 超时。exit=${child.exitCode} stdout=${JSON.stringify(events)}\nstderr=${stderr}`));
      }, timeoutMs);
      waiter.timer.unref();
      waiters.push(waiter);
    });
  }

  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return stopped;
    child.kill('SIGTERM');
    const result = await Promise.race([stopped, new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 25000))]);
    if (result.timeout) { child.kill('SIGKILL'); return stopped; }
    return result;
  }

  return { child, waitEvent, stop, stopped, events, output: () => ({ stdout, stderr, events }) };
}

async function waitForHttp(url, { timeoutMs = 30000, predicate } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.json().catch(() => null);
      if (!predicate || predicate(response, body)) return { status: response.status, body };
      lastError = new Error(`响应不满足条件：${response.status} ${JSON.stringify(body)}`);
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error(`等待 ${url} 超时`);
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
  async function login(username, password) {
    const response = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (response.status !== 200) throw new Error(`登录失败 ${response.status} ${await response.text()}`);
    return { cookie: response.headers.get('set-cookie').split(';', 1)[0], body: await response.json() };
  }
  return { call, login };
}

module.exports = {
  sourceRoot,
  BASE_ENV,
  unusedPort,
  startMongo,
  stopMongo,
  copyInstall,
  runNode,
  startProcess,
  waitForHttp,
  client
};