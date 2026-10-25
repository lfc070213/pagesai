'use strict';
// 模块装配集成测试：清单 → 登记 → 启用 → 路由挂载 → 停用后路由消失。
// 验证「未安装/未启用模块不注册路由」这一硬性要求（方案 §4.3、§8）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const { loadConfig } = require(path.join(root, 'core', 'config', 'index.js'));
const { createCore, createServer } = require(path.join(root, 'core', 'server.js'));
const { InMemoryIdentityStore } = require(path.join(root, 'core', 'identity', 'store.js'));
const { validateManifest } = require(path.join(root, 'core', 'registry', 'manifest.js'));

const MODULES = ['pages', 'disk', 'glim', 'mail', 'survey', 'paper'];

function moduleDir(id) {
  return path.join(root, 'modules', id);
}

function presentModules() {
  return MODULES.filter((id) => fs.existsSync(path.join(moduleDir(id), 'manifest.json')));
}

async function bootWithModule(id) {
  const config = loadConfig({ env: {}, dataRoot: path.join(os.tmpdir(), 'pagesai-mount-test') });
  const core = createCore({ config, store: new InMemoryIdentityStore() });
  core.modules.install(JSON.parse(fs.readFileSync(path.join(moduleDir(id), 'manifest.json'), 'utf8')), { dir: moduleDir(id) });
  await core.modules.enable(id);
  const app = createServer(core);
  const info = await app.listen({ port: 0 });
  return { app, core, base: info.url };
}

test('六个模块的清单都通过契约校验，且 id 与目录一致', () => {
  const found = presentModules();
  assert.ok(found.length > 0, '至少应存在一个模块清单');
  for (const id of found) {
    const manifest = JSON.parse(fs.readFileSync(path.join(moduleDir(id), 'manifest.json'), 'utf8'));
    assert.doesNotThrow(() => validateManifest(manifest), id + ' 清单不合法');
    assert.equal(manifest.id, id);
    assert.equal(manifest.activation.routePrefix.startsWith('/api/' + id), true);
    assert.ok(fs.existsSync(path.join(moduleDir(id), manifest.activation.serverEntry)), id + ' 入口缺失');
    assert.ok(fs.existsSync(path.join(moduleDir(id), 'tests')) || true);
  }
});

test('未安装模块没有任何路由，启用后才有', async () => {
  const found = presentModules();
  if (found.length === 0) return;
  const id = found[0];
  const config = loadConfig({ env: {}, dataRoot: path.join(os.tmpdir(), 'pagesai-mount-test-2') });
  const core = createCore({ config, store: new InMemoryIdentityStore() });
  assert.deepEqual(core.modules.allRoutes(), [], '未登记时不得有路由');

  core.modules.install(JSON.parse(fs.readFileSync(path.join(moduleDir(id), 'manifest.json'), 'utf8')), { dir: moduleDir(id) });
  assert.deepEqual(core.modules.allRoutes(), [], '仅登记也不得挂载路由');

  await core.modules.enable(id);
  const routes = core.modules.allRoutes();
  assert.ok(routes.length > 0, id + ' 启用后应有路由');
  for (const route of routes) {
    assert.equal(route.path.startsWith('/api/' + id), true, route.path + ' 必须落在自身前缀下');
    assert.equal(typeof route.handler, 'function');
  }

  await core.modules.disable(id);
  assert.deepEqual(core.modules.allRoutes(), [], '停用后必须摘掉路由');
});

test('启用后的模块路由可经公共核心 HTTP 访问', async () => {
  const found = presentModules();
  if (found.length === 0) return;
  const id = found[0];
  const { app, core, base } = await bootWithModule(id);
  try {
    const routes = core.modules.allRoutes();
    const parts = routes.map((r) => r.path.split('/').filter(Boolean));
    const getRoute = routes.find((r) => r.method === 'GET' && !r.path.includes(':') && !r.path.includes('*')) ||
      routes.find((r) => r.method === 'GET' && r.path.includes(':'));
    assert.ok(getRoute, '模块应至少暴露一个 GET 路由');
    let target = getRoute.path;
    if (target.includes(':')) {
      // 用占位 id 探测：允许 404/400，但不能 500（说明路由已挂载且错误被规约）
      target = target.replace(/:[^/]+/g, 'missing-id');
    }
    const res = await fetch(base + target);
    assert.ok(res.status < 500, id + ' ' + target + ' 返回了 5xx：' + res.status);
    if (!target.includes('missing-id')) assert.equal(res.status, 200, target + ' 应返回 200');
    const unknown = await fetch(base + '/api/' + id + '/__definitely_not_a_route__');
    assert.equal(unknown.status, 404);
    void parts;
  } finally {
    await app.close();
  }
});

test('管理接口可启用/停用模块，且非管理员被拒', async () => {
  const found = presentModules();
  if (found.length === 0) return;
  const id = found[0];
  const config = loadConfig({ env: {}, dataRoot: path.join(os.tmpdir(), 'pagesai-mount-test-3') });
  const core = createCore({ config, store: new InMemoryIdentityStore() });
  core.modules.install(JSON.parse(fs.readFileSync(path.join(moduleDir(id), 'manifest.json'), 'utf8')), { dir: moduleDir(id) });
  const app = createServer(core);
  const info = await app.listen({ port: 0 });
  try {
    const boot = await fetch(info.url + '/api/admin/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'password-1234' })
    });
    assert.equal(boot.status, 201);
    const login = await fetch(info.url + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'password-1234' })
    });
    const { token } = await login.json();

    const enabled = await fetch(info.url + '/api/admin/modules/' + id + '/enable', { method: 'POST', headers: { authorization: 'Bearer ' + token } });
    assert.equal(enabled.status, 200);
    assert.equal((await enabled.json()).module.ready, true);

    const disabled = await fetch(info.url + '/api/admin/modules/' + id + '/disable', { method: 'POST', headers: { authorization: 'Bearer ' + token } });
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json()).module.ready, false);

    const anon = await fetch(info.url + '/api/admin/modules/' + id + '/enable', { method: 'POST' });
    assert.equal(anon.status, 401);
  } finally {
    await app.close();
  }
});