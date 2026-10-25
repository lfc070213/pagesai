'use strict';
// P1 / B07 契约测试：模块清单校验与生命周期状态。
// 运行：node --test tests/contracts/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const coreRoot = path.join(__dirname, '..', '..', 'core');
const fixtures = path.join(__dirname, '..', 'fixtures', 'modules');
const { validateManifest } = require(path.join(coreRoot, 'registry', 'manifest.js'));
const { ModuleHost } = require(path.join(coreRoot, 'registry', 'host.js'));
const { codes } = require(path.join(coreRoot, 'errors.js'));

function manifest(overrides = {}) {
  return {
    id: 'survey',
    version: '0.1.0',
    coreCompatibility: '^1.0.0',
    requires: { infrastructure: ['mongo'] },
    optionalConnections: ['disk'],
    activation: { serverEntry: 'index.js', routePrefix: '/api/survey' },
    data: { namespace: 'survey' },
    lifecycle: { start: 'start', stop: 'stop', health: 'health' },
    capabilities: { tools: [] },
    ...overrides
  };
}

test('合法模块清单通过校验', () => {
  assert.doesNotThrow(() => validateManifest(manifest()));
});

test('缺必填字段、非法模块 ID、越界路径都会被拒绝', () => {
  const missing = manifest();
  delete missing.lifecycle;
  assert.throws(() => validateManifest(missing), (err) => err.code === codes.CONFIG_INVALID);

  assert.throws(() => validateManifest(manifest({ id: 'jupyter' })), (err) => err.code === codes.CONFIG_INVALID);
  assert.throws(() => validateManifest(manifest({ activation: { serverEntry: '../escape.js' } })), (err) => err.code === codes.PATH_ESCAPE || err.code === codes.CONFIG_INVALID);
  assert.throws(() => validateManifest(manifest({ activation: { serverEntry: '/abs/index.js' } })), (err) => err.code === codes.PATH_ESCAPE || err.code === codes.CONFIG_INVALID);
  assert.throws(() => validateManifest(manifest({ data: { namespace: 'survey', migrations: [{ id: '0001', up: '../../up.js' }] } })), (err) => err.code === codes.PATH_ESCAPE || err.code === codes.CONFIG_INVALID);
});

test('未安装模块不导入代码，也不注册任何路由', async () => {
  globalThis.__fixtureLoads = 0;
  const host = new ModuleHost({ modulesRoot: fixtures });
  const before = host.describe('survey');
  assert.equal(before.installed, false);
  assert.equal(globalThis.__fixtureLoads, 0);
  await assert.rejects(host.enable('survey'), (err) => err.code === codes.MODULE_NOT_INSTALLED);
  assert.equal(globalThis.__fixtureLoads, 0, '未安装时不得 require 模块入口');

  host.install(manifest(), { dir: path.join(fixtures, 'survey-ok') });
  assert.equal(globalThis.__fixtureLoads, 0, '仅登记也不得 require');

  const ready = await host.enable('survey');
  assert.equal(ready.ready, true);
  assert.equal(globalThis.__fixtureLoads, 1, '启用后才加载一次');
  const health = await host.health('survey');
  assert.equal(health.ok, true);
});

test('停用后 ready=false 且保留登记；再次启用可恢复', async () => {
  globalThis.__fixtureLoads = 0;
  const host = new ModuleHost({ modulesRoot: fixtures });
  host.install(manifest(), { dir: path.join(fixtures, 'survey-ok') });
  await host.enable('survey');
  const disabled = await host.disable('survey');
  assert.equal(disabled.installed, true);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.ready, false);
  const again = await host.enable('survey');
  assert.equal(again.ready, true);
  const uninstalled = await host.uninstall('survey');
  assert.deepEqual(uninstalled, { id: 'survey', installed: false, enabled: false, configured: false, ready: false });
  assert.deepEqual(host.list(), []);
  assert.equal(host.describe('survey').installed, false);
});

test('配置不完整时拒绝启用，并区分 installed/enabled/configured/ready', async () => {
  const host = new ModuleHost({ modulesRoot: fixtures, configProvider: () => ({}) });
  const fs = require('node:fs');
  const dir = path.join(fixtures, 'paper-needs-config');
  host.install(manifest({ id: 'paper', activation: { serverEntry: 'index.js' }, config: { schema: 'config.schema.json', secrets: ['/token'] } }), { dir });
  assert.ok(fs.existsSync(path.join(dir, 'config.schema.json')));
  await assert.rejects(host.enable('paper'), (err) => err.code === codes.CONFIG_INVALID);
  const state = host.describe('paper');
  assert.equal(state.installed, true);
  assert.equal(state.enabled, false);
  assert.equal(state.configured, false);
  assert.equal(state.ready, false);
});

test('入口缺少生命周期函数时启用失败并给出原因', async () => {
  const host = new ModuleHost({ modulesRoot: fixtures });
  host.install(manifest({ id: 'mail', activation: { serverEntry: 'index.js' } }), { dir: path.join(fixtures, 'mail-broken') });
  await assert.rejects(host.enable('mail'), (err) => err.code === codes.MODULE_NOT_READY);
  const state = host.describe('mail');
  assert.equal(state.ready, false);
  assert.match(state.startError, /stop|health/);
});

test('未实现能力不会出现在可用能力清单里', () => {
  const host = new ModuleHost({ modulesRoot: fixtures });
  host.install(manifest({
    capabilities: {
      tools: [
        { name: 'survey_list', access: 'read', implemented: true },
        { name: 'survey_publish', access: 'write', implemented: false, externalEffect: true }
      ]
    }
  }), { dir: path.join(fixtures, 'survey-ok') });
  const caps = host.describe('survey').capabilities;
  assert.deepEqual(caps.map((c) => c.name), ['survey_list']);
});
