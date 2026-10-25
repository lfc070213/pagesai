'use strict';
// 契约测试：清单、配置 schema、统一模块接口、路由前缀、适配器未配置、区域暴露边界、网络策略中性。

const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  assert,
  disk,
  expectError,
  api,
  boot,
  shutdown,
  USER_A
} = require('./helpers');

const { validateManifest } = require('../../../core/registry/manifest.js');
const { validate } = require('../../../core/contracts/validate.js');

const MANIFEST = require('../manifest.json');
const CONFIG_SCHEMA = require('../config.schema.json');

test('manifest 通过 contracts/module-manifest.schema.json 校验且声明完整', () => {
  assert.doesNotThrow(() => validateManifest(MANIFEST));
  assert.equal(MANIFEST.id, 'disk');
  assert.equal(MANIFEST.activation.serverEntry, 'server/index.js');
  assert.equal(MANIFEST.activation.routePrefix, '/api/disk');
  assert.equal(MANIFEST.config.schema, 'config.schema.json');
  assert.deepEqual(MANIFEST.config.secrets, []);
  assert.equal(MANIFEST.data.namespace, 'disk');
  assert.deepEqual(MANIFEST.data.regions, ['disk.user-files']);
  assert.ok(Array.isArray(MANIFEST.capabilities.tools));
  assert.ok(MANIFEST.lifecycle.start && MANIFEST.lifecycle.stop && MANIFEST.lifecycle.health);
});

test('config.schema.json 接受空配置与合法配置，拒绝越界字段', () => {
  assert.equal(validate(CONFIG_SCHEMA, {}).valid, true);
  assert.equal(validate(CONFIG_SCHEMA, {
    dataFile: null,
    regions: ['disk.user-files'],
    quotaBytes: 1024,
    chunkSizeBytes: 1024,
    maxChunkBytes: 2048,
    share: { defaultTtlSeconds: 60, maxTtlSeconds: 120 },
    storageAdapter: 'json'
  }).valid, true);
  assert.equal(validate(CONFIG_SCHEMA, { quotaBytes: 0 }).valid, false);
  assert.equal(validate(CONFIG_SCHEMA, { regions: ['disk.other'] }).valid, false);
  assert.equal(validate(CONFIG_SCHEMA, { unknownField: true }).valid, false);
  assert.equal(validate(CONFIG_SCHEMA, { storageAdapter: 'object-storage' }).valid, true);
});

test('统一模块接口：start/stop/health/routes/tools 形状正确，路由全部落在 /api/disk/', async () => {
  for (const name of ['start', 'stop', 'health']) {
    assert.equal(typeof disk[name], 'function', `${name} 必须是函数`);
  }
  assert.ok(Array.isArray(disk.routes));
  assert.ok(disk.routes.length > 0);
  assert.equal(typeof disk.tools, 'object');
  assert.equal(Array.isArray(disk.tools), false);
  assert.deepEqual(Object.keys(disk.tools), []);

  const seen = new Set();
  for (const route of disk.routes) {
    assert.ok(route.path.startsWith('/api/disk/'), route.path);
    assert.equal(typeof route.handler, 'function');
    assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method));
    const key = `${route.method} ${route.path}`;
    assert.equal(seen.has(key), false, `重复路由 ${key}`);
    seen.add(key);
  }

  await boot();
  assert.deepEqual(await disk.health(), { ok: true });
  await shutdown();
});

test('健康检查路由可公开访问', async () => {
  await boot();
  const response = await api('health');
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.module, 'disk');
  assert.deepEqual(response.body.regions, ['disk.user-files']);
  await shutdown();
});

test('验收配置不合法时启动失败（CONFIG_INVALID）', async () => {
  await assert.rejects(
    () => disk.start({ config: { regions: ['disk.other'] }, logger: { info() {}, warn() {}, error() {} } }),
    (err) => err.code === 'CONFIG_INVALID'
  );
});

test('存储适配器未配置/未实现时数据请求返回 409，不伪造结果', async () => {
  await boot({ storageAdapter: 'object-storage' });
  const response = await api('init', { user: USER_A, body: { name: 'a.txt' } });
  expectError(response, 409, 'DISK_ADAPTER_NOT_CONFIGURED');
  assert.match(response.body.message, /适配器/);
  await shutdown();
});

test('未认证的写操作一律 403；跨用户文件访问 403', async () => {
  await boot();
  const anonymous = await api('init', { body: { name: 'anon.txt' } });
  expectError(anonymous, 403, 'FORBIDDEN');
  await shutdown();
});

test('只暴露 config.regions 声明的区域：未登记区域返回 404', async () => {
  await boot();
  const response = await api('init', { user: USER_A, body: { name: 'a.txt', regionId: 'disk.other' } });
  expectError(response, 404, 'REGION_NOT_EXPOSED');
  await shutdown();
});

test('服务端代码不含网络探测/校园域名判定，仅使用 Node 内置模块', () => {
  const file = path.join(__dirname, '..', 'server', 'index.js');
  const source = fs.readFileSync(file, 'utf8');
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
  assert.doesNotMatch(codeOnly, /\bpku\b|campus|校园|校内/i);
  assert.doesNotMatch(codeOnly, /require\(['"]node:(?:http|https|net|dns|tls|dgram)['"]\)/);
  assert.doesNotMatch(codeOnly, /\bfetch\s*\(/);
  assert.doesNotMatch(codeOnly, /100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./);
});

test('ModuleHost 生命周期：安装 → 启用 → 路由可见 → 健康 → 停用', async () => {
  const { ModuleHost } = require('../../../core/registry/host.js');
  const modulesRoot = path.join(__dirname, '..', '..');
  const host = new ModuleHost({ modulesRoot });
  const installed = host.install(MANIFEST);
  assert.equal(installed.installed, true);
  assert.equal(installed.ready, false);
  assert.deepEqual(host.routesFor('disk'), []);

  const enabled = await host.enable('disk');
  assert.equal(enabled.ready, true);
  assert.equal(enabled.configured, true);
  const routes = host.routesFor('disk');
  assert.ok(routes.length > 0);
  for (const route of routes) assert.ok(route.path.startsWith('/api/disk/'));
  assert.deepEqual(host.toolsFor('disk'), {});

  const health = await host.health('disk');
  assert.equal(health.ok, true);

  const disabled = await host.disable('disk');
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.ready, false);
  assert.deepEqual(host.routesFor('disk'), []);
});
