'use strict';
// Pages 模块验收测试：直接调用 route.handler（构造 fake ctx），不启动 HTTP。
// 覆盖：清单契约、站点隔离、路径越界、发布/公开访问、AI 未配置/已配置、回滚、工具授权。
// 运行：node --test modules/pages/tests/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const moduleRoot = path.join(__dirname, '..');
const repoRoot = path.join(moduleRoot, '..', '..');
const pages = require(path.join(moduleRoot, 'server', 'index.js'));
const { validateManifest } = require(path.join(repoRoot, 'core', 'registry', 'manifest.js'));
const { validate } = require(path.join(repoRoot, 'core', 'contracts', 'validate.js'));
const { codes } = require(path.join(repoRoot, 'core', 'errors.js'));

const silent = { info() {}, warn() {}, error() {} };
const ALICE = Object.freeze({ id: 'user-alice', username: 'alice', role: 'user' });
const BOB = Object.freeze({ id: 'user-bob', username: 'bob', role: 'user' });
let slugSeq = 0;

function fakeCtx({ method = 'GET', urlPath = '/', params = {}, query = {}, body = {}, user = null } = {}) {
  return {
    req: { method, headers: {} },
    res: {},
    url: new URL(`http://127.0.0.1${urlPath}`),
    params,
    query,
    body,
    user
  };
}

async function invoke(method, routePath, options = {}) {
  const route = pages.routes.find((candidate) => candidate.method === method && candidate.path === routePath);
  assert.ok(route, `缺少路由 ${method} ${routePath}`);
  return route.handler(fakeCtx({
    method,
    urlPath: routePath,
    params: options.params || {},
    query: options.query || {},
    body: options.body || {},
    user: options.user === undefined ? null : options.user
  }));
}

async function createSite(user = ALICE, extra = {}) {
  slugSeq += 1;
  const response = await invoke('POST', '/api/pages/sites', {
    user,
    body: { name: `演示站点 ${slugSeq}`, slug: `site-${slugSeq}`, ...extra }
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.site;
}

async function putFile(user, siteId, filePath, content, extra = {}) {
  return invoke('PUT', '/api/pages/sites/:siteId/files/*', {
    user,
    params: { siteId, filePath },
    body: { content, ...extra }
  });
}

async function publish(user, siteId) {
  const response = await invoke('POST', '/api/pages/sites/:siteId/publish', {
    user,
    params: { siteId }
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

async function readFile(user, siteId, filePath, paramsOverride = null) {
  return invoke('GET', '/api/pages/sites/:siteId/files/*', {
    user,
    params: paramsOverride || { siteId, filePath }
  });
}

async function publicGet(slug, filePath, query = {}) {
  const params = filePath === undefined ? { slug } : { slug, filePath };
  return invoke('GET', '/api/pages/public/:slug/*', { user: null, params, query });
}

test.beforeEach(async () => {
  await pages.start({ config: {}, logger: silent });
});

test.afterEach(async () => {
  await pages.stop();
});

test('清单通过契约校验，路由前缀、生命周期与能力声明一致', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'manifest.json'), 'utf8'));
  assert.doesNotThrow(() => validateManifest(manifest));
  assert.equal(manifest.id, 'pages');
  assert.match(manifest.version, /^\d+\.\d+\.\d+/);
  assert.equal(manifest.activation.routePrefix, '/api/pages');
  assert.equal(manifest.activation.serverEntry, 'server/index.js');
  assert.deepEqual(manifest.requires.infrastructure, []);
  assert.ok(manifest.data.namespace === 'pages');
  assert.deepEqual(manifest.data.regions, ['pages.sites', 'pages.materials', 'pages.ai-workspace', 'pages.backends']);
  assert.deepEqual(manifest.config.secrets, []);
  assert.equal(typeof pages.start, 'function');
  assert.equal(typeof pages.stop, 'function');
  assert.equal(typeof pages.health, 'function');

  for (const route of pages.routes) {
    assert.ok(route.path.startsWith('/api/pages/'), `${route.path} 必须落在 /api/pages/ 下`);
    assert.equal(typeof route.handler, 'function');
    assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method));
  }

  const declared = manifest.capabilities.tools
    .filter((tool) => tool.implemented === true)
    .map((tool) => `${tool.access}:${tool.name}`)
    .sort();
  const exported = Object.keys(pages.tools).map((name) => {
    const tool = manifest.capabilities.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} 未在清单中声明`);
    assert.equal(typeof pages.tools[name], 'function');
    return `${tool.access}:${name}`;
  }).sort();
  assert.deepEqual(exported, declared);
});

test('配置 schema 可校验空配置与秘密字段，未知字段被拒绝', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'config.schema.json'), 'utf8'));
  assert.deepEqual(validate(schema, {}), { valid: true, errors: [] });
  const accepted = validate(schema, {
    dataFile: '/tmp/pages.json',
    maxFileBytes: 2048,
    backendProxyTimeoutMs: 30000,
    tenantMongoKeyRef: 'env:PAGESAI_TENANT_MONGO_URL',
    taskTimeoutMs: 120000,
    ai: { provider: 'openai-compatible', model: 'demo', apiKey: 'secret-value' },
    aiAdapter: async () => ({ files: { 'index.html': 'ok' } })
  });
  assert.equal(accepted.valid, true, JSON.stringify(accepted.errors));
  assert.equal(validate(schema, { tenantMongoKeyRef: 'PAGESAI_TENANT_MONGO_URL' }).valid, false);
  assert.equal(validate(schema, { unknownField: true }).valid, false);
});

test('站点 CRUD 按 ownerId 隔离；未认证写操作 403', async () => {
  const unauthCreate = await invoke('POST', '/api/pages/sites', { body: { name: 'x' } });
  assert.equal(unauthCreate.status, 403);
  assert.equal(unauthCreate.body.code, codes.FORBIDDEN);

  const unauthRead = await invoke('GET', '/api/pages/sites');
  assert.equal(unauthRead.status, 401);
  assert.equal(unauthRead.body.code, codes.SESSION_INVALID);

  const site = await createSite(ALICE, { name: 'Alice 首页', slug: 'alice-home', description: '第一个站点' });
  assert.equal(site.ownerId, ALICE.id);
  assert.equal(site.slug, 'alice-home');
  assert.equal(site.publishedVersion, null);

  const aliceList = await invoke('GET', '/api/pages/sites', { user: ALICE });
  assert.equal(aliceList.status, 200);
  assert.equal(aliceList.body.sites.length, 1);
  assert.equal(aliceList.body.sites[0].id, site.id);

  const bobList = await invoke('GET', '/api/pages/sites', { user: BOB });
  assert.equal(bobList.status, 200);
  assert.deepEqual(bobList.body.sites, []);

  for (const [method, routePath, body] of [
    ['GET', '/api/pages/sites/:siteId', {}],
    ['PATCH', '/api/pages/sites/:siteId', { name: '被篡改' }],
    ['DELETE', '/api/pages/sites/:siteId', {}],
    ['GET', '/api/pages/sites/:siteId/files', {}],
    ['POST', '/api/pages/sites/:siteId/publish', {}],
    ['POST', '/api/pages/sites/:siteId/rollback', {}],
    ['POST', '/api/pages/sites/:siteId/ai', { prompt: 'x' }]
  ]) {
    const denied = await invoke(method, routePath, { user: BOB, params: { siteId: site.id }, body });
    assert.equal(denied.status, 403, `${method} ${routePath}`);
    assert.equal(denied.body.code, codes.FORBIDDEN);
  }

  const duplicated = await invoke('POST', '/api/pages/sites', {
    user: ALICE,
    body: { name: '重复 slug', slug: 'alice-home' }
  });
  assert.equal(duplicated.status, 409);
  assert.equal(duplicated.body.code, 'pages.slug_taken');

  const updated = await invoke('PATCH', '/api/pages/sites/:siteId', {
    user: ALICE,
    params: { siteId: site.id },
    body: { name: 'Alice 新首页', description: '' }
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.site.name, 'Alice 新首页');

  const deleted = await invoke('DELETE', '/api/pages/sites/:siteId', { user: ALICE, params: { siteId: site.id } });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { ok: true, id: site.id });

  const gone = await invoke('GET', '/api/pages/sites/:siteId', { user: ALICE, params: { siteId: site.id } });
  assert.equal(gone.status, 404);

  // 删除后 slug 释放，可重新创建
  const recreated = await createSite(ALICE, { slug: 'alice-home' });
  assert.equal(recreated.slug, 'alice-home');
});

test('文件读写删；越界路径一律 400，且跨用户写被拒', async () => {
  const site = await createSite(ALICE);

  const created = await putFile(ALICE, site.id, 'index.html', '<h1>v1</h1>');
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.created, true);
  assert.equal(created.body.file.contentType, 'text/html; charset=utf-8');

  const read = await readFile(ALICE, site.id, 'index.html');
  assert.equal(read.status, 200);
  assert.equal(read.body.file.content, '<h1>v1</h1>');

  // 兼容公共核心的 params.wildcard 命名
  const viaWildcard = await readFile(ALICE, site.id, null, { siteId: site.id, wildcard: 'index.html' });
  assert.equal(viaWildcard.status, 200);
  assert.equal(viaWildcard.body.file.content, '<h1>v1</h1>');

  const viaPath = await readFile(ALICE, site.id, null, { siteId: site.id, path: 'index.html' });
  assert.equal(viaPath.status, 200);
  assert.equal(viaPath.body.file.content, '<h1>v1</h1>');

  const nested = await putFile(ALICE, site.id, 'assets/app.js', 'console.log(1);', {
    contentType: 'text/javascript; charset=utf-8'
  });
  assert.equal(nested.status, 200);
  assert.equal(nested.body.created, true);

  const listed = await invoke('GET', '/api/pages/sites/:siteId/files', { user: ALICE, params: { siteId: site.id } });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.files.map((file) => file.path), ['assets/app.js', 'index.html']);

  const missing = await readFile(ALICE, site.id, 'nope.html');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'pages.file_not_found');

  const traversalPaths = [
    '../secret.html',
    '/etc/passwd.html',
    'a/../../b.html',
    'a/./b.html',
    'a//b.html',
    '..%2fsecret.html',
    '%252e%252e%252fsecret.html',
    'C:/windows/x.html',
    'a\\b.html'
  ];
  for (const traversal of traversalPaths) {
    const escaped = await putFile(ALICE, site.id, traversal, 'x');
    assert.equal(escaped.status, 400, traversal);
    assert.equal(escaped.body.code, codes.PATH_ESCAPE, traversal);
  }

  for (const unsupported of ['README', 'run.exe']) {
    const rejected = await putFile(ALICE, site.id, unsupported, 'x');
    assert.equal(rejected.status, 400, unsupported);
    assert.equal(rejected.body.code, 'pages.unsupported_file_type', unsupported);
  }

  const badContent = await putFile(ALICE, site.id, 'x.html', 123);
  assert.equal(badContent.status, 400);
  assert.equal(badContent.body.code, codes.INVALID_INPUT);

  const bobWrite = await putFile(BOB, site.id, 'index.html', '<h1>hack</h1>');
  assert.equal(bobWrite.status, 403);
  assert.equal(bobWrite.body.code, codes.FORBIDDEN);

  const unauthWrite = await putFile(null, site.id, 'index.html', 'x');
  assert.equal(unauthWrite.status, 403);

  const deleted = await invoke('DELETE', '/api/pages/sites/:siteId/files/*', {
    user: ALICE,
    params: { siteId: site.id, filePath: 'assets/app.js' }
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.fileCount, 1);

  const deletedAgain = await invoke('DELETE', '/api/pages/sites/:siteId/files/*', {
    user: ALICE,
    params: { siteId: site.id, filePath: 'assets/app.js' }
  });
  assert.equal(deletedAgain.status, 404);
});

test('发布生成 version/contentHash；公开访问只读且不依赖 user', async () => {
  const site = await createSite(ALICE);
  const unpublished = await publicGet(site.slug, 'index.html');
  assert.equal(unpublished.status, 404);
  assert.equal(unpublished.body.code, 'pages.not_published');

  await putFile(ALICE, site.id, 'index.html', '<h1>v1</h1>');
  await putFile(ALICE, site.id, 'assets/app.css', 'body{color:red}');
  const first = await publish(ALICE, site.id);
  assert.equal(first.version, 1);
  assert.match(first.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(first.fileCount, 2);
  assert.equal(first.publicPath, `/api/pages/public/${site.slug}/`);

  const published = await publicGet(site.slug, 'index.html');
  assert.equal(published.status, 200);
  assert.equal(published.body.content, '<h1>v1</h1>');
  assert.equal(published.body.contentType, 'text/html; charset=utf-8');
  assert.equal(published.body.version, 1);
  assert.equal(published.body.contentHash, first.contentHash);
  assert.equal(JSON.stringify(published.body).includes('ownerId'), false);

  const root = await publicGet(site.slug);
  assert.equal(root.status, 200);
  assert.equal(root.body.path, 'index.html');

  const raw = await publicGet(site.slug, 'assets/app.css', { raw: '1' });
  assert.equal(raw.status, 200);
  assert.equal(raw.body, 'body{color:red}');
  assert.match(raw.headers['content-type'], /^text\/css/);
  assert.match(raw.headers['content-security-policy'], /sandbox/);

  const missing = await publicGet(site.slug, 'missing.html');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'pages.file_not_found');

  const unknown = await publicGet('no-such-site', 'index.html');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, 'pages.site_not_found');

  // 发布后继续改工作文件，不重新发布则公开内容不变（快照隔离）
  await putFile(ALICE, site.id, 'index.html', '<h1>v2 draft</h1>');
  const stillV1 = await publicGet(site.slug, 'index.html');
  assert.equal(stillV1.body.content, '<h1>v1</h1>');
  assert.equal(stillV1.body.version, 1);

  const second = await publish(ALICE, site.id);
  assert.equal(second.version, 2);
  assert.notEqual(second.contentHash, first.contentHash);
  const nowV2 = await publicGet(site.slug, 'index.html');
  assert.equal(nowV2.body.content, '<h1>v2 draft</h1>');
  assert.equal(nowV2.body.version, 2);

  // 内容不变时重复发布：版本递增，contentHash 稳定
  const third = await publish(ALICE, site.id);
  assert.equal(third.version, 3);
  assert.equal(third.contentHash, second.contentHash);

  const versions = await invoke('GET', '/api/pages/sites/:siteId/versions', {
    user: ALICE,
    params: { siteId: site.id }
  });
  assert.equal(versions.status, 200);
  assert.equal(versions.body.publishedVersion, 3);
  assert.deepEqual(versions.body.versions.map((item) => item.version), [3, 2, 1]);
  assert.equal(versions.body.versions[0].isPublished, true);
  assert.equal(versions.body.versions[1].isPublished, false);
});

test('回滚上一版本生效（工作文件与公开指针同时恢复）', async () => {
  const site = await createSite(ALICE);
  await putFile(ALICE, site.id, 'index.html', '<h1>版本一</h1>');
  await publish(ALICE, site.id);

  await putFile(ALICE, site.id, 'index.html', '<h1>版本二</h1>');
  await publish(ALICE, site.id);

  const beforeRollback = await publicGet(site.slug, 'index.html');
  assert.equal(beforeRollback.body.content, '<h1>版本二</h1>');

  const rolled = await invoke('POST', '/api/pages/sites/:siteId/rollback', {
    user: ALICE,
    params: { siteId: site.id },
    body: {}
  });
  assert.equal(rolled.status, 200, JSON.stringify(rolled.body));
  assert.equal(rolled.body.rolledBackTo, 1);
  assert.equal(rolled.body.from, 2);

  const afterRollback = await publicGet(site.slug, 'index.html');
  assert.equal(afterRollback.status, 200);
  assert.equal(afterRollback.body.content, '<h1>版本一</h1>');
  assert.equal(afterRollback.body.version, 1);

  const working = await readFile(ALICE, site.id, 'index.html');
  assert.equal(working.body.file.content, '<h1>版本一</h1>');

  const versionsAfter = await invoke('GET', '/api/pages/sites/:siteId/versions', {
    user: ALICE,
    params: { siteId: site.id }
  });
  assert.equal(versionsAfter.body.versions.find((item) => item.version === 1).isPublished, true);

  // 显式回滚到指定版本同样生效
  const forward = await invoke('POST', '/api/pages/sites/:siteId/rollback', {
    user: ALICE,
    params: { siteId: site.id },
    body: { version: 2 }
  });
  assert.equal(forward.status, 200);
  assert.equal(forward.body.rolledBackTo, 2);
  assert.equal((await publicGet(site.slug, 'index.html')).body.content, '<h1>版本二</h1>');

  const invalidVersion = await invoke('POST', '/api/pages/sites/:siteId/rollback', {
    user: ALICE,
    params: { siteId: site.id },
    body: { version: 99 }
  });
  assert.equal(invalidVersion.status, 404);
  assert.equal(invalidVersion.body.code, 'pages.version_not_found');

  const single = await createSite(ALICE);
  await putFile(ALICE, single.id, 'index.html', 'only');
  await publish(ALICE, single.id);
  const noPrevious = await invoke('POST', '/api/pages/sites/:siteId/rollback', {
    user: ALICE,
    params: { siteId: single.id },
    body: {}
  });
  assert.equal(noPrevious.status, 409);
  assert.equal(noPrevious.body.code, 'pages.no_previous_version');

  const bobRollback = await invoke('POST', '/api/pages/sites/:siteId/rollback', {
    user: BOB,
    params: { siteId: site.id },
    body: {}
  });
  assert.equal(bobRollback.status, 403);

  const anonRollback = await invoke('POST', '/api/pages/sites/:siteId/rollback', {
    user: null,
    params: { siteId: site.id },
    body: {}
  });
  assert.equal(anonRollback.status, 403);
});

test('AI 未配置时返回 409 pages.ai_not_configured，且不伪造任何内容', async () => {
  const site = await createSite(ALICE);
  await putFile(ALICE, site.id, 'index.html', '<h1>原始</h1>');
  const published = await publish(ALICE, site.id);

  const denied = await invoke('POST', '/api/pages/sites/:siteId/ai', {
    user: ALICE,
    params: { siteId: site.id },
    body: { prompt: '把标题改成红色' }
  });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.code, 'pages.ai_not_configured');
  assert.equal(JSON.stringify(denied.body).includes('<h1>'), false);

  const unchanged = await readFile(ALICE, site.id, 'index.html');
  assert.equal(unchanged.body.file.content, '<h1>原始</h1>');

  const versions = await invoke('GET', '/api/pages/sites/:siteId/versions', {
    user: ALICE,
    params: { siteId: site.id }
  });
  assert.equal(versions.body.versions.length, 1);
  assert.equal(versions.body.versions[0].contentHash, published.contentHash);

  const publicView = await publicGet(site.slug, 'index.html');
  assert.equal(publicView.body.content, '<h1>原始</h1>');

  const anon = await invoke('POST', '/api/pages/sites/:siteId/ai', {
    user: null,
    params: { siteId: site.id },
    body: { prompt: 'x' }
  });
  assert.equal(anon.status, 403);

  await assert.rejects(
    pages.tools.pages_ai_modify({ siteId: site.id, prompt: 'x' }, { user: ALICE }),
    (err) => err.code === 'pages.ai_not_configured'
  );
});

test('AI 已配置时写入工作文件，发布后才公开生效；适配器异常不落盘', async () => {
  await pages.stop();
  const calls = [];
  let mode = 'ok';
  const adapter = async (payload) => {
    calls.push(payload);
    if (mode === 'throw') throw new Error('upstream 500 with secret sk-should-not-leak');
    if (mode === 'empty') return {};
    if (mode === 'traverse') return { files: { '../evil.html': 'x' } };
    if (mode === 'single') return { content: '<h1>单文件</h1>', path: 'about.html', summary: '单文件结果' };
    return { files: { 'index.html': '<h1>AI 生成</h1>' }, summary: '已生成' };
  };
  await pages.start({ config: { aiAdapter: adapter }, logger: silent });

  const site = await createSite(ALICE);
  await putFile(ALICE, site.id, 'index.html', '<h1>原始</h1>');
  const firstPublish = await publish(ALICE, site.id);

  const applied = await invoke('POST', '/api/pages/sites/:siteId/ai', {
    user: ALICE,
    params: { siteId: site.id },
    body: { prompt: '生成一个新的首页' }
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.summary, '已生成');
  assert.deepEqual(applied.body.changedFiles.map((item) => item.path), ['index.html']);
  assert.equal(applied.body.requiresPublish, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, '生成一个新的首页');
  assert.equal(calls[0].files['index.html'], '<h1>原始</h1>');
  assert.equal(calls[0].site.id, site.id);
  assert.equal(calls[0].user.id, ALICE.id);

  const working = await readFile(ALICE, site.id, 'index.html');
  assert.equal(working.body.file.content, '<h1>AI 生成</h1>');

  // 未发布：公开仍是旧快照
  const stillOld = await publicGet(site.slug, 'index.html');
  assert.equal(stillOld.body.content, '<h1>原始</h1>');
  assert.equal(stillOld.body.version, firstPublish.version);

  await publish(ALICE, site.id);
  const live = await publicGet(site.slug, 'index.html');
  assert.equal(live.body.content, '<h1>AI 生成</h1>');
  assert.equal(live.body.version, firstPublish.version + 1);

  // 相同内容 → 无实际变更，明确失败而不是伪造成功
  mode = 'ok';
  const same = await invoke('POST', '/api/pages/sites/:siteId/ai', {
    user: ALICE,
    params: { siteId: site.id },
    body: { prompt: '保持不变' }
  });
  assert.equal(same.status, 502);
  assert.equal(same.body.code, 'pages.ai_invalid_result');

  mode = 'empty';
  const empty = await invoke('POST', '/api/pages/sites/:siteId/ai', {
    user: ALICE,
    params: { siteId: site.id },
    body: { prompt: '空结果' }
  });
  assert.equal(empty.status, 502);
  assert.equal(empty.body.code, 'pages.ai_invalid_result');

  mode = 'throw';
  const failed = await invoke('POST', '/api/pages/sites/:siteId/ai', {
    user: ALICE,
    params: { siteId: site.id },
    body: { prompt: '触发上游错误' }
  });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.code, 'pages.ai_failed');
  assert.equal(JSON.stringify(failed.body).includes('sk-should-not-leak'), false);
  assert.equal((await readFile(ALICE, site.id, 'index.html')).body.file.content, '<h1>AI 生成</h1>');

  mode = 'traverse';
  const escaped = await invoke('POST', '/api/pages/sites/:siteId/ai', {
    user: ALICE,
    params: { siteId: site.id },
    body: { prompt: '越界路径' }
  });
  assert.equal(escaped.status, 400);
  assert.equal(escaped.body.code, codes.PATH_ESCAPE);

  mode = 'single';
  const single = await invoke('POST', '/api/pages/sites/:siteId/ai', {
    user: ALICE,
    params: { siteId: site.id },
    body: { prompt: '写 about 页' }
  });
  assert.equal(single.status, 200);
  assert.equal(single.body.summary, '单文件结果');
  assert.equal((await readFile(ALICE, site.id, 'about.html')).body.file.content, '<h1>单文件</h1>');
});

test('工具与清单能力一致，只信任可信用户上下文', async () => {
  const site = await createSite(ALICE);
  await putFile(ALICE, site.id, 'index.html', 'tool-base');

  const listed = await pages.tools.pages_list_sites({}, { user: ALICE });
  assert.deepEqual(listed.sites.map((item) => item.id), [site.id]);

  await assert.rejects(pages.tools.pages_list_sites({}, {}), (err) => err.code === codes.FORBIDDEN);

  // 不信任模型参数里的 userId：以可信上下文为准
  const readAsAlice = await pages.tools.pages_read_file(
    { siteId: site.id, path: 'index.html', userId: BOB.id },
    { user: ALICE }
  );
  assert.equal(readAsAlice.file.content, 'tool-base');

  await assert.rejects(
    pages.tools.pages_read_file({ siteId: site.id, path: 'index.html' }, { user: BOB }),
    (err) => err.code === codes.FORBIDDEN
  );

  const written = await pages.tools.pages_write_file(
    { siteId: site.id, path: 'about.html', content: 'tool-about' },
    { user: ALICE }
  );
  assert.equal(written.created, true);

  const createdByTool = await pages.tools.pages_create_site(
    { name: '工具创建站点', slug: 'tool-created-site' },
    { user: ALICE }
  );
  assert.equal(createdByTool.site.slug, 'tool-created-site');
  assert.equal(createdByTool.site.ownerId, ALICE.id);

  const readByTool = await pages.tools.pages_read_site({ siteId: createdByTool.site.id }, { user: ALICE });
  assert.equal(readByTool.site.id, createdByTool.site.id);
  await assert.rejects(
    pages.tools.pages_read_site({ siteId: createdByTool.site.id }, { user: BOB }),
    (err) => err.code === codes.FORBIDDEN
  );

  const published = await pages.tools.pages_publish_site({ siteId: site.id }, { user: ALICE });
  assert.equal(published.version, 1);
  assert.match(published.contentHash, /^[a-f0-9]{64}$/);

  const live = await publicGet(site.slug, 'about.html');
  assert.equal(live.status, 200);
  assert.equal(live.body.content, 'tool-about');

  const deletedByTool = await pages.tools.pages_delete_file(
    { siteId: site.id, path: 'about.html' },
    { user: ALICE }
  );
  assert.equal(deletedByTool.ok, true);
  await assert.rejects(
    pages.tools.pages_delete_file({ siteId: site.id, path: 'index.html' }, { user: BOB }),
    (err) => err.code === codes.FORBIDDEN
  );
});

test('模块信息与健康检查如实反映状态，停用后不再提供业务数据', async () => {
  const info = await invoke('GET', '/api/pages/info');
  assert.equal(info.status, 200);
  assert.equal(info.body.module, 'pages');
  assert.equal(info.body.ready, true);
  assert.equal(info.body.aiConfigured, false);

  const healthy = await pages.health();
  assert.equal(healthy.ok, true);
  assert.equal(healthy.storage, 'memory');
  assert.equal(healthy.aiConfigured, false);

  await pages.stop();
  const afterStop = await pages.health();
  assert.equal(afterStop.ok, false);

  const denied = await invoke('GET', '/api/pages/sites', { user: ALICE });
  assert.equal(denied.status, 503);
  assert.equal(denied.body.code, codes.MODULE_NOT_READY);
});
