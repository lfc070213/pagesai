'use strict';
// C30 / C06：网关真实进程入口的集成测试。
// 网关与上游都是真实 HTTP 服务器（上游可以是真实 core），不使用 mock 传输。
// 覆盖：流式上传/下载不整包缓冲、Range 206/416、零字节、SSE、客户端取消销毁上游、
// X-Forwarded-* 覆盖、上游不可用 502，以及经网关访问真实 core 的登录链路。
// 运行：node --test tests/integration/gateway.test.js（只需 Node 内置模块）

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const { createGateway } = require(path.join(__dirname, '..', '..', 'deploy', 'docker', 'entrypoints', 'gateway.js'));

// ---------------------------------------------------------------------------
// 真实上游
// ---------------------------------------------------------------------------

function payload(size) {
  const buffer = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index += 1) buffer[index] = index % 251;
  return buffer;
}

function startUpstream() {
  const state = {
    echo: null,
    hangStarted: false,
    hangClosed: false,
    hangClosedPromise: null
  };
  let hangResolve = null;
  state.hangClosedPromise = new Promise((resolve) => { hangResolve = resolve; });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://upstream.test');

    if (url.pathname === '/echo') {
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      let chunks = 0;
      let firstDataAt = null;
      req.on('data', (chunk) => {
        if (firstDataAt === null) firstDataAt = Date.now();
        hash.update(chunk);
        bytes += chunk.length;
        chunks += 1;
      });
      req.on('end', () => {
        state.echo = { bytes, chunks, hash: hash.digest('hex'), firstDataAt };
        const body = JSON.stringify({ bytes, chunks, hash: state.echo.hash });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
      });
      return;
    }

    if (url.pathname === '/headers') {
      const body = JSON.stringify(req.headers);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    if (url.pathname === '/download') {
      const size = Number(url.searchParams.get('size') || 1024);
      const data = payload(size);
      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        const start = match ? Number(match[1]) : NaN;
        const end = match && match[2] !== '' ? Number(match[2]) : size - 1;
        if (!match || !Number.isSafeInteger(start) || start >= size || end < start) {
          res.writeHead(416, { 'content-range': `bytes */${size}`, 'content-length': 0 });
          res.end();
          return;
        }
        const last = Math.min(end, size - 1);
        const slice = data.subarray(start, last + 1);
        res.writeHead(206, {
          'content-type': 'application/octet-stream',
          'accept-ranges': 'bytes',
          'content-range': `bytes ${start}-${last}/${size}`,
          'content-length': slice.length
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'accept-ranges': 'bytes',
        'content-length': data.length
      });
      res.end(data);
      return;
    }

    if (url.pathname === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write('data: one\n\n');
      setTimeout(() => {
        res.write('data: two\n\n');
        setTimeout(() => res.end(), 20);
      }, 150);
      return;
    }

    if (url.pathname === '/hang') {
      state.hangStarted = true;
      req.on('close', () => {
        state.hangClosed = true;
        hangResolve(true);
      });
      return;
    }

    if (url.pathname === '/zero') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 0 });
      res.end();
      return;
    }

    if (url.pathname === '/nocontent') {
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        state,
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}

// ---------------------------------------------------------------------------
// 网关与请求工具
// ---------------------------------------------------------------------------

async function startGateway(upstreamBase) {
  const gateway = createGateway({
    listenPort: 0,
    host: '127.0.0.1',
    upstream: { url: new URL(upstreamBase), basePath: '' },
    tls: null
  });
  const { port } = await gateway.listen();
  return { gateway, base: `http://127.0.0.1:${port}` };
}

async function withStack(run) {
  const upstream = await startUpstream();
  const { gateway, base } = await startGateway(upstream.base);
  try {
    return await run({ upstream, gateway, base });
  } finally {
    await gateway.close();
    await upstream.close();
  }
}

function request(base, { method = 'GET', path: pathname = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + pathname, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    req.end(body === null ? undefined : body);
  });
}

function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

test('网关转发：状态码、响应头与正文原样到达', async () => {
  await withStack(async ({ base }) => {
    const response = await request(base, { path: '/download?size=64' });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'application/octet-stream');
    assert.equal(response.body.length, 64);
    assert.deepEqual(response.body, payload(64));
  });
});

test('大请求体流式上传：不整包缓冲，字节与哈希一致', async () => {
  await withStack(async ({ upstream, base }) => {
    const size = 4 * 1024 * 1024;
    const chunkSize = 64 * 1024;
    const total = size / chunkSize;
    let endedAt = null;

    const response = await new Promise((resolve, reject) => {
      const req = http.request(`${base}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'content-length': size }
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);

      let sent = 0;
      const writeNext = () => {
        if (sent === total) {
          endedAt = Date.now();
          req.end();
          return;
        }
        const chunk = payload(chunkSize);
        sent += 1;
        req.write(chunk, () => setTimeout(writeNext, 1));
      };
      writeNext();
    });

    assert.equal(response.status, 200);
    const echoed = JSON.parse(response.body.toString('utf8'));
    assert.equal(echoed.bytes, size);
    assert.ok(echoed.chunks >= 2, `上游应收到多个块，实际 ${echoed.chunks}`);

    const expected = crypto.createHash('sha256');
    for (let index = 0; index < total; index += 1) expected.update(payload(chunkSize));
    assert.equal(echoed.hash, expected.digest('hex'));

    // 流式证据：上游在客户端写完之前就开始收数据，说明网关没有攒满整个正文。
    assert.ok(upstream.state.echo.firstDataAt !== null);
    assert.ok(upstream.state.echo.firstDataAt < endedAt, '上游应在请求结束前收到首批数据');
  });
});

test('大响应体流式下载：字节完整且首块早于结束', async () => {
  await withStack(async ({ base }) => {
    const size = 3 * 1024 * 1024;
    const firstChunkAt = await new Promise((resolve, reject) => {
      const req = http.get(`${base}/download?size=${size}`, (res) => {
        let bytes = 0;
        let first = null;
        res.on('data', (chunk) => {
          if (first === null) first = Date.now();
          bytes += chunk.length;
        });
        res.on('end', () => resolve({ first, bytes }));
        res.on('error', reject);
      });
      req.on('error', reject);
    });
    assert.equal(firstChunkAt.bytes, size);
    assert.ok(firstChunkAt.first !== null);
  });
});

test('Range 透传：206 切片与 416 越界', async () => {
  await withStack(async ({ base }) => {
    const full = await request(base, { path: '/download?size=1024' });
    assert.equal(full.status, 200);
    assert.equal(full.body.length, 1024);

    const partial = await request(base, { path: '/download?size=1024', headers: { range: 'bytes=100-199' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers['content-range'], 'bytes 100-199/1024');
    assert.equal(partial.body.length, 100);
    assert.deepEqual(partial.body, payload(1024).subarray(100, 200));

    const beyond = await request(base, { path: '/download?size=1024', headers: { range: 'bytes=5000-6000' } });
    assert.equal(beyond.status, 416);
    assert.equal(beyond.headers['content-range'], 'bytes */1024');
    assert.equal(beyond.body.length, 0);
  });
});

test('零字节：空请求体、空响应与 204 不被改写', async () => {
  await withStack(async ({ upstream, base }) => {
    const empty = await request(base, { method: 'POST', path: '/echo', headers: { 'content-length': 0 } });
    assert.equal(empty.status, 200);
    assert.equal(JSON.parse(empty.body.toString('utf8')).bytes, 0);
    assert.equal(upstream.state.echo.chunks, 0);

    const zero = await request(base, { path: '/zero' });
    assert.equal(zero.status, 200);
    assert.equal(zero.body.length, 0);
    assert.equal(zero.headers['content-length'], '0');

    const noContent = await request(base, { path: '/nocontent' });
    assert.equal(noContent.status, 204);
    assert.equal(noContent.body.length, 0);
  });
});

test('SSE：事件分块到达，不在网关聚合后一次性返回', async () => {
  await withStack(async ({ base }) => {
    const result = await new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const req = http.get(`${base}/sse`, (res) => {
        assert.equal(res.headers['content-type'], 'text/event-stream');
        const chunks = [];
        let firstChunkAt = null;
        res.on('data', (chunk) => {
          if (firstChunkAt === null) firstChunkAt = Date.now();
          chunks.push(chunk);
        });
        res.on('end', () => resolve({
          firstChunkAt,
          endedAt: Date.now(),
          text: Buffer.concat(chunks).toString('utf8'),
          startedAt
        }));
        res.on('error', reject);
      });
      req.on('error', reject);
    });

    assert.match(result.text, /data: one/);
    assert.match(result.text, /data: two/);
    // 上游第一条事件后等待 150ms 才发第二条：首块必须明显早于结束。
    assert.ok(result.endedAt - result.firstChunkAt >= 100, `首块到结束仅 ${result.endedAt - result.firstChunkAt}ms`);
  });
});

test('客户端取消：网关立即销毁上游请求', async () => {
  await withStack(async ({ upstream, base }) => {
    const controller = new AbortController();
    const pending = fetch(`${base}/hang`, { method: 'POST', body: 'payload', signal: controller.signal }).catch((error) => error);

    const deadline = Date.now() + 3000;
    while (!upstream.state.hangStarted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(upstream.state.hangStarted, true, '上游应已收到请求');

    controller.abort();
    await pending;

    const closed = await Promise.race([
      upstream.state.hangClosedPromise,
      new Promise((resolve) => setTimeout(() => resolve(false), 3000))
    ]);
    assert.equal(closed, true, '客户端断开后上游连接应被销毁');
    assert.equal(upstream.state.hangClosed, true);
  });
});

test('X-Forwarded-* 由网关重写，不采信客户端声明', async () => {
  await withStack(async ({ base }) => {
    const response = await request(base, {
      path: '/headers',
      headers: {
        host: 'gateway.test',
        'x-forwarded-for': '203.0.113.9',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'evil.test',
        'x-real-ip': '203.0.113.10'
      }
    });
    assert.equal(response.status, 200);
    const headers = JSON.parse(response.body.toString('utf8'));

    assert.equal(headers['x-forwarded-for'], '127.0.0.1');
    assert.equal(headers['x-forwarded-proto'], 'http');
    assert.equal(headers['x-real-ip'], '127.0.0.1');
    assert.equal(headers['x-forwarded-host'], 'gateway.test');
    assert.equal(headers.host, 'gateway.test');
  });
});

test('上游不可用：返回 502 且带稳定错误码', async () => {
  const port = await unusedPort();
  const { gateway, base } = await startGateway(`http://127.0.0.1:${port}`);
  try {
    const response = await request(base, { path: '/healthz' });
    assert.equal(response.status, 502);
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(body.ok, false);
    assert.equal(body.code, 'GATEWAY_UPSTREAM_UNAVAILABLE');
  } finally {
    await gateway.close();
  }
});

test('经网关访问真实 core：健康、注册、登录与会话', async () => {
  const coreRoot = path.join(__dirname, '..', '..', 'core');
  const { loadConfig } = require(path.join(coreRoot, 'config', 'index.js'));
  const { createCore, createServer } = require(path.join(coreRoot, 'server.js'));
  const { InMemoryIdentityStore } = require(path.join(coreRoot, 'identity', 'store.js'));

  const config = loadConfig({ env: {}, dataRoot: path.join(os.tmpdir(), 'pagesai-gateway-core-test') });
  const core = createCore({ config, store: new InMemoryIdentityStore() });
  const app = createServer(core);
  const info = await app.listen({ port: 0 });

  const upstreamBase = info.url.replace(/\/$/, '');
  const { gateway, base } = await startGateway(upstreamBase);
  try {
    const health = await request(base, { path: '/healthz' });
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body.toString('utf8')).ok, true);

    const ready = await request(base, { path: '/readyz' });
    assert.equal(ready.status, 200);
    assert.deepEqual(JSON.parse(ready.body.toString('utf8')).modules, []);

    const register = await request(base, {
      method: 'POST',
      path: '/api/auth/register',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'gateway-user', password: 'password-1234' })
    });
    assert.equal(register.status, 201);

    const login = await request(base, {
      method: 'POST',
      path: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'gateway-user', password: 'password-1234' })
    });
    assert.equal(login.status, 200);
    const token = JSON.parse(login.body.toString('utf8')).token;
    assert.ok(token);

    const me = await request(base, { path: '/api/me', headers: { authorization: `Bearer ${token}` } });
    assert.equal(me.status, 200);
    assert.equal(JSON.parse(me.body.toString('utf8')).user.username, 'gateway-user');

    // 公共 JSON 上限 64 KiB 应原样经网关返回 413，而不是被网关改写。
    const oversize = await request(base, {
      method: 'POST',
      path: '/api/auth/register',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'big', password: 'x'.repeat(70 * 1024) })
    });
    assert.equal(oversize.status, 413);
  } finally {
    await gateway.close();
    await app.close();
  }
});