'use strict';
// 契约层测试：manifest 通过公共 schema、配置 schema 可用、入口导出统一接口。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validateManifest } = require('../../../core/registry/manifest.js');
const { validate } = require('../../../core/contracts/validate.js');

const moduleRoot = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'manifest.json'), 'utf8'));
const configSchema = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'config.schema.json'), 'utf8'));

test('manifest 通过 contracts/module-manifest.schema.json 校验', () => {
  assert.doesNotThrow(() => validateManifest(manifest));
  assert.equal(manifest.id, 'glim');
  assert.equal(manifest.activation.routePrefix, '/api/glim');
  assert.equal(manifest.activation.serverEntry, 'server/index.js');
  assert.equal(manifest.config.schema, 'config.schema.json');
  assert.deepEqual(manifest.data.regions, ['glim.state']);
  assert.ok(Array.isArray(manifest.capabilities.tools));
});

test('manifest 的工具声明与真实连接器实现一一对应（不伪造能力）', () => {
  const connectors = require('../connectors/index.js');
  const expected = new Map();
  for (const moduleId of connectors.MODULE_IDS) {
    for (const capability of connectors.capabilitiesFor(moduleId)) {
      expected.set(capability.name, capability);
    }
  }
  assert.ok(manifest.capabilities.tools.length > 0);
  assert.equal(manifest.capabilities.tools.length, expected.size);
  for (const tool of manifest.capabilities.tools) {
    assert.ok(['read', 'write'].includes(tool.access));
    const capability = expected.get(tool.name);
    assert.ok(capability, `manifest 中的 ${tool.name} 必须有本机实现`);
    assert.equal(tool.implemented, true);
    assert.equal(tool.access, capability.access);
    assert.equal(tool.externalEffect === true, capability.externalEffect === true);
  }
});

test('config schema 接受空配置与完整配置，并拒绝未知字段', () => {
  assert.equal(validate(configSchema, {}).valid, true);
  assert.equal(
    validate(configSchema, {
      dataFile: '/tmp/glim.json',
      memoryMaxChars: 4000,
      messageMaxChars: 8000,
      historyLimit: 50,
      systemPrompt: '你是 Glim',
      chatAdapter: {
        type: 'openai-compatible',
        endpoint: 'https://model.example/v1/chat/completions',
        model: 'model-name',
        timeoutMs: 30000
      },
      trustedConnectorOrigins: ['https://pages.example'],
      maxConnectorsPerUser: 10,
      workspaceRoot: '/var/lib/pagesai/glim/workspace',
      maxWorkspaceFileBytes: 1048576,
      maxWorkspaceFiles: 100,
      maxWorkspaceTotalBytes: 10485760,
      moduleDirectoryUrl: 'https://core.example/api/modules',
      moduleMinVersions: { pages: '1.0.0', disk: '1.2.0' },
      maxToolRounds: 4,
      maxRunningTasksPerUser: 1,
      auditLimit: 500
    }).valid,
    true
  );
  assert.equal(validate(configSchema, { unknownField: true }).valid, false);
  assert.equal(validate(configSchema, { chatAdapter: {} }).valid, false);
  assert.equal(validate(configSchema, { moduleMinVersions: { unknown: '1.0.0' } }).valid, false);
  assert.equal(validate(configSchema, { moduleDirectoryUrl: 'ftp://core.example' }).valid, false);
});

test('秘密字段在 schema 中存在且没有明文默认值', () => {
  assert.deepEqual(manifest.config.secrets, ['/chatAdapter/apiKey']);
  let node = configSchema;
  for (const segment of ['properties', 'chatAdapter', 'properties', 'apiKey']) {
    node = node && node[segment];
  }
  assert.ok(node, 'config schema 必须声明 chatAdapter.apiKey');
  assert.equal(node.default, undefined);
});

test('入口导出统一接口，且所有路由位于 /api/glim/ 前缀下', () => {
  const mod = require('../server/index.js');
  assert.equal(typeof mod.start, 'function');
  assert.equal(typeof mod.stop, 'function');
  assert.equal(typeof mod.health, 'function');
  assert.ok(Array.isArray(mod.routes));
  assert.ok(mod.tools && typeof mod.tools === 'object' && !Array.isArray(mod.tools));
  assert.ok(mod.routes.length > 0);

  const seen = new Set();
  for (const route of mod.routes) {
    assert.ok(route.path.startsWith('/api/glim/'), `路由前缀非法: ${route.path}`);
    assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method));
    assert.equal(typeof route.handler, 'function');
    const key = `${route.method} ${route.path}`;
    assert.equal(seen.has(key), false, `重复路由: ${key}`);
    seen.add(key);
  }

  for (const required of [
    'GET /api/glim/sessions',
    'POST /api/glim/sessions',
    'GET /api/glim/sessions/:id/messages',
    'POST /api/glim/sessions/:id/messages',
    'GET /api/glim/memory',
    'PUT /api/glim/memory',
    'GET /api/glim/connectors',
    'POST /api/glim/connectors',
    'GET /api/glim/tools',
    'POST /api/glim/tools/:name/invoke'
  ]) {
    assert.ok(seen.has(required), `缺少必需路由: ${required}`);
  }
});

test('生命周期：start 后 health 可用，stop 后数据状态被清理但接口仍为 ok 结构', async () => {
  const mod = require('../server/index.js');
  await mod.start({ config: {}, logger: { info() {}, warn() {}, error() {} } });
  const active = await mod.health();
  assert.equal(active.ok, true);
  assert.equal(active.started, true);
  assert.equal(active.storage, 'memory');
  await mod.stop();
  const inactive = await mod.health();
  assert.equal(typeof inactive.ok, 'boolean');
  assert.equal(inactive.started, false);
});
