'use strict';
// C06 公共 HTTP 传输层。大文件只在流中经过，不进入 JSON 或整文件 Buffer。
// 模块 handler 返回 { handled: true } 后拥有 res；宿主不再写头或序列化结果。

const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { CoreError, codes } = require('./errors');

const DEFAULT_JSON_MAX_BYTES = 64 * 1024;
const DEFAULT_BINARY_MAX_BYTES = 64 * 1024;
const DEFAULT_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_SSE_HEARTBEAT_MS = 15 * 1000;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const TRANSPORT_KINDS = Object.freeze(['json', 'binary', 'upload', 'download', 'sse']);

function transportError(message, status = 400, details = null) {
  return new CoreError(codes.INVALID_INPUT, message, { status, details });
}

function normalizeTransport(route) {
  const declared = route && route.transport ? route.transport : {};
  const kind = declared.kind || 'json'; // 迁移期旧路由只能按 JSON 解释。
  if (!TRANSPORT_KINDS.includes(kind)) {
    throw transportError(`未知 HTTP transport: ${kind}`, 500);
  }
  const defaults = {
    json: DEFAULT_JSON_MAX_BYTES,
    binary: DEFAULT_BINARY_MAX_BYTES,
    upload: DEFAULT_UPLOAD_MAX_BYTES
  };
  const maxBytes = declared.maxBytes === undefined ? defaults[kind] : declared.maxBytes;
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw transportError('transport.maxBytes 必须是非负安全整数', 500);
  }
  if (declared.timeoutMs !== undefined && (!Number.isSafeInteger(declared.timeoutMs) || declared.timeoutMs <= 0)) {
    throw transportError('transport.timeoutMs 必须是正安全整数', 500);
  }
  if (declared.accepts !== undefined && (!Array.isArray(declared.accepts) || declared.accepts.some((v) => typeof v !== 'string'))) {
    throw transportError('transport.accepts 必须是 MIME 字符串数组', 500);
  }
  return {
    ...declared,
    kind,
    maxBytes,
    heartbeatMs: declared.heartbeatMs === undefined ? DEFAULT_SSE_HEARTBEAT_MS : declared.heartbeatMs
  };
}

function contentLength(req) {
  const raw = req.headers['content-length'];
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function assertContentLength(req, maxBytes) {
  const length = contentLength(req);
  if (length !== null && maxBytes !== undefined && length > maxBytes) {
    req.resume(); // 消耗剩余请求，使 413 响应可正常收敛并允许连接复用。
    throw transportError('请求体过大', 413);
  }
}

function mimeMatches(actual, accepted) {
  const expected = accepted.toLowerCase();
  if (expected === '*' || expected === '*/*') return true;
  if (expected.endsWith('/*')) return actual.startsWith(expected.slice(0, -1));
  return actual === expected;
}

function assertAccepted(req, accepts) {
  if (!accepts || accepts.length === 0) return;
  const actual = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (!actual || !accepts.some((accepted) => mimeMatches(actual, accepted))) {
    req.resume();
    throw transportError('不支持的 Content-Type', 415);
  }
}

/** 有界读取小对象；超限后不再累积 chunk，并排空请求以返回确定的 413。 */
function readBoundedBody(req, { maxBytes, json }) {
  assertContentLength(req, maxBytes);
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];

    function cleanup() {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
    }
    function finish(error, value) {
      if (done) return;
      done = true;
      cleanup();
      if (error) {
        chunks.length = 0;
        req.resume();
        reject(error);
      } else {
        resolve(value);
      }
    }
    function onData(chunk) {
      size += chunk.length;
      if (size > maxBytes) {
        finish(transportError('请求体过大', 413));
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      const buffer = Buffer.concat(chunks);
      if (!json) return finish(null, buffer);
      if (buffer.length === 0) return finish(null, {});
      try {
        finish(null, JSON.parse(buffer.toString('utf8')));
      } catch {
        finish(transportError('请求体不是合法 JSON', 400));
      }
    }
    function onError(error) { finish(error); }
    function onAborted() { finish(transportError('请求已中断', 400)); }

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
}

function createRequestLifecycle(req, res, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const onAborted = () => controller.abort(transportError('请求已中断', 400));
  const onClose = () => {
    if (!res.writableFinished) onAborted();
  };
  req.once('aborted', onAborted);
  res.once('close', onClose);
  const timer = timeoutMs ? setTimeout(() => {
    timedOut = true;
    controller.abort(transportError('请求处理超时', 408));
  }, timeoutMs) : null;
  if (timer) timer.unref();
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    finish() {
      if (timer) clearTimeout(timer);
      req.removeListener('aborted', onAborted);
      res.removeListener('close', onClose);
    }
  };
}

function createUploadStream(req, maxBytes, signal) {
  let received = 0;
  const limited = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) return callback(transportError('请求体过大', 413));
      callback(null, chunk);
    }
  });
  const onRequestError = (error) => limited.destroy(error);
  const onAbort = () => {
    const reason = signal.reason || transportError('请求已中断', 400);
    limited.destroy(reason);
    req.destroy(reason);
  };
  req.once('error', onRequestError);
  limited.once('close', () => {
    req.removeListener('error', onRequestError);
    signal.removeEventListener('abort', onAbort);
  });
  limited.once('error', () => {
    req.unpipe(limited);
    if (!req.destroyed) req.resume();
  });
  signal.addEventListener('abort', onAbort, { once: true });
  req.pipe(limited);
  return limited;
}

function handled(result, res) {
  return Boolean((result && result.handled === true) || res.headersSent || res.writableEnded || res.destroyed);
}

function resultStatus(result) {
  return result && Number.isInteger(result.status) ? result.status : 200;
}

function sendJson(res, status, payload, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  });
  res.end(body);
}

function sendJsonResult(res, result) {
  if (handled(result, res)) return;
  sendJson(res, resultStatus(result), result && result.body !== undefined ? result.body : {}, result && result.headers);
}

function sendBinaryResult(res, result) {
  if (handled(result, res)) return;
  const direct = Buffer.isBuffer(result) || result instanceof Uint8Array;
  const body = direct ? result : result && result.body;
  if (!Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
    throw transportError('binary handler 必须返回 Buffer 或 Uint8Array', 500);
  }
  const headers = direct ? {} : result.headers;
  const contentType = direct ? 'application/octet-stream' : result.contentType || 'application/octet-stream';
  res.writeHead(resultStatus(result), {
    'content-type': contentType,
    'content-length': body.byteLength,
    ...headers
  });
  res.end(body);
}

/** 仅接受单个 bytes 区间。返回 null 表示无 Range；无效/不可满足返回 false。 */
function parseRange(header, size) {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || size === 0) return false;
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    if (!Number.isSafeInteger(start)) return false;
    if (match[2] === '') end = size - 1;
    else {
      end = Number(match[2]);
      if (!Number.isSafeInteger(end) || end < start) return false;
      end = Math.min(end, size - 1);
    }
    if (start >= size) return false;
  }
  return { start, end, length: end - start + 1 };
}

async function* sliceStream(source, start, length) {
  let skip = start;
  let remaining = length;
  try {
    for await (const chunk of source) {
      let offset = 0;
      if (skip > 0) {
        if (chunk.length <= skip) {
          skip -= chunk.length;
          continue;
        }
        offset = skip;
        skip = 0;
      }
      const take = Math.min(remaining, chunk.length - offset);
      if (take > 0) {
        yield offset === 0 && take === chunk.length ? chunk : chunk.subarray(offset, offset + take);
        remaining -= take;
      }
      if (remaining === 0) return;
    }
    if (remaining !== 0) throw transportError('下载流长度与声明不符', 500);
  } finally {
    // Range 通常在源 EOF 前结束；显式关闭源流，尤其 FileHandle.createReadStream。
    if (source && typeof source.destroy === 'function') source.destroy();
  }
}

function sendRangeNotSatisfiable(res, size) {
  sendJson(res, 416, {
    code: codes.INVALID_INPUT,
    message: 'Range 不可满足',
    details: null
  }, { 'accept-ranges': 'bytes', 'content-range': `bytes */${size}` });
}

async function sendDownloadResult(req, res, result, signal) {
  if (handled(result, res)) return;
  // 下载路由的错误（403/404/410/416 等）以普通 JSON 结果返回时，不能被误判为 500。
  if (result && !result.stream && Number.isInteger(result.status) && result.status >= 400) {
    sendJsonResult(res, result);
    return;
  }
  const source = result && result.stream;
  const size = result && result.size;
  if (!source || typeof source[Symbol.asyncIterator] !== 'function' || !Number.isSafeInteger(size) || size < 0) {
    if (source && typeof source.destroy === 'function') source.destroy();
    throw transportError('download handler 必须返回异步可读 stream 与非负 size', 500);
  }
  const range = parseRange(req.headers.range, size);
  const baseHeaders = {
    'content-type': result.contentType || result.type || 'application/octet-stream',
    'accept-ranges': 'bytes',
    ...(result.etag ? { etag: result.etag } : {}),
    ...(result.contentDisposition ? { 'content-disposition': result.contentDisposition } : {}),
    ...(result.headers || {})
  };
  if (range === false) {
    if (typeof source.destroy === 'function') source.destroy();
    if (typeof result.close === 'function') await result.close();
    sendRangeNotSatisfiable(res, size);
    return;
  }
  const length = range ? range.length : size;
  res.writeHead(range ? 206 : 200, {
    ...baseHeaders,
    'content-length': length,
    ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${size}` } : {})
  });
  if (req.method === 'HEAD' || length === 0) {
    if (typeof source.destroy === 'function') source.destroy();
    if (typeof result.close === 'function') await result.close();
    res.end();
    return;
  }
  const input = range
    ? Readable.from(sliceStream(source, range.start, range.length))
    : source;
  try {
    await pipeline(input, res, { signal });
  } finally {
    if (typeof result.close === 'function') await result.close();
  }
}

function eventText(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value);
}

function singleLine(value, name) {
  const text = String(value);
  if (/[\r\n]/.test(text)) throw transportError(`SSE ${name} 不能包含换行`, 500);
  return text;
}

class SseWriter {
  constructor(req, res, signal) {
    this.res = res;
    this.signal = signal;
    const previous = String(req.headers['last-event-id'] || '');
    this.sequence = /^\d+$/.test(previous) ? Number(previous) : 0;
  }

  write(frame) {
    if (this.signal.aborted) return Promise.reject(this.signal.reason);
    if (this.res.destroyed || this.res.writableEnded) {
      return Promise.reject(transportError('SSE 响应已关闭', 400));
    }
    if (this.res.write(frame)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.res.removeListener('drain', onDrain);
        this.res.removeListener('close', onClose);
        this.res.removeListener('error', onError);
        this.signal.removeEventListener('abort', onAbort);
      };
      const onDrain = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(transportError('SSE 客户端已关闭', 400)); };
      const onError = (error) => { cleanup(); reject(error); };
      const onAbort = () => { cleanup(); reject(this.signal.reason); };
      this.res.once('drain', onDrain);
      this.res.once('close', onClose);
      this.res.once('error', onError);
      this.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  send(event, data) {
    const spec = event && typeof event === 'object' && !Buffer.isBuffer(event) && data === undefined
      ? event
      : { event, data };
    const id = spec.id === undefined ? String(++this.sequence) : singleLine(spec.id, 'id');
    let frame = `id: ${id}\n`;
    if (spec.event !== undefined && spec.event !== null) frame += `event: ${singleLine(spec.event, 'event')}\n`;
    if (spec.retry !== undefined) frame += `retry: ${singleLine(spec.retry, 'retry')}\n`;
    for (const line of eventText(spec.data).split(/\r?\n/)) frame += `data: ${line}\n`;
    return this.write(frame + '\n');
  }

  heartbeat() {
    return this.write(': heartbeat\n\n');
  }
}

function asyncEvents(result) {
  if (result && typeof result[Symbol.asyncIterator] === 'function') return result;
  if (result && result.events && typeof result.events[Symbol.asyncIterator] === 'function') return result.events;
  return null;
}

async function runSse(route, context, transport) {
  const { req, res } = context;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-content-type-options': 'nosniff'
  });
  res.flushHeaders();
  const writer = new SseWriter(req, res, context.signal);
  context.sse = writer;
  const heartbeatMs = transport.heartbeatMs;
  let heartbeatWaiting = false;
  const heartbeat = heartbeatMs > 0 ? setInterval(() => {
    if (heartbeatWaiting) return;
    heartbeatWaiting = true;
    writer.heartbeat().catch(() => {
      if (!res.destroyed) res.destroy();
    }).finally(() => { heartbeatWaiting = false; });
  }, heartbeatMs) : null;
  if (heartbeat) heartbeat.unref();
  try {
    const result = await route.handler(context);
    if (handled(result, res) && result && result.handled === true) return result;
    const events = asyncEvents(result);
    if (events) {
      for await (const event of events) await writer.send(event);
    }
    if (!res.writableEnded && !res.destroyed) res.end();
    return result;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

/** 在公共宿主中执行一个已匹配的模块路由。 */
async function dispatchModuleRoute(route, context) {
  const transport = normalizeTransport(route);
  const { req, res } = context;
  const lifecycle = createRequestLifecycle(req, res, transport.timeoutMs);
  const ctx = { ...context, body: {}, signal: lifecycle.signal, transport };
  try {
    if (transport.kind === 'upload' || BODY_METHODS.has(req.method || 'GET')) {
      assertContentLength(req, transport.maxBytes);
      assertAccepted(req, transport.accepts);
    }
    if (transport.kind === 'sse') {
      return await runSse(route, ctx, transport);
    }
    if (transport.kind === 'json' && BODY_METHODS.has(req.method || 'GET')) {
      ctx.body = await readBoundedBody(req, { maxBytes: transport.maxBytes, json: true });
    } else if (transport.kind === 'binary' && BODY_METHODS.has(req.method || 'GET')) {
      ctx.body = await readBoundedBody(req, { maxBytes: transport.maxBytes, json: false });
    } else if (transport.kind === 'upload') {
      ctx.body = createUploadStream(req, transport.maxBytes, lifecycle.signal);
      ctx.stream = ctx.body;
    }
    const result = await route.handler(ctx);
    if (transport.kind === 'download') {
      await sendDownloadResult(req, res, result, lifecycle.signal);
    } else if (transport.kind === 'binary') {
      sendBinaryResult(res, result);
    } else {
      sendJsonResult(res, result);
    }
    if (transport.kind === 'upload' && !req.readableEnded && !req.destroyed) req.resume();
    return result;
  } catch (error) {
    if (lifecycle.signal.aborted && lifecycle.timedOut && !(error instanceof CoreError)) {
      throw transportError('请求处理超时', 408);
    }
    throw error;
  } finally {
    lifecycle.finish();
  }
}

module.exports = {
  DEFAULT_JSON_MAX_BYTES,
  DEFAULT_BINARY_MAX_BYTES,
  DEFAULT_UPLOAD_MAX_BYTES,
  TRANSPORT_KINDS,
  SseWriter,
  createUploadStream,
  dispatchModuleRoute,
  normalizeTransport,
  parseRange,
  readBoundedBody,
  sendJson,
  sendJsonResult
};
