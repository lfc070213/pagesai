#!/usr/bin/env node
'use strict';
// Paper 模块本地开发服务器（只用 node:http）。
//
// 用途：把 server/index.js 的 routes 挂到真实 HTTP 上，监听 127.0.0.1:0（随机端口），
//       stdout 只打印一行 {"url":"http://127.0.0.1:PORT"}，其余日志走 stderr。
//
// 参数：
//   --once            启动并打印 URL 后立即退出（冒烟检查，不接收请求）
//   --data <file>     JsonStore 数据文件；不给则纯内存
//   --uploads <dir>   上传原件目录；不给时若给了 --data 则用其同级 uploads/，否则纯内存
//   --help            打印用法
//
// 身份：本地开发没有核心身份服务，默认 user={id:'dev-user'}；
//       传请求头 x-dev-user: alice 可切换用户，x-dev-user: anonymous 表示未登录（用于验证 403）。

const http = require('node:http');
const path = require('node:path');
const paper = require('./index.js');

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function usage() {
  return [
    '用法: node server/dev.js [--once] [--data <file>] [--uploads <dir>]',
    '',
    '选项:',
    '  --once          打印 URL 后立即退出',
    '  --data <file>   JsonStore 数据文件（默认纯内存）',
    '  --uploads <dir> 上传原件目录（默认内存或 data 同级 uploads/）',
    '  --help          显示帮助',
    '',
    '请求头 x-dev-user 可切换开发用户；anonymous 表示未登录。'
  ].join('\n');
}

function parseArgs(argv) {
  const options = { once: false, dataFile: null, uploadsDir: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--once') options.once = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--data') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--data 需要一个文件路径');
      options.dataFile = path.resolve(value);
      i += 1;
    } else if (arg === '--uploads') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--uploads 需要一个目录路径');
      options.uploadsDir = path.resolve(value);
      i += 1;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return options;
}

function safeWrite(text) {
  return new Promise((resolve) => {
    process.stdout.write(text, () => resolve());
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  if (res.writableEnded) return;
  const text = JSON.stringify(body === undefined ? null : body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text)
  });
  res.end(text);
}

function matchRoute(routePath, pathname) {
  const names = [];
  const pattern = '^' + routePath
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z0-9_]+)/g, (all, name) => {
      names.push(name);
      return '([^/]+)';
    }) + '$';
  const match = new RegExp(pattern).exec(pathname);
  if (!match) return null;
  const params = {};
  names.forEach((name, index) => {
    params[name] = decodeURIComponent(match[index + 1]);
  });
  return params;
}

function userOf(req) {
  const header = req.headers['x-dev-user'];
  const value = Array.isArray(header) ? header[0] : header;
  const name = typeof value === 'string' && value.trim() ? value.trim() : 'dev-user';
  if (name === 'anonymous' || name === 'none') return null;
  return { id: name, username: name, role: 'user' };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const config = {};
  if (options.dataFile) config.dataFile = options.dataFile;
  if (options.uploadsDir) config.uploadsDir = options.uploadsDir;

  const logger = {
    info: (...args) => process.stderr.write(`${args.join(' ')}\n`),
    warn: (...args) => process.stderr.write(`${args.join(' ')}\n`),
    error: (...args) => process.stderr.write(`${args.join(' ')}\n`)
  };

  await paper.start({ config, logger });

  const server = http.createServer((req, res) => {
    const handle = async () => {
      let url;
      try {
        url = new URL(req.url || '/', 'http://127.0.0.1');
      } catch {
        return send(res, 400, { code: 'INVALID_INPUT', message: '请求 URL 非法' });
      }
      const route = paper.routes.find((item) => item.method === (req.method || 'GET') && matchRoute(item.path, url.pathname));
      if (!route) {
        return send(res, 404, { code: 'NOT_FOUND', message: '接口不存在' });
      }
      const params = matchRoute(route.path, url.pathname) || {};
      let body = {};
      try {
        body = await readBody(req);
      } catch (err) {
        return send(res, 400, { code: 'INVALID_INPUT', message: err.message });
      }
      const ctx = {
        req,
        res,
        url,
        params,
        query: Object.fromEntries(url.searchParams.entries()),
        body,
        user: userOf(req)
      };
      try {
        const out = await route.handler(ctx);
        return send(res, out && out.status ? out.status : 200, out ? out.body : null);
      } catch (err) {
        return send(res, 500, { code: 'INTERNAL', message: '内部错误' });
      }
    };
    handle().catch(() => send(res, 500, { code: 'INTERNAL', message: '内部错误' }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  await safeWrite(`${JSON.stringify({ url })}\n`);

  if (options.once) {
    await paper.stop();
    await new Promise((resolve) => server.close(resolve));
    return;
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await paper.stop();
    await new Promise((resolve) => server.close(resolve));
  };
  process.on('SIGINT', () => { shutdown().then(() => { process.exitCode = 0; }); });
  process.on('SIGTERM', () => { shutdown().then(() => { process.exitCode = 0; }); });
}

main().catch((err) => {
  process.stderr.write(`[paper-dev] 启动失败: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
