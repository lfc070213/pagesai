#!/usr/bin/env node
'use strict';
// Glim 本地开发入口：把模块导出的 routes 挂到 node:http，仅监听 127.0.0.1:0。
//
// 用法：
//   node modules/glim/server/dev.js                     # 持续运行，打印 {"url":"http://127.0.0.1:PORT"}
//   node modules/glim/server/dev.js --once              # 打印地址后立即退出（冒烟用）
//   node modules/glim/server/dev.js --data-file /tmp/glim.json
//   node modules/glim/server/dev.js --config ./glim.config.json
//
// 身份：开发环境可用请求头 x-glim-user: <id> 模拟已认证用户；不带该头即未认证。
// 该入口只用于本机开发，不得作为生产服务启动方式。

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const moduleEntry = require('./index.js');

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;

function usage() {
  return [
    'Glim dev server',
    '  --once                    打印地址后退出',
    '  --data-file <path>        使用 JsonStore 持久化文件（省略则纯内存）',
    '  --config <path>           读取模块配置 JSON（可含 chatAdapter）',
    '  --help                    显示帮助'
  ].join('\n');
}

function parseArgs(argv) {
  const options = { once: false, dataFile: null, configFile: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--once') {
      options.once = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--data-file' || arg === '--dataFile') {
      options.dataFile = argv[index + 1] || null;
      index += 1;
    } else if (arg.startsWith('--data-file=')) {
      options.dataFile = arg.slice('--data-file='.length);
    } else if (arg === '--config') {
      options.configFile = argv[index + 1] || null;
      index += 1;
    } else if (arg.startsWith('--config=')) {
      options.configFile = arg.slice('--config='.length);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return options;
}

function compileRoute(pathPattern) {
  return String(pathPattern).split('/').filter(Boolean);
}

function decodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function matchRoute(routes, method, pathname) {
  const parts = String(pathname).split('/').filter(Boolean);
  for (const route of routes) {
    if (route.method !== method) continue;
    const pattern = compileRoute(route.path);
    if (pattern.length !== parts.length) continue;
    const params = {};
    let matched = true;
    for (let index = 0; index < pattern.length; index += 1) {
      const segment = pattern[index];
      if (segment.startsWith(':')) {
        const decoded = decodeParam(parts[index]);
        if (decoded === null) {
          matched = false;
          break;
        }
        params[segment.slice(1)] = decoded;
      } else if (segment !== parts[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
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
        error.code = 'glim.invalid_input';
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        const error = new Error('请求体不是合法 JSON');
        error.status = 400;
        error.code = 'glim.invalid_input';
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  const text = JSON.stringify(payload === undefined ? {} : payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(text);
}

function devUser(req) {
  const raw = req.headers['x-glim-user'] || req.headers['x-glim-user-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !String(value).trim()) return null;
  const id = String(value).trim();
  const role = String(req.headers['x-glim-role'] || 'user').toLowerCase() === 'admin' ? 'admin' : 'user';
  return { id, username: id, role };
}

function createDevServer() {
  return http.createServer((req, res) => {
    (async () => {
      const method = String(req.method || 'GET').toUpperCase();
      const url = new URL(req.url || '/', `http://${HOST}`);
      let pathname = url.pathname;
      if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

      let body = {};
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        try {
          body = await readBody(req);
        } catch (err) {
          send(res, err.status || 400, { code: err.code || 'glim.invalid_input', message: err.message });
          return;
        }
      }

      const match = matchRoute(moduleEntry.routes, method, pathname);
      if (!match) {
        send(res, 404, { code: 'glim.not_found', message: '接口不存在' });
        return;
      }

      const context = {
        req,
        res,
        url,
        params: match.params,
        query: Object.fromEntries(url.searchParams.entries()),
        body,
        user: devUser(req)
      };
      try {
        const result = await match.route.handler(context);
        const status = result && Number.isInteger(result.status) ? result.status : 200;
        send(res, status, result && result.body !== undefined ? result.body : {});
      } catch (err) {
        if (err && err.expose === true && Number.isInteger(err.status) && typeof err.code === 'string') {
          send(res, err.status, { code: err.code, message: err.message });
          return;
        }
        // 不在响应中泄露内部错误细节。
        console.error('[glim-dev] handler error:', err && err.message ? err.message : err);
        send(res, 500, { code: 'glim.internal', message: '内部错误' });
      }
    })();
  });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(usage());
    process.exit(2);
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }

  let config = {};
  if (options.configFile) {
    try {
      const configPath = path.resolve(options.configFile);
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      console.error(`读取配置失败: ${err.message}`);
      process.exit(1);
      return;
    }
  }
  if (options.dataFile) config = { ...config, dataFile: options.dataFile };

  // 日志走 stderr，保证 stdout 只有一行 {"url":...}，便于脚本解析。
  const devLogger = {
    info: (...args) => console.error(...args),
    warn: (...args) => console.error(...args),
    error: (...args) => console.error(...args)
  };
  await moduleEntry.start({ config, logger: devLogger });
  const server = createDevServer();

  const listen = () =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, HOST, () => resolve(server.address()));
    });

  let address;
  try {
    address = await listen();
  } catch (err) {
    await moduleEntry.stop();
    console.error(`监听失败: ${err.message}`);
    process.exit(1);
    return;
  }
  console.log(JSON.stringify({ url: `http://${HOST}:${address.port}` }));

  if (options.once) {
    await moduleEntry.stop();
    await new Promise((resolve) => server.close(resolve));
    return;
  }

  const shutdown = async () => {
    await new Promise((resolve) => server.close(resolve));
    await moduleEntry.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(async (err) => {
  console.error('[glim-dev] 启动失败:', err && err.message ? err.message : err);
  try {
    await moduleEntry.stop();
  } catch {
    // 忽略停止阶段错误
  }
  process.exit(1);
});
