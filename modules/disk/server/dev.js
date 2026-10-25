'use strict';
// PagesAI 公开版 · Disk 模块开发服务器
//
// 用途：把 modules/disk/server/index.js 导出的 routes 挂到 node:http，供本机联调。
// 启动：node modules/disk/server/dev.js [--once] [--data-file <path>] [--help]
// 行为：监听 127.0.0.1:0，stdout 只打印一行 {"url":"http://127.0.0.1:PORT"}；
//       --once 打印后关闭服务并退出（便于 CI/冒烟脚本确认入口可用）。
//
// 开发态身份：请求头 x-dev-user 或 x-dev-user-id 提供当前用户 ID；
//             缺省为 null（因此所有写操作按契约返回 403）。生产装配不得使用本文件。
//
// 环境变量：DISK_DATA_FILE、DISK_REGIONS、DISK_QUOTA_BYTES、DISK_CHUNK_BYTES、
//           DISK_MAX_CHUNK_BYTES、DISK_MAX_FILE_BYTES、DISK_STORAGE_ADAPTER。

const http = require('node:http');

const { CoreError, codes } = require('../../../core/errors');
const disk = require('./index.js');

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

function hasHeader(headers, name) {
  const lower = String(name).toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function sendResult(res, result, options = {}) {
  const status = result && Number.isInteger(result.status) ? result.status : 200;
  const headers = {};
  if (result && result.headers && typeof result.headers === 'object') {
    for (const [key, value] of Object.entries(result.headers)) {
      if (value !== undefined && value !== null) headers[key] = String(value);
    }
  }
  const body = result && result.body !== undefined ? result.body : {};

  if (Buffer.isBuffer(body)) {
    if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/octet-stream';
    if (!hasHeader(headers, 'content-length')) headers['content-length'] = String(body.length);
    res.writeHead(status, headers);
    res.end(options.head ? undefined : body);
    return;
  }

  const text = typeof body === 'string' ? body : JSON.stringify(body);
  if (!hasHeader(headers, 'content-type')) {
    headers['content-type'] = typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8';
  }
  if (!hasHeader(headers, 'cache-control')) headers['cache-control'] = 'no-store';
  headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(options.head ? undefined : text);
}

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish(reject, new CoreError(codes.INVALID_INPUT, '请求体过大', { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks)));
    req.on('error', (err) => finish(reject, err));
  });
}

function parseBody(buffer, contentType) {
  if (!buffer || buffer.length === 0) return {};
  const type = String(contentType || '').toLowerCase();
  const first = buffer.subarray(0, 1).toString('utf8');
  const looksJson = first === '{' || first === '[';
  if (type.includes('application/json') || (!type && looksJson)) {
    try {
      return JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new CoreError(codes.INVALID_INPUT, '请求体不是合法 JSON', { status: 400 });
    }
  }
  return buffer;
}

function devUser(req) {
  const raw = req.headers['x-dev-user'];
  const idHeader = req.headers['x-dev-user-id'];
  if (typeof raw === 'string' && raw.trim()) {
    const text = raw.trim();
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new CoreError(codes.INVALID_INPUT, 'x-dev-user 必须是 JSON 对象或用户 ID', { status: 400 });
        }
        return parsed;
      } catch (err) {
        if (err instanceof CoreError) throw err;
        throw new CoreError(codes.INVALID_INPUT, 'x-dev-user 不是合法 JSON', { status: 400 });
      }
    }
    return { id: text, username: text };
  }
  if (typeof idHeader === 'string' && idHeader.trim()) {
    return { id: idHeader.trim(), username: idHeader.trim() };
  }
  return null;
}

function segmentsOf(pathname) {
  return String(pathname || '/')
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new CoreError(codes.INVALID_INPUT, 'URL 编码无效', { status: 400 });
      }
    });
}

/** 极简路由匹配：只支持 :param 占位符，与模块导出的 routes 定义一致。 */
function matchRoute(method, pathname) {
  const upper = String(method || 'GET').toUpperCase();
  const wanted = upper === 'HEAD' ? 'GET' : upper;
  const actual = segmentsOf(pathname);
  for (const route of disk.routes) {
    if (String(route.method).toUpperCase() !== wanted) continue;
    const pattern = String(route.path).split('/').filter((segment) => segment.length > 0);
    if (pattern.length !== actual.length) continue;
    const params = {};
    let matched = true;
    for (let index = 0; index < pattern.length; index += 1) {
      const part = pattern[index];
      if (part.startsWith(':')) {
        params[part.slice(1)] = actual[index];
      } else if (part !== actual[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params, head: upper === 'HEAD' };
  }
  return null;
}

function parseArgs(argv = []) {
  const options = { once: false, help: false, dataFile: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index]);
    if (argument === '--once') {
      options.once = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--data-file') {
      const value = argv[index + 1];
      if (!value || String(value).startsWith('--')) {
        throw new CoreError(codes.CONFIG_INVALID, '--data-file 需要一个路径参数', { status: 500 });
      }
      options.dataFile = String(value);
      index += 1;
    } else if (argument.startsWith('--data-file=')) {
      const value = argument.slice('--data-file='.length);
      if (!value) throw new CoreError(codes.CONFIG_INVALID, '--data-file 需要一个路径参数', { status: 500 });
      options.dataFile = value;
    } else {
      throw new CoreError(codes.CONFIG_INVALID, `未知参数 ${argument}，使用 --help 查看用法`, { status: 500 });
    }
  }
  return options;
}

function configFromEnv(env = process.env) {
  const config = {};
  if (typeof env.DISK_DATA_FILE === 'string' && env.DISK_DATA_FILE.trim()) {
    config.dataFile = env.DISK_DATA_FILE.trim();
  }
  if (typeof env.DISK_REGIONS === 'string' && env.DISK_REGIONS.trim()) {
    config.regions = env.DISK_REGIONS.split(',').map((item) => item.trim()).filter(Boolean);
  }
  for (const [envName, field] of [
    ['DISK_QUOTA_BYTES', 'quotaBytes'],
    ['DISK_CHUNK_BYTES', 'chunkSizeBytes'],
    ['DISK_MAX_CHUNK_BYTES', 'maxChunkBytes'],
    ['DISK_MAX_FILE_BYTES', 'maxFileBytes']
  ]) {
    if (typeof env[envName] === 'string' && env[envName].trim()) {
      const value = Number(env[envName]);
      if (!Number.isInteger(value) || value < 0) {
        throw new CoreError(codes.CONFIG_INVALID, `${envName} 必须是整数`, { status: 500 });
      }
      config[field] = value;
    }
  }
  if (typeof env.DISK_STORAGE_ADAPTER === 'string' && env.DISK_STORAGE_ADAPTER.trim()) {
    config.storageAdapter = env.DISK_STORAGE_ADAPTER.trim();
  }
  return config;
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://${HOST}`);
  const raw = await readRawBody(req, MAX_BODY_BYTES);
  const body = parseBody(raw, req.headers['content-type']);
  const match = matchRoute(req.method, url.pathname);
  if (!match) {
    sendResult(res, { status: 404, body: { code: 'NOT_FOUND', message: '路由不存在' } });
    return;
  }
  const ctx = {
    req,
    res,
    url,
    params: match.params,
    query: Object.fromEntries(url.searchParams.entries()),
    body,
    user: devUser(req)
  };
  const result = await match.route.handler(ctx);
  sendResult(res, result, { head: match.head });
}

function createDevServer() {
  return http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      if (err instanceof CoreError) {
        sendResult(res, { status: err.status, body: { code: err.code, message: err.message } });
        return;
      }
      console.error('[disk-dev] 请求处理失败', err);
      sendResult(res, { status: 500, body: { code: 'INTERNAL_ERROR', message: '内部错误' } });
    });
  });
}

function usage() {
  return [
    '用法: node modules/disk/server/dev.js [--once] [--data-file <path>] [--help]',
    '',
    '  --once             监听 127.0.0.1:0 并打印 {"url":"http://127.0.0.1:PORT"} 后退出',
    '  --data-file <path> 指定 JsonStore 数据文件（覆盖 DISK_DATA_FILE）',
    '  --help             显示本帮助',
    '',
    '开发态身份头: x-dev-user: <id> 或 x-dev-user: {"id":"u1","username":"alice"}',
    '环境变量: DISK_DATA_FILE DISK_REGIONS DISK_QUOTA_BYTES DISK_CHUNK_BYTES',
    '          DISK_MAX_CHUNK_BYTES DISK_MAX_FILE_BYTES DISK_STORAGE_ADAPTER'
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const once = options.once;
  const config = configFromEnv();
  if (options.dataFile) config.dataFile = options.dataFile;
  const logger = {
    info(message) { console.error(String(message)); },
    warn(message) { console.error(String(message)); },
    error(message, err) { console.error(String(message), err || ''); }
  };
  await disk.start({ config, logger });
  const server = createDevServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, resolve);
  });
  const address = server.address();
  const url = `http://${HOST}:${address.port}`;
  process.stdout.write(`${JSON.stringify({ url })}\n`);

  if (once) {
    await new Promise((resolve) => server.close(resolve));
    await disk.stop();
    return;
  }

  console.error('[disk-dev] 按 Ctrl+C 停止；写请求需带 x-dev-user 头');
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.error(`[disk-dev] 收到 ${signal}，正在停止`);
    await new Promise((resolve) => server.close(resolve));
    await disk.stop();
    process.exitCode = 0;
  };
  process.once('SIGINT', () => { shutdown('SIGINT').catch((err) => { console.error(err); process.exitCode = 1; }); });
  process.once('SIGTERM', () => { shutdown('SIGTERM').catch((err) => { console.error(err); process.exitCode = 1; }); });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[disk-dev] 启动失败', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}

module.exports = { main, createDevServer, matchRoute, configFromEnv, parseArgs };
