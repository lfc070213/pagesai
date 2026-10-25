'use strict';
// Pages 模块持久化与配置边界测试：JsonStore 落盘/重启、纯内存模式、损坏数据拒绝启动。
// 运行：node --test modules/pages/tests/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const moduleRoot = path.join(__dirname, '..');
const repoRoot = path.join(moduleRoot, '..', '..');
const pages = require(path.join(moduleRoot, 'server', 'index.js'));
const { codes } = require(path.join(repoRoot, 'core', 'errors.js'));

const silent = { info() {}, warn() {}, error() {} };
const ALICE = Object.freeze({ id: 'user-persist', username: 'persist', role: 'user' });

function fakeCtx({ method = 'GET', params = {}, query = {}, body = {}, user = null } = {}) {
  return { req: { method, headers: {} }, res: {}, url: new URL('http://127.0.0.1/'), params, query, body, user };
}

async function invoke(method, routePath, options = {}) {
  const route = pages.routes.find((candidate) => candidate.method === method && candidate.path === routePath);
  assert.ok(route, `缺少路由 ${method} ${routePath}`);
  return route.handler(fakeCtx({
    method,
    params: options.params || {},
    query: options.query || {},
    body: options.body || {},
    user: options.user === undefined ? null : options.user
  }));
}

async function createSite(slug) {
  const response = await invoke('POST', '/api/pages/sites', {
    user: ALICE,
    body: { name: '持久化站点', slug }
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.site;
}

async function writeAndPublish(siteId, content) {
  const written = await invoke('PUT', '/api/pages/sites/:siteId/files/*', {
    user: ALICE,
    params: { siteId, filePath: 'index.html' },
    body: { content }
  });
  assert.equal(written.status, 200);
  const published = await invoke('POST', '/api/pages/sites/:siteId/publish', {
    user: ALICE,
    params: { siteId }
  });
  assert.equal(published.status, 201, JSON.stringify(published.body));
  return published.body;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pagesai-pages-test-'));
}

test('config.dataFile 落盘：重启后站点、文件与发布快照仍在', async () => {
  const dir = makeTempDir();
  const dataFile = path.join(dir, 'pages.json');
  try {
    await pages.start({ config: { dataFile }, logger: silent });
    const site = await createSite('persist-site');
    const published = await writeAndPublish(site.id, '<h1>重启后仍在</h1>');
    const healthBefore = await pages.health();
    assert.equal(healthBefore.storage, 'file');
    await pages.stop();

    assert.ok(fs.existsSync(dataFile), '数据文件应已写入');
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.ok(raw.sites && raw.sites[site.id], '站点应落在 sites 集合');
    assert.equal(raw.slugs['persist-site'], site.id);

    await pages.start({ config: { dataFile }, logger: silent });
    const listed = await invoke('GET', '/api/pages/sites', { user: ALICE });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.sites.map((item) => item.id), [site.id]);
    assert.equal(listed.body.sites[0].publishedVersion, 1);

    const file = await invoke('GET', '/api/pages/sites/:siteId/files/*', {
      user: ALICE,
      params: { siteId: site.id, filePath: 'index.html' }
    });
    assert.equal(file.status, 200);
    assert.equal(file.body.file.content, '<h1>重启后仍在</h1>');

    const live = await invoke('GET', '/api/pages/public/:slug/*', {
      user: null,
      params: { slug: 'persist-site', filePath: 'index.html' }
    });
    assert.equal(live.status, 200);
    assert.equal(live.body.content, '<h1>重启后仍在</h1>');
    assert.equal(live.body.version, published.version);
    assert.equal(live.body.contentHash, published.contentHash);
  } finally {
    await pages.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config.dataFile 缺省时纯内存运行，重启即清空', async () => {
  await pages.start({ config: {}, logger: silent });
  const site = await createSite('memory-site');
  await writeAndPublish(site.id, 'memory');
  const before = await invoke('GET', '/api/pages/sites', { user: ALICE });
  assert.equal(before.body.sites.length, 1);
  assert.equal((await pages.health()).storage, 'memory');
  await pages.stop();

  await pages.start({ config: {}, logger: silent });
  const after = await invoke('GET', '/api/pages/sites', { user: ALICE });
  assert.deepEqual(after.body.sites, []);
  await pages.stop();
});

test('重复 start 幂等：不清空内存数据，也不重复装载', async () => {
  await pages.start({ config: {}, logger: silent });
  const site = await createSite('idempotent-site');
  const again = await pages.start({ config: {}, logger: silent });
  assert.equal(again.ok, true);
  assert.equal(again.alreadyStarted, true);
  const listed = await invoke('GET', '/api/pages/sites', { user: ALICE });
  assert.deepEqual(listed.body.sites.map((item) => item.id), [site.id]);
  await pages.stop();
});

test('数据文件损坏时拒绝启动，而不是静默重建空状态', async () => {
  const dir = makeTempDir();
  const dataFile = path.join(dir, 'broken.json');
  try {
    fs.writeFileSync(dataFile, '{ not valid json');
    await assert.rejects(
      pages.start({ config: { dataFile }, logger: silent }),
      (err) => err.code === codes.CONFIG_INVALID
    );
    assert.equal((await pages.health()).ok, false);
  } finally {
    await pages.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('非法 aiAdapter 配置在启动阶段明确失败（不是运行期伪造结果）', async () => {
  await assert.rejects(
    pages.start({ config: { aiAdapter: {} }, logger: silent }),
    (err) => err.code === codes.CONFIG_INVALID
  );
  assert.equal((await pages.health()).ok, false);
  await pages.stop();
});
