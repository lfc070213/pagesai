'use strict';
// Survey 模块独立开发服务器。
//
// 用途：把 server/index.js 导出的 /api/survey/** 路由挂到 node:http，监听 127.0.0.1:0，
// 让模块在没有公共核心 HTTP 外壳时也能单独试跑。它不是生产入口：
//  - 默认纯内存数据；设置 --data-file <path> 或 PAGESAI_SURVEY_DATA_FILE 才落盘；
//  - 通过 x-user-id / x-user-name / x-user-role 头模拟已认证用户，仅用于本地调试；
//  - 错误统一输出 {code,message}。
//
// 用法：
//   node server/dev.js
//   node server/dev.js --once
//   node server/dev.js --data-file /tmp/survey.json
//
// 启动成功后 stdout 只输出一行 {"url":"http://127.0.0.1:PORT"}。
// --once：打印该行后立即优雅退出（便于脚本探测模块能否启动）。

const http = require('node:http');
const { start, stop, routes } = require('./index.js');

const MAX_BODY_BYTES = 16 * 1024 * 1024;

function argValue(args, name) {
  const equals = args.find((item) => item.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0 && index + 1 < args.length && !args[index + 1].startsWith('--')) return args[index + 1];
  return null;
}

function matchPath(pattern, pathname) {
  const patternParts = pattern.split('/');
  const actualParts = pathname.split('/');
  if (patternParts.length !== actualParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const expected = patternParts[i];
    const actual = actualParts[i];
    if (expected.startsWith(':')) {
      if (!actual) return null;
      try {
        params[expected.slice(1)] = decodeURIComponent(actual);
      } catch {
        return null;
      }
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

function matchRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPath(route.path, pathname);
    if (params) return { route, params };
  }
  return null;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(Object.assign(new Error('请求体过大'), { status: 413, code: 'INVALID_INPUT' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (chunks.length === 0) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400, code: 'INVALID_INPUT' }));
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function writeResult(res, result) {
  const status = result && Number.isInteger(result.status) ? result.status : 200;
  const headers = { 'cache-control': 'no-store', ...(result && result.headers) };
  if (result && typeof result.body === 'string') {
    headers['content-type'] = result.contentType || 'text/plain; charset=utf-8';
    res.writeHead(status, headers);
    res.end(result.body);
    return;
  }
  headers['content-type'] = 'application/json; charset=utf-8';
  res.writeHead(status, headers);
  res.end(JSON.stringify(result ? result.body : null));
}

function devUser(req) {
  const rawId = req.headers['x-user-id'];
  if (!rawId) return null;
  const id = String(Array.isArray(rawId) ? rawId[0] : rawId).trim();
  if (!id) return null;
  const rawRole = req.headers['x-user-role'];
  const role = String(Array.isArray(rawRole) ? rawRole[0] : rawRole || '').toLowerCase() === 'admin' ? 'admin' : 'user';
  const rawName = req.headers['x-user-name'];
  return {
    id,
    username: rawName ? String(Array.isArray(rawName) ? rawName[0] : rawName) : id,
    role
  };
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const dataFile = argValue(args, '--data-file') || process.env.PAGESAI_SURVEY_DATA_FILE || null;

  // 日志走 stderr，保证 stdout 只有一行可被脚本解析的 URL。
  const logger = {
    info(message) { if (!once) process.stderr.write(`${message}\n`); },
    warn(message) { process.stderr.write(`${message}\n`); },
    error(message) { process.stderr.write(`${message}\n`); }
  };

  await start({ config: { dataFile }, logger });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
      const matched = matchRoute(String(req.method || 'GET').toUpperCase(), pathname);
      if (!matched) {
        writeResult(res, { status: 404, body: { code: 'NOT_FOUND', message: '接口不存在' } });
        return;
      }
      const body = ['POST', 'PUT', 'PATCH'].includes(String(req.method || '').toUpperCase())
        ? await readJson(req)
        : {};
      const result = await matched.route.handler({
        req,
        res,
        url,
        params: matched.params,
        query: Object.fromEntries(url.searchParams.entries()),
        body,
        user: devUser(req)
      });
      writeResult(res, result);
    } catch (err) {
      writeResult(res, {
        status: Number.isInteger(err && err.status) ? err.status : 500,
        body: {
          code: (err && err.code) || 'INTERNAL_ERROR',
          message: (err && err.status ? err.message : '内部错误')
        }
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${address.port}` })}\n`);

  if (once) {
    await new Promise((resolve) => server.close(resolve));
    await stop();
    return;
  }

  const shutdown = async () => {
    await new Promise((resolve) => server.close(resolve));
    await stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`[survey-dev] ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
