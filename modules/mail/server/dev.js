'use strict';
// Mail 模块开发服务器：把 server/index.js 导出的 routes 挂到 node:http。
//
// 用途：本地手工联调（不是生产入口）。监听 127.0.0.1:0，启动后向 stdout 打印
// {"url":"http://127.0.0.1:PORT"}；带 --once 时打印 URL 后立即退出。
//
// 认证说明：开发服务器不实现登录。请求头 x-dev-user（或 Authorization: Bearer <id>）
// 会被当作当前用户 ID；不提供时 user 为 null，所有需要登录的写操作仍返回 403。
//
// 用法：
//   node modules/mail/server/dev.js
//   node modules/mail/server/dev.js --once
//   node modules/mail/server/dev.js --config ./mail-config.json
//
// 配置 JSON 可表达 from、userSendEnabled、dataFile，以及 provider=smtp/imap 的内置适配器字段；
// 函数型 sendMail 或 imap 适配器仍只能由部署代码注入。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const mailModule = require('./index.js');
const { CoreError } = require('../../../core/errors.js');

const MAX_BODY_BYTES = 1024 * 1024;

function parseArgs(argv) {
  const options = { once: false, configFile: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--once') options.once = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--config') {
      index += 1;
      if (!argv[index]) throw new Error('--config 缺少文件路径');
      options.configFile = argv[index];
    } else if (arg.startsWith('--config=')) {
      options.configFile = arg.slice('--config='.length);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return options;
}

function loadConfig(filePath) {
  if (!filePath) return {};
  const absolute = path.resolve(filePath);
  const raw = fs.readFileSync(absolute, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('配置文件必须是 JSON 对象');
  }
  return parsed;
}

function matchPath(template, actualPath) {
  const templateParts = template.split('/').filter(Boolean);
  const actualParts = actualPath.split('/').filter(Boolean);
  if (templateParts.length !== actualParts.length) return null;
  const params = {};
  for (let index = 0; index < templateParts.length; index += 1) {
    const expected = templateParts[index];
    const actual = actualParts[index];
    if (expected.startsWith(':')) {
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

function findRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPath(route.path, pathname);
    if (params) return { route, params };
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
        const error = new Error('请求体过大');
        error.status = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        const parsed = JSON.parse(text);
        resolve(parsed);
      } catch {
        const error = new Error('请求体不是合法 JSON');
        error.status = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function devUser(req) {
  const headers = req.headers || {};
  let raw = headers['x-dev-user'];
  if (Array.isArray(raw)) raw = raw[0];
  if (!raw) {
    const authorization = String(headers.authorization || '');
    if (authorization.toLowerCase().startsWith('bearer ')) raw = authorization.slice(7).trim();
  }
  if (!raw) return null;
  const id = String(raw).trim();
  if (!id) return null;
  return {
    id,
    username: id,
    email: typeof headers['x-dev-email'] === 'string' ? headers['x-dev-email'] : null
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body === undefined ? {} : body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('用法: node modules/mail/server/dev.js [--once] [--config <json>]\n');
    return;
  }

  const config = loadConfig(options.configFile);
  await mailModule.start({
    config,
    logger: {
      info(message) { process.stderr.write(`${message}\n`); },
      warn(message) { process.stderr.write(`${message}\n`); },
      error(message) { process.stderr.write(`${message}\n`); }
    }
  });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (error instanceof CoreError) return sendJson(res, error.status, { code: error.code, message: error.message });
      process.stderr.write(`[mail-dev] ${error && error.message ? error.message : 'internal error'}\n`);
      return sendJson(res, 500, { code: 'mail.internal_error', message: '邮件服务内部错误' });
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    const method = req.method || 'GET';
    const matched = findRoute(mailModule.routes, method, pathname);
    if (!matched) {
      return sendJson(res, 404, { code: 'mail.route_not_found', message: '接口不存在' });
    }
    let body = {};
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      try {
        body = await readBody(req);
      } catch (error) {
        return sendJson(res, error.status || 400, {
          code: 'mail.invalid_input',
          message: error.message === '请求体过大' ? '请求体过大' : '请求体不是合法 JSON'
        });
      }
    }
    const query = {};
    for (const [key, value] of url.searchParams.entries()) query[key] = value;
    const result = await matched.route.handler({
      req,
      res,
      url,
      params: matched.params,
      query,
      body,
      user: devUser(req)
    });
    const status = result && Number.isInteger(result.status) ? result.status : 200;
    const headers = result && result.headers && typeof result.headers === 'object' ? result.headers : {};
    if (Object.keys(headers).length > 0) {
      for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
    }
    return sendJson(res, status, result ? result.body : {});
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  process.stdout.write(`${JSON.stringify({ url })}\n`);

  if (options.once) {
    await mailModule.stop();
    await new Promise((resolve) => server.close(resolve));
    return;
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await mailModule.stop();
    await new Promise((resolve) => server.close(resolve));
    process.exitCode = 0;
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  process.stderr.write(`[mail-dev] 启动失败: ${error && error.message ? error.message : error}\n`);
  process.exitCode = 1;
});
