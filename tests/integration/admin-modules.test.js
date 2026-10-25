'use strict';
// C29 集成测试：/api/admin/modules 的状态、后台贡献与启用/停用。
// 只使用内存身份存储与临时数据根；不连接正式数据库、邮件或模型。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const { loadConfig } = require(path.join(root, 'core', 'config', 'index.js'));
const { createCore, createServer } = require(path.join(root, 'core', 'server.js'));
const { InMemoryIdentityStore } = require(path.join(root, 'core', 'identity', 'store.js'));
const { codes } = require(path.join(root, 'core', 'errors.js'));
const { CONSOLE_PATHS } = require(path.join(root, 'core', 'registry', 'admin-contribution.js'));

const ALL = ['pages', 'disk', 'glim', 'mail', 'survey', 'paper'];

function moduleDir(id) {
  return path.join(root, 'modules', id);
}

function readManifest(id) {
  return JSON.parse(fs.readFileSync(path.join(moduleDir(id), 'manifest.json'), 'utf8'));
}

async function boot(ids) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pagesai-admin-modules-'));
  // 内存模式：显式注入身份存储，避免触达正式数据库。
  const config = loadConfig({ env: {}, dataRoot });
  const core = createCore({ config, store: new InMemoryIdentityStore() });
  for (const id of ids) core.modules.install(readManifest(id), { dir: moduleDir(id) });
  for (const id of ids) await core.modules.enable(id);
  const app = createServer(core);
  const info = await app.listen({ port: 0 });
  return { app, core, base: info.url };
}

async function teardown(ctx, ids) {
  for (const id of ids) {
    try {
      await ctx.core.modules.disable(id);
    } catch {
      // 停用失败不影响测试收尾；进程即将关闭。
    }
  }
  await ctx.app.close();
}

async function call(base, method, url, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function sessions(base) {
  const admin = await call(base, 'POST', '/api/admin/bootstrap', {
    body: { username: 'boss', password: 'password-1234' }
  });
  assert.equal(admin.status, 201);
  const plain = await call(base, 'POST', '/api/auth/register', {
    body: { username: 'plain', password: 'password-1234' }
  });
  assert.equal(plain.status, 201);
  const adminLogin = await call(base, 'POST', '/api/auth/login', {
    body: { username: 'boss', password: 'password-1234' }
  });
  const plainLogin = await call(base, 'POST', '/api/auth/login', {
    body: { username: 'plain', password: 'password-1234' }
  });
  assert.equal(adminLogin.status, 200);
  assert.equal(plainLogin.status, 200);
  return { admin: adminLogin.json.token, plain: plainLogin.json.token };
}

function byId(list) {
  const map = new Map();
  for (const item of Array.isArray(list) ? list : []) map.set(item.id, item);
  return map;
}

test('管理接口只有管理员可读：匿名 401，普通用户 403', async () => {
  const ctx = await boot(['survey']);
  try {
    const anon = await call(ctx.base, 'GET', '/api/admin/modules');
    assert.equal(anon.status, 401);
    assert.equal(anon.json.code, codes.SESSION_INVALID);

    const tokens = await sessions(ctx.base);
    const denied = await call(ctx.base, 'GET', '/api/admin/modules', { token: tokens.plain });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.code, codes.FORBIDDEN);

    const detailDenied = await call(ctx.base, 'GET', '/api/admin/modules/survey', { token: tokens.plain });
    assert.equal(detailDenied.status, 403);
  } finally {
    await teardown(ctx, ['survey']);
  }
});

test('六模块组合：只列已登记模块，每个模块都有真实后台贡献与控制台入口', async () => {
  const ctx = await boot(ALL);
  try {
    const tokens = await sessions(ctx.base);
    const list = await call(ctx.base, 'GET', '/api/admin/modules', { token: tokens.admin });
    assert.equal(list.status, 200);

    assert.deepEqual(list.json.modules.map((item) => item.id), ALL.slice().sort());
    assert.equal(list.json.admin.length, ALL.length);

    const admin = byId(list.json.admin);
    for (const id of ALL) {
      const record = admin.get(id);
      assert.ok(record, id + ' 缺少后台记录');
      assert.equal(record.installed, true, id);
      assert.equal(record.enabled, true, id);
      assert.equal(record.available, true, id);
      assert.equal(record.error, null, id);
      assert.ok(record.contribution, id + ' 缺少后台贡献');
      assert.equal(record.contribution.consolePath, CONSOLE_PATHS[id], id);
      assert.ok(record.contribution.title.length > 0, id);
      assert.ok(record.contribution.sections.length > 0, id);
      for (const section of record.contribution.sections) {
        assert.ok(section.items.length > 0, id + ' / ' + section.title);
      }
      const serialized = JSON.stringify(record.contribution);
      assert.equal(serialized.includes('apiKey'), false, id);
      assert.equal(serialized.includes('password'), false, id);
    }
  } finally {
    await teardown(ctx, ALL);
  }
});

test('模块详情只接受已安装模块，未安装返回 404', async () => {
  const ctx = await boot(['survey']);
  try {
    const tokens = await sessions(ctx.base);
    const detail = await call(ctx.base, 'GET', '/api/admin/modules/survey', { token: tokens.admin });
    assert.equal(detail.status, 200);
    assert.equal(detail.json.module.installed, true);
    assert.equal(detail.json.admin.available, true);
    assert.equal(detail.json.admin.contribution.consolePath, '/survey');

    const missing = await call(ctx.base, 'GET', '/api/admin/modules/pages', { token: tokens.admin });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, codes.MODULE_NOT_INSTALLED);
  } finally {
    await teardown(ctx, ['survey']);
  }
});

test('启用组合决定列表内容：单装时不出现其他模块', async () => {
  const ctx = await boot(['survey']);
  try {
    const tokens = await sessions(ctx.base);
    const list = await call(ctx.base, 'GET', '/api/admin/modules', { token: tokens.admin });
    assert.deepEqual(list.json.modules.map((item) => item.id), ['survey']);
    assert.deepEqual(list.json.admin.map((item) => item.id), ['survey']);
    assert.equal(JSON.stringify(list.json).includes('"/pages"'), false);
  } finally {
    await teardown(ctx, ['survey']);
  }
});

test('停用后后台贡献立即不可用，重新启用后恢复', async () => {
  const ctx = await boot(['survey']);
  try {
    const tokens = await sessions(ctx.base);

    const disabled = await call(ctx.base, 'POST', '/api/admin/modules/survey/disable', {
      token: tokens.admin
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.json.module.enabled, false);

    const afterDisable = await call(ctx.base, 'GET', '/api/admin/modules', { token: tokens.admin });
    const record = byId(afterDisable.json.admin).get('survey');
    assert.equal(record.enabled, false);
    assert.equal(record.available, false);
    assert.equal(record.contribution, null);
    assert.equal(ctx.core.modules.routesFor('survey').length, 0);

    const enabled = await call(ctx.base, 'POST', '/api/admin/modules/survey/enable', {
      token: tokens.admin
    });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.json.module.enabled, true);
    assert.equal(enabled.json.module.ready, true);

    const afterEnable = await call(ctx.base, 'GET', '/api/admin/modules', { token: tokens.admin });
    const restored = byId(afterEnable.json.admin).get('survey');
    assert.equal(restored.available, true);
    assert.equal(restored.contribution.consolePath, '/survey');
    assert.ok(ctx.core.modules.routesFor('survey').length > 0);
  } finally {
    await teardown(ctx, ['survey']);
  }
});

test('普通用户不能启用或停用模块', async () => {
  const ctx = await boot(['survey']);
  try {
    const tokens = await sessions(ctx.base);
    const denied = await call(ctx.base, 'POST', '/api/admin/modules/survey/disable', {
      token: tokens.plain
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.code, codes.FORBIDDEN);
    assert.equal(ctx.core.modules.describe('survey').enabled, true);

    const anon = await call(ctx.base, 'POST', '/api/admin/modules/survey/disable');
    assert.equal(anon.status, 401);
  } finally {
    await teardown(ctx, ['survey']);
  }
});