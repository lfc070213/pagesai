'use strict';
// M1a 集成冒烟：core-only 启动、简单注册、登录、会话、单层管理员。
// 运行：node --test tests/integration/*.test.js
// 依赖：仅 Node 内置（http + global fetch），不需要数据库、模型或邮箱。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const coreRoot = path.join(__dirname, '..', '..', 'core');
const { loadConfig } = require(path.join(coreRoot, 'config', 'index.js'));
const { createCore, createServer } = require(path.join(coreRoot, 'server.js'));
const { InMemoryIdentityStore } = require(path.join(coreRoot, 'identity', 'store.js'));
const { codes } = require(path.join(coreRoot, 'errors.js'));

async function boot(overrides = {}) {
  const config = loadConfig({ env: {}, dataRoot: path.join(require('node:os').tmpdir(), 'pagesai-core-test'), ...overrides });
  const core = createCore({ config, store: new InMemoryIdentityStore() });
  const app = createServer(core);
  const info = await app.listen({ port: 0 });
  return { app, core, config, base: info.url };
}

async function call(base, method, url, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json, headers: res.headers };
}

test('邮箱验证注册在未安装 Mail 时启动即失败（不是等用户注册才报错）', () => {
  assert.throws(
    () => loadConfig({ env: { PAGESAI_EMAIL_REGISTRATION: 'on' }, installedModules: ['survey'] }),
    (err) => err.code === codes.MAIL_MODULE_REQUIRED
  );
  assert.doesNotThrow(() => loadConfig({ env: { PAGESAI_EMAIL_REGISTRATION: 'on' }, installedModules: ['mail'] }));
});

test('正式组装未显式选择 MongoDB 时拒绝启动，不静默回落内存', () => {
  const config = loadConfig({ env: {} });
  assert.throws(() => createCore({ config }), (err) => err.code === codes.CONFIG_INVALID);
  assert.throws(
    () => loadConfig({ env: { PAGESAI_DATABASE_ENGINE: 'json-store' } }),
    (err) => err.code === codes.CONFIG_INVALID
  );
  assert.throws(
    () => loadConfig({ env: { PAGESAI_DATABASE_ENGINE: 'mongodb', PAGESAI_MONGO_HOST: '127.0.0.1' } }),
    (err) => err.code === codes.CONFIG_INVALID
  );
  const mongoConfig = loadConfig({
    env: {
      PAGESAI_DATABASE_ENGINE: 'mongodb',
      PAGESAI_DEPLOYMENT_ID: '4a9b4c32-48b2-4cf1-a9df-8a65fc23b0c8',
      PAGESAI_MONGO_HOST: '127.0.0.1'
    }
  });
  assert.throws(
    () => createCore({ config: mongoConfig, store: new InMemoryIdentityStore() }),
    (err) => err.code === codes.CONFIG_INVALID
  );
});

test('core-only 测试显式注入内存存储：健康、就绪、模块清单为空', async () => {
  const { app, base } = await boot();
  try {
    assert.equal((await call(base, 'GET', '/healthz')).status, 200);
    const ready = await call(base, 'GET', '/readyz');
    assert.equal(ready.status, 200);
    assert.deepEqual(ready.json.modules, []);
    const modules = await call(base, 'GET', '/api/modules');
    assert.deepEqual(modules.json.installed, []);
    // 未安装模块不得有任何业务路由
    for (const p of ['/api/pages/sites', '/api/disk/files', '/api/survey/list', '/api/paper/docs', '/api/glim/chat', '/api/mail/inbox']) {
      assert.equal((await call(base, 'GET', p)).status, 404, p + ' 不应存在');
    }
  } finally {
    await app.close();
  }
});

test('简单注册 → 登录 → 取回自己 → 退出 全链路', async () => {
  const { app, base } = await boot();
  try {
    const reg = await call(base, 'POST', '/api/auth/register', { body: { username: 'alice', password: 'password-1234' } });
    assert.equal(reg.status, 201);
    assert.equal(reg.json.user.role, 'user');

    const login = await call(base, 'POST', '/api/auth/login', { body: { username: 'alice', password: 'password-1234' } });
    assert.equal(login.status, 200);
    assert.ok(login.json.token);
    assert.match(String(login.headers.get('set-cookie')), /HttpOnly/);

    const me = await call(base, 'GET', '/api/me', { token: login.json.token });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.username, 'alice');
    assert.equal(JSON.stringify(me.json).includes('password'), false);

    assert.equal((await call(base, 'POST', '/api/auth/logout', { token: login.json.token })).status, 200);
    assert.equal((await call(base, 'GET', '/api/me', { token: login.json.token })).status, 401);
  } finally {
    await app.close();
  }
});

test('首名管理员一次性引导：第二次被拒，且普通用户不能访问管理接口', async () => {
  const { app, base } = await boot();
  try {
    const first = await call(base, 'POST', '/api/admin/bootstrap', { body: { username: 'boss', password: 'password-1234' } });
    assert.equal(first.status, 201);
    assert.equal(first.json.user.role, 'admin');
    const second = await call(base, 'POST', '/api/admin/bootstrap', { body: { username: 'boss2', password: 'password-1234' } });
    assert.equal(second.status, 409);
    assert.equal(second.json.code, codes.BOOTSTRAP_CLOSED);

    const boss = await call(base, 'POST', '/api/auth/login', { body: { username: 'boss', password: 'password-1234' } });
    const users = await call(base, 'GET', '/api/admin/users', { token: boss.json.token });
    assert.equal(users.status, 200);
    assert.equal(users.json.users.length, 1);

    await call(base, 'POST', '/api/auth/register', { body: { username: 'plain', password: 'password-1234' } });
    const plain = await call(base, 'POST', '/api/auth/login', { body: { username: 'plain', password: 'password-1234' } });
    const denied = await call(base, 'GET', '/api/admin/users', { token: plain.json.token });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.code, codes.FORBIDDEN);
  } finally {
    await app.close();
  }
});

test('错误响应不泄露内部细节，且输入校验可读', async () => {
  const { app, base } = await boot();
  try {
    const bad = await call(base, 'POST', '/api/auth/register', { body: { username: 'x', password: 'short' } });
    assert.equal(bad.status, 400);
    assert.ok(bad.json.code);
    assert.equal(JSON.stringify(bad.json).includes('scrypt'), false);

    const wrong = await call(base, 'POST', '/api/auth/login', { body: { username: 'nobody', password: 'password-1234' } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.code, codes.INVALID_CREDENTIALS);
    // 不区分「用户不存在」与「密码错误」
    assert.equal(wrong.json.message, '用户名或密码错误');

    assert.equal((await call(base, 'GET', '/api/unknown')).status, 404);
  } finally {
    await app.close();
  }
});