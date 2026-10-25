#!/usr/bin/env node
'use strict';
// Pages 模块独立开发服务器（仅本地调试，不是生产入口）。
//
// 用法：
//   node modules/pages/server/dev.js                 # 监听 127.0.0.1:0 并常驻
//   node modules/pages/server/dev.js --once          # 监听成功后打印 URL 并立即退出（冒烟）
//   node modules/pages/server/dev.js --data-file /tmp/pages.json
//
// 输出：第一行严格为 {"url":"http://127.0.0.1:PORT"}。
//
// 认证说明：本脚本不是认证服务。它只把请求头 x-pages-user-id 当作开发用户；
// 生产由公共核心在挂载模块路由时注入已认证的 user。没有该头时 user=null，
// 因此所有写操作都会按契约返回 403，公开路由仍然可读。

const http = require('node:http');

const pages = require('./index.js');

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const compiledCache = new WeakMap();

function compile(pattern) {
  return String(pattern)
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      if (segment === '*') return { wildcard: true };
      if (segment.startsWith(':')) return { param: segment.slice(1) };
      return { literal: segment };
    });
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch (err) {
    return null;
  }
}

function match(route, pathname) {
  let compiled = compiledCache.get(route);
  if (!compiled) {
    compiled = compile(route.path);
    compiledCache.set(route, compiled);
  }
  const parts = pathname.split('/').slice(1);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();

  const params = {};
  let index = 0;
  for (const segment of compiled) {
    if (segment.wildcard) {
      const rest = parts.slice(index).map(decode);
      if (rest.some((value) => value === null)) return null;
      params.wildcard = rest.join('/');
      params.filePath = params.wildcard;
      return params;
    }
    if (index >= parts.length) return null;
    const value = decode(parts[index]);
    if (value === null) return null;
    if (segment.param) {
      params[segment.param] = value;
    } else if (segment.literal !== value) {
      return null;
    }
    index += 1;
  }
  return index === parts.length ? params : null;
}

function devUser(req) {
  const raw = req.headers['x-pages-user-id'];
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return { id, username: id, role: 'user', dev: true };
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const err = new Error('请求体过大');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        const error = new Error('请求体不是合法 JSON');
        error.status = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function safeHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[a-z0-9-]+$/i.test(name)) continue;
    const text = String(value);
    if (/[\r\n]/.test(text)) continue;
    out[name.toLowerCase()] = text;
  }
  return out;
}

function sendResult(res, result) {
  const status = result && Number.isInteger(result.status) ? result.status : 200;
  const headers = safeHeaders(result && result.headers);
  const body = result ? result.body : undefined;
  if (Buffer.isBuffer(body) || typeof body === 'string') {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    res.writeHead(status, {
      'content-type': headers['content-type'] || 'text/plain; charset=utf-8',
      'content-length': payload.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers
    });
    res.end(payload);
    return;
  }
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers
  });
  res.end(payload);
}

async function handle(req, res) {
  const method = String(req.method || 'GET').toUpperCase();
  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch (err) {
    return sendResult(res, { status: 400, body: { code: 'INVALID_INPUT', message: '请求 URL 不合法' } });
  }

  let matched = null;
  let params = null;
  for (const route of pages.routes) {
    if (String(route.method || '').toUpperCase() !== method) continue;
    const candidate = match(route, url.pathname);
    if (candidate) {
      matched = route;
      params = candidate;
      break;
    }
  }
  if (!matched) {
    return sendResult(res, { status: 404, body: { code: 'NOT_FOUND', message: '接口不存在' } });
  }

  let body = {};
  if (WRITE_METHODS.has(method)) {
    try {
      body = await readBody(req);
    } catch (err) {
      return sendResult(res, {
        status: err.status || 400,
        body: { code: 'INVALID_INPUT', message: err.message }
      });
    }
  }

  const ctx = {
    req,
    res,
    url,
    params,
    query: Object.fromEntries(url.searchParams.entries()),
    body,
    user: devUser(req)
  };

  try {
    return sendResult(res, await matched.handler(ctx));
  } catch (err) {
    return sendResult(res, { status: 500, body: { code: 'INTERNAL', message: '内部错误' } });
  }
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

async function main() {
  const once = process.argv.includes('--once');
  const dataFile = argumentValue('--data-file') || process.env.PAGESAI_PAGES_DATA_FILE || null;

  // 日志统一走 stderr，保证 stdout 第一行只承载 {"url":...} 这一条机器可读输出。
  const logger = {
    info(message) { process.stderr.write(`[pages-dev] ${message}\n`); },
    warn(message) { process.stderr.write(`[pages-dev] ${message}\n`); },
    error(message) { process.stderr.write(`[pages-dev] ${message}\n`); }
  };
  await pages.start({ config: { dataFile }, logger });
  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendResult(res, { status: 500, body: { code: 'INTERNAL', message: '内部错误' } });
      else res.end();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const url = `http://${address.address}:${address.port}`;
  process.stdout.write(`${JSON.stringify({ url })}\n`);

  if (once) {
    await new Promise((resolve) => server.close(resolve));
    await pages.stop();
    process.exit(0);
  }

  const shutdown = async () => {
    await new Promise((resolve) => server.close(resolve));
    await pages.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(async (err) => {
  try {
    await pages.stop();
  } catch (stopError) {
    // 忽略停止阶段的二次错误
  }
  process.stderr.write(`${JSON.stringify({ error: err && err.message ? err.message : 'start failed' })}\n`);
  process.exit(1);
});
