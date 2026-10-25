'use strict';
// Glim 测试辅助：不启动 HTTP，直接按路由表调用 handler 并构造 fake ctx。
// 所有测试共享同一个模块实例，因此每个用例都必须通过 withModule/stop 清理状态。

const assert = require('node:assert/strict');
const moduleEntry = require('../server/index.js');

const silentLogger = {
  info() {},
  warn() {},
  error() {}
};

const alice = Object.freeze({ id: 'user-alice', username: 'alice', role: 'user' });
const bob = Object.freeze({ id: 'user-bob', username: 'bob', role: 'user' });
const admin = Object.freeze({ id: 'user-admin', username: 'admin', role: 'admin' });

function compileRoute(pathPattern) {
  return String(pathPattern).split('/').filter(Boolean);
}

function matchRoute(method, pathname) {
  const parts = String(pathname).split('/').filter(Boolean);
  for (const route of moduleEntry.routes) {
    if (route.method !== method) continue;
    const pattern = compileRoute(route.path);
    if (pattern.length !== parts.length) continue;
    const params = {};
    let matched = true;
    for (let index = 0; index < pattern.length; index += 1) {
      const segment = pattern[index];
      if (segment.startsWith(':')) {
        try {
          params[segment.slice(1)] = decodeURIComponent(parts[index]);
        } catch {
          matched = false;
          break;
        }
      } else if (segment !== parts[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return null;
}

async function call(method, pathWithQuery, options = {}) {
  const url = new URL(pathWithQuery, 'http://127.0.0.1');
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  const match = matchRoute(method, pathname);
  if (!match) throw new Error(`测试路由不存在: ${method} ${pathname}`);
  const query = { ...Object.fromEntries(url.searchParams.entries()), ...(options.query || {}) };
  return match.route.handler({
    req: {},
    res: {},
    url,
    params: match.params,
    query,
    body: options.body === undefined ? {} : options.body,
    user: options.user === undefined ? null : options.user
  });
}

async function boot(config = {}) {
  await moduleEntry.stop();
  await moduleEntry.start({ config, logger: silentLogger });
}

async function withModule(config, fn) {
  await boot(config);
  try {
    await fn();
  } finally {
    await moduleEntry.stop();
  }
}

function expectError(result, status, code) {
  assert.equal(result.status, status, `期望 HTTP ${status}，实际 ${result.status}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.code, code);
  assert.equal(typeof result.body.message, 'string');
  assert.ok(result.body.message.length > 0);
}

async function echoAdapter({ messages }) {
  const last = messages[messages.length - 1];
  return { content: `echo:${last.content}` };
}

module.exports = {
  moduleEntry,
  silentLogger,
  alice,
  bob,
  admin,
  call,
  boot,
  withModule,
  expectError,
  echoAdapter
};
