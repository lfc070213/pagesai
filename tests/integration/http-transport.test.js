'use strict';
// C06 只经 createServer 公共宿主验证真实 socket，不调用模块私有 dev server。

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { once } = require('node:events');

const root = path.join(__dirname, '..', '..');
const { loadConfig } = require(path.join(root, 'core', 'config'));
const { createCore, createServer } = require(path.join(root, 'core', 'server'));
const { InMemoryIdentityStore } = require(path.join(root, 'core', 'identity', 'store'));

const KIB = 1024;
const MIB = 1024 * KIB;
const CHUNK = Buffer.alloc(64 * KIB);
for (let i = 0; i < CHUNK.length; i++) CHUNK[i] = i % 251;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function synthetic(size, onFinally) {
  return (async function* generate() {
    try {
      let left = size;
      while (left > 0) {
        const chunk = left >= CHUNK.length ? CHUNK : CHUNK.subarray(0, left);
        left -= chunk.length;
        yield chunk;
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      if (onFinally) onFinally();
    }
  }());
}

async function boot(routes) {
  const config = loadConfig({ env: {}, dataRoot: path.join(os.tmpdir(), 'pagesai-http-transport-test') });
  const core = createCore({ config, store: new InMemoryIdentityStore() });
  core.modules.entries.set('transport-fixture', {
    manifest: { capabilities: {} },
    state: { installed: true, enabled: true, configured: true, ready: true },
    instance: { routes },
    startError: null
  });
  const app = createServer(core);
  const info = await app.listen({ port: 0 });
  return { app, base: info.url };
}

function requestRaw(base, method, route, { headers = {}, chunks = [], abortAfterFirstChunk = false } = {}) {
  const url = new URL(route, base);
  const outcome = deferred();
  const req = http.request({
    method,
    hostname: url.hostname,
    port: url.port,
    path: url.pathname + url.search,
    headers
  }, (res) => {
    if (abortAfterFirstChunk) {
      res.once('data', () => {
        req.destroy();
        outcome.resolve({ aborted: true });
      });
      res.resume();
      return;
    }
    const responseChunks = [];
    res.on('data', (chunk) => responseChunks.push(chunk));
    res.on('end', () => outcome.resolve({
      status: res.statusCode,
      headers: res.headers,
      body: Buffer.concat(responseChunks)
    }));
  });
  req.on('error', (error) => {
    if (!abortAfterFirstChunk) outcome.resolve({ error });
  });
  (async () => {
    for (const chunk of chunks) {
      if (req.destroyed) break;
      if (!req.write(chunk)) await once(req, 'drain');
    }
    if (!req.destroyed) req.end();
  })().catch(() => req.destroy());
  return outcome.promise;
}

async function writeRequest(base, route, total, onChunk) {
  const url = new URL(route, base);
  const response = deferred();
  const req = http.request({
    method: 'PUT',
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    headers: { 'content-type': 'application/octet-stream', 'content-length': total }
  }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => response.resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
  });
  req.on('error', response.resolve);
  let sent = 0;
  while (sent < total && !req.destroyed) {
    const chunk = total - sent >= CHUNK.length ? CHUNK : CHUNK.subarray(0, total - sent);
    sent += chunk.length;
    if (onChunk) onChunk(sent);
    if (!req.write(chunk)) await once(req, 'drain');
  }
  if (!req.destroyed) req.end();
  const result = await response.promise;
  if (result instanceof Error) throw result;
  return result;
}

test('旧路由默认 JSON；JSON 多 chunk 有界且非法/超限分别收敛 400/413', async () => {
  const observed = {};
  const routes = [
    {
      method: 'POST', path: '/legacy',
      handler: ({ body }) => ({ body: { length: body.text.length } })
    },
    {
      method: 'POST', path: '/json', transport: { kind: 'json', maxBytes: 256 * KIB },
      handler: ({ body }) => ({ body: { length: body.text.length, chunks: observed.chunks } })
    }
  ];
  const { app, base } = await boot(routes);
  try {
    const text = 'x'.repeat(200 * KIB);
    const wire = JSON.stringify({ text });
    const midpoint = Math.floor(wire.length / 2);
    observed.chunks = 2;
    const large = await requestRaw(base, 'POST', '/json', {
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(wire) },
      chunks: [Buffer.from(wire.slice(0, midpoint)), Buffer.from(wire.slice(midpoint))]
    });
    assert.equal(large.status, 200);
    assert.equal(JSON.parse(large.body).length, text.length);

    const legacy = await fetch(base + '/legacy', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'compatible' })
    });
    assert.equal(legacy.status, 200);
    assert.deepEqual(await legacy.json(), { length: 10 });

    const invalid = await fetch(base + '/json', { method: 'POST', body: '{broken' });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, 'INVALID_INPUT');

    const tooLarge = await fetch(base + '/legacy', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(64 * KIB) })
    });
    assert.equal(tooLarge.status, 413);
  } finally {
    await app.close();
  }
});

test('binary 是有界原始 Buffer，handler 接管 res 后宿主不序列化 Buffer', async () => {
  const payload = Buffer.alloc(100 * KIB, 0xa5);
  const routes = [
    {
      method: 'POST', path: '/binary', transport: { kind: 'binary', maxBytes: 128 * KIB },
      handler: ({ body }) => {
        assert.ok(Buffer.isBuffer(body));
        return { body, contentType: 'application/x-pagesai-test' };
      }
    },
    {
      method: 'GET', path: '/handled', transport: { kind: 'binary' },
      handler: ({ res }) => {
        res.writeHead(201, { 'content-type': 'application/octet-stream' });
        res.end(payload);
        return { handled: true, body: { ignored: true } };
      }
    }
  ];
  const { app, base } = await boot(routes);
  try {
    const response = await fetch(base + '/binary', { method: 'POST', body: payload });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/x-pagesai-test');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);

    const handled = await fetch(base + '/handled');
    assert.equal(handled.status, 201);
    assert.deepEqual(Buffer.from(await handled.arrayBuffer()), payload);

    const limited = await fetch(base + '/binary', { method: 'POST', body: Buffer.alloc(129 * KIB) });
    assert.equal(limited.status, 413);
  } finally {
    await app.close();
  }
});

test('upload 100MiB 合成流保持有界内存、背压与流式哈希', { timeout: 30000 }, async (t) => {
  const total = 100 * MIB;
  let chunks = 0;
  const routes = [{
    method: 'PUT', path: '/upload', transport: {
      kind: 'upload', maxBytes: total, accepts: ['application/octet-stream'], cancellation: 'propagate'
    },
    handler: async ({ stream, signal }) => {
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      for await (const chunk of stream) {
        assert.equal(signal.aborted, false);
        chunks++;
        bytes += chunk.length;
        hash.update(chunk);
      }
      return { body: { bytes, chunks, sha256: hash.digest('hex') } };
    }
  }];
  const { app, base } = await boot(routes);
  const before = process.memoryUsage().rss;
  let peak = before;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
  try {
    const response = await writeRequest(base, '/upload', total);
    assert.equal(response.status, 200);
    const result = JSON.parse(response.body);
    assert.equal(result.bytes, total);
    assert.equal(result.chunks, chunks);
    assert.ok(chunks > 1000, '必须真实经过多个流块');
    const expected = crypto.createHash('sha256');
    for (let i = 0; i < total / CHUNK.length; i++) expected.update(CHUNK);
    assert.equal(result.sha256, expected.digest('hex'));
    const rssGrowth = peak - before;
    t.diagnostic(`100MiB upload: ${chunks} chunks, peak RSS growth ${rssGrowth.toFixed(0)} bytes`);
    assert.ok(rssGrowth < 80 * MIB, `RSS 增长 ${Math.round(rssGrowth / MIB)} MiB，疑似整文件驻留`);
  } finally {
    clearInterval(sampler);
    await app.close();
  }
});

test('upload 无 Content-Length 仍在流中超限并收敛 413', async () => {
  const routes = [{
    method: 'PUT', path: '/limited-upload', transport: { kind: 'upload', maxBytes: 128 * KIB },
    handler: async ({ stream }) => {
      let bytes = 0;
      for await (const chunk of stream) bytes += chunk.length;
      return { body: { bytes } };
    }
  }];
  const { app, base } = await boot(routes);
  try {
    const response = await requestRaw(base, 'PUT', '/limited-upload', {
      headers: { 'content-type': 'application/octet-stream' },
      chunks: [CHUNK, CHUNK, CHUNK]
    });
    assert.equal(response.status, 413);
    assert.equal(JSON.parse(response.body).code, 'INVALID_INPUT');
  } finally {
    await app.close();
  }
});

test('upload 客户端中断传播 AbortSignal 并终止读取', async () => {
  const started = deferred();
  const cancelled = deferred();
  let observedAbort = false;
  const routes = [{
    method: 'PUT', path: '/cancel-upload', transport: { kind: 'upload', maxBytes: 100 * MIB },
    handler: async ({ stream, signal }) => {
      signal.addEventListener('abort', () => { observedAbort = true; }, { once: true });
      started.resolve();
      try {
        for await (const chunk of stream) void chunk;
      } catch {
        // 客户端消失后没有可写入的错误响应。
      } finally {
        cancelled.resolve();
      }
      return { handled: true };
    }
  }];
  const { app, base } = await boot(routes);
  try {
    const url = new URL('/cancel-upload', base);
    const req = http.request({
      method: 'PUT', hostname: url.hostname, port: url.port, path: url.pathname,
      headers: { 'content-type': 'application/octet-stream', 'content-length': 100 * MIB }
    });
    req.on('error', () => {});
    req.write(CHUNK);
    req.write(CHUNK);
    await started.promise;
    req.destroy();
    await Promise.race([
      cancelled.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('upload 取消未传播')), 2000))
    ]);
    assert.equal(observedAbort, true);
  } finally {
    await app.close();
  }
});

test('download 支持单 Range/416/零字节，且按流返回二进制', async () => {
  let emptyReads = 0;
  const bytes = Buffer.from('0123456789');
  const routes = [
    {
      method: 'GET', path: '/download', transport: { kind: 'download' },
      handler: () => ({
        stream: Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]),
        size: bytes.length,
        etag: '"ten-bytes"',
        contentType: 'application/octet-stream'
      })
    },
    {
      method: 'GET', path: '/empty', transport: { kind: 'download' },
      handler: () => ({
        stream: Readable.from((async function* empty() { emptyReads++; yield Buffer.alloc(0); }())),
        size: 0
      })
    }
  ];
  const { app, base } = await boot(routes);
  try {
    const range = await fetch(base + '/download', { headers: { range: 'bytes=2-5' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(range.headers.get('content-length'), '4');
    assert.equal(range.headers.get('etag'), '"ten-bytes"');
    assert.equal(await range.text(), '2345');

    const suffix = await fetch(base + '/download', { headers: { range: 'bytes=-3' } });
    assert.equal(suffix.status, 206);
    assert.equal(await suffix.text(), '789');

    const open = await fetch(base + '/download', { headers: { range: 'bytes=7-' } });
    assert.equal(open.status, 206);
    assert.equal(await open.text(), '789');

    for (const value of ['bytes=10-11', 'bytes=0-1,4-5', 'broken']) {
      const unsatisfied = await fetch(base + '/download', { headers: { range: value } });
      assert.equal(unsatisfied.status, 416, value);
      assert.equal(unsatisfied.headers.get('content-range'), 'bytes */10');
      assert.match(unsatisfied.headers.get('content-type'), /^application\/json/);
    }

    const empty = await fetch(base + '/empty');
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get('content-length'), '0');
    assert.equal((await empty.arrayBuffer()).byteLength, 0);
    assert.equal(emptyReads, 0, '零字节响应不应拉取源流');
    const emptyRange = await fetch(base + '/empty', { headers: { range: 'bytes=0-0' } });
    assert.equal(emptyRange.status, 416);
    assert.equal(emptyRange.headers.get('content-range'), 'bytes */0');
  } finally {
    await app.close();
  }
});

test('download 客户端中断销毁源流并传播关闭', async () => {
  const closed = deferred();
  let sourceClosed = false;
  let signalAborted = false;
  const routes = [{
    method: 'GET', path: '/interrupt', transport: { kind: 'download' },
    handler: ({ signal }) => {
      signal.addEventListener('abort', () => { signalAborted = true; }, { once: true });
      return {
        stream: synthetic(100 * MIB, () => { sourceClosed = true; closed.resolve(); }),
        size: 100 * MIB
      };
    }
  }];
  const { app, base } = await boot(routes);
  try {
    const response = await requestRaw(base, 'GET', '/interrupt', { abortAfterFirstChunk: true });
    assert.equal(response.aborted, true);
    await Promise.race([
      closed.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('download 源流未关闭')), 2000))
    ]);
    assert.equal(sourceClosed, true);
    assert.equal(signalAborted, true);
  } finally {
    await app.close();
  }
});

test('SSE 有心跳、递增事件 ID、多行 UTF-8，客户端关闭传播', async () => {
  const closed = deferred();
  let closeSignal = false;
  const routes = [
    {
      method: 'GET', path: '/events', transport: { kind: 'sse', heartbeatMs: 10 },
      handler: async ({ sse }) => {
        await sse.send({ event: 'progress', data: { text: '第一行\n第二行' } });
        await new Promise((resolve) => setTimeout(resolve, 25));
        await sse.send('done', '完成');
      }
    },
    {
      method: 'GET', path: '/events-close', transport: { kind: 'sse', heartbeatMs: 1000 },
      handler: async ({ sse, signal }) => {
        signal.addEventListener('abort', () => { closeSignal = true; closed.resolve(); }, { once: true });
        await sse.send({ data: 'first' });
        await new Promise(() => {});
      }
    }
  ];
  const { app, base } = await boot(routes);
  try {
    const response = await fetch(base + '/events');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    const text = await response.text();
    assert.match(text, /id: 1\nevent: progress\ndata: \{"text":"第一行\\n第二行"\}/);
    assert.match(text, /: heartbeat\n\n/);
    assert.match(text, /id: 2\nevent: done\ndata: 完成\n\n/);

    await requestRaw(base, 'GET', '/events-close', { abortAfterFirstChunk: true });
    await Promise.race([
      closed.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('SSE 关闭未传播')), 2000))
    ]);
    assert.equal(closeSignal, true);
  } finally {
    await app.close();
  }
});
