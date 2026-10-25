'use strict';
// 清单 / 配置 schema / 路由 / 生命周期 / dev 冒烟。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const moduleRoot = path.join(__dirname, '..');
const coreRoot = path.join(moduleRoot, '..', '..', 'core');
const { validateManifest } = require(path.join(coreRoot, 'registry', 'manifest.js'));
const { ModuleHost } = require(path.join(coreRoot, 'registry', 'host.js'));
const { validate } = require(path.join(coreRoot, 'contracts', 'validate.js'));
const moduleEntry = require(path.join(moduleRoot, 'server', 'index.js'));

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(moduleRoot, name), 'utf8'));
}

test('manifest 通过核心契约校验，字段与要求一致', () => {
  const manifest = readJson('manifest.json');
  assert.doesNotThrow(() => validateManifest(manifest));
  assert.equal(manifest.id, 'paper');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.activation.serverEntry, 'server/index.js');
  assert.equal(manifest.activation.routePrefix, '/api/paper');
  assert.equal(manifest.config.schema, 'config.schema.json');
  assert.ok(manifest.config.secrets.includes('/translateAdapter/apiKey'));
  assert.equal(manifest.data.namespace, 'paper');
  assert.ok(manifest.data.regions.includes('paper.uploads'));
  assert.equal(manifest.lifecycle.start, 'start');
  assert.equal(manifest.lifecycle.health, 'health');
});

test('config.schema 接受空配置与 endpoint 适配器，拒绝未知字段与越界值', () => {
  const schema = readJson('config.schema.json');
  assert.equal(validate(schema, {}).valid, true);
  assert.equal(validate(schema, {
    dataFile: '/tmp/paper.json',
    uploadsDir: '/tmp/paper-uploads',
    maxUploadBytes: 1048576,
    defaultTargetLang: 'zh',
    qaTopK: 6,
    translateBatchSize: 10,
    translateAdapter: { endpoint: 'https://adapter.test/translate', apiKey: 'secret', model: 'm' },
    qaAdapter: { endpoint: 'https://adapter.test/ask' },
    searchAdapter: { endpoint: 'https://adapter.test/search' }
  }).valid, true);
  assert.equal(validate(schema, { unknownField: true }).valid, false);
  assert.equal(validate(schema, { maxUploadBytes: 1 }).valid, false);
  assert.equal(validate(schema, { qaTopK: 0 }).valid, false);
  assert.equal(validate(schema, { defaultTargetLang: '中文' }).valid, false);
});

test('routes 全部位于 /api/paper/ 下，tools 与 manifest 的 implemented 能力对齐', () => {
  const manifest = readJson('manifest.json');
  assert.ok(moduleEntry.routes.length >= 7);
  for (const route of moduleEntry.routes) {
    assert.equal(typeof route.handler, 'function');
    assert.ok(route.path.startsWith('/api/paper/'), route.path);
    assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method));
  }
  const implemented = manifest.capabilities.tools.filter((tool) => tool.implemented === true);
  assert.ok(implemented.length >= 5);
  for (const tool of implemented) {
    assert.equal(typeof moduleEntry.tools[tool.name], 'function', `缺少能力实现 ${tool.name}`);
  }
  assert.equal(typeof moduleEntry.start, 'function');
  assert.equal(typeof moduleEntry.stop, 'function');
  assert.equal(typeof moduleEntry.health, 'function');
});

test('start / health / stop 生命周期：停止后路由明确返回未就绪而非假数据', async () => {
  await moduleEntry.start({ config: {}, logger: { info() {}, warn() {}, error() {} } });
  try {
    const health = await moduleEntry.health();
    assert.equal(health.ok, true);
  } finally {
    await moduleEntry.stop();
  }
  const after = await moduleEntry.health();
  assert.equal(after.ok, false);

  const route = moduleEntry.routes.find((item) => item.method === 'GET' && item.path === '/api/paper/docs');
  const out = await route.handler({
    url: new URL('http://localhost/api/paper/docs'),
    params: {},
    query: {},
    body: {},
    user: { id: 'user-a' }
  });
  assert.equal(out.status, 503);
  assert.equal(out.body.code, 'MODULE_NOT_READY');
});

test('server/dev.js 语法有效，且只监听 127.0.0.1:0、支持 --once', async () => {
  const devPath = path.join(moduleRoot, 'server', 'dev.js');
  // 只用 node --check 做语法校验，不在此启动 HTTP（业务用例一律直接调用 handler）。
  await execFileAsync(process.execPath, ['--check', devPath], { timeout: 20000 });
  const source = fs.readFileSync(devPath, 'utf8');
  assert.match(source, /--once/);
  assert.match(source, /127\.0\.0\.1/);
  assert.match(source, /server\.listen\(0/);
  assert.match(source, /JSON\.stringify\(\{ url \}\)/);
  assert.match(source, /require\('node:http'\)/);
});

test('核心 ModuleHost 能安装并启用 paper 模块（清单路径、配置 schema、生命周期真实可用）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagesai-paper-host-'));
  const config = { dataFile: path.join(dir, 'paper.json'), uploadsDir: path.join(dir, 'uploads') };
  const host = new ModuleHost({
    modulesRoot: path.join(moduleRoot, '..'),
    configProvider: (id) => (id === 'paper' ? config : undefined)
  });
  try {
    host.install(readJson('manifest.json'));
    const state = await host.enable('paper');
    assert.equal(state.ready, true);
    assert.equal(state.configured, true);
    assert.equal((await host.health('paper')).ok, true);
  } finally {
    await host.disable('paper').catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
