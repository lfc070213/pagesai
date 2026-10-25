'use strict';
// Pages 站点元数据与任务的并发一致性（真实 MongoDB，显式测试开关）。
// 不读取生产配置；使用 mongodb-memory-server 的临时实例。

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const ENABLED = process.env.PAGESAI_MONGO_TEST === '1';

let mongo = null;
let client = null;
let repository = null;
let PagesRepository = null;

async function siteFixture(repository) {
  const now = repository.now();
  const site = {
    id: crypto.randomUUID(), ownerId: 'owner-1', name: 'Concurrency', slug: `c-${crypto.randomBytes(4).toString('hex')}`,
    description: '', files: {}, fileHeads: {}, materials: {}, versions: [], nextVersion: 1,
    publishedVersion: null, revision: 0, previewToken: 'token', createdAt: now, updatedAt: now
  };
  await repository.insertSite(site);
  return site.id;
}

test.before(async () => {
  if (!ENABLED) return;
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const { MongoClient } = require('mongodb');
  ({ PagesRepository } = require('../server/repository.js'));
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri(), { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  repository = new PagesRepository({ db: client.db('pages_concurrency'), deploymentId: 'concurrency-deployment', allowInitialize: true });
  await repository.migrate();
});

test.after(async () => {
  if (client) await client.close().catch(() => {});
  if (mongo) await mongo.stop().catch(() => {});
});

test('并发 mutateSite 不得丢失任何一次文件写入', { skip: !ENABLED && '需要 PAGESAI_MONGO_TEST=1' }, async () => {
  const siteId = await siteFixture(repository);
  const writers = Array.from({ length: 20 }, (_, index) => repository.mutateSite(siteId, async (site) => {
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
    site.files[`page-${index}.html`] = { fileId: `file-${index}`, revision: 1, size: 10, contentType: 'text/html; charset=utf-8' };
  }));
  await Promise.all(writers);
  const saved = await repository.getSite(siteId);
  assert.equal(Object.keys(saved.files).length, 20);
  for (let index = 0; index < 20; index += 1) assert.ok(saved.files[`page-${index}.html`]);
  assert.equal(saved.revision, 20);
});

test('旧 revision 的整文档替换必须报冲突而不是静默覆盖', { skip: !ENABLED && '需要 PAGESAI_MONGO_TEST=1' }, async () => {
  const siteId = await siteFixture(repository);
  const first = await repository.getSite(siteId);
  const stale = await repository.getSite(siteId);
  first.files['a.html'] = { fileId: 'a', revision: 1, size: 1 };
  await repository.replaceSite(first);
  stale.files['b.html'] = { fileId: 'b', revision: 1, size: 1 };
  await assert.rejects(repository.replaceSite(stale), (error) => error.code === 'pages.site_conflict' && error.status === 409);
  const saved = await repository.getSite(siteId);
  assert.deepEqual(Object.keys(saved.files), ['a.html']);
});

test('同一任务状态迁移只能有一个赢家', { skip: !ENABLED && '需要 PAGESAI_MONGO_TEST=1' }, async () => {
  const now = repository.now();
  const id = crypto.randomUUID();
  await repository.createTask({
    id, ownerId: 'owner-1', siteId: 'site-1', status: 'queued', events: [],
    createdAt: now, updatedAt: now, expiresAt: now
  });
  const results = await Promise.all(Array.from({ length: 10 }, () => repository.transitionTask(id, ['queued'], { status: 'running' })));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await repository.getTask(id)).status, 'running');
  assert.equal(await repository.transitionTask(id, ['queued'], { status: 'cancelled' }), null);
});

test('mutateSite 对不存在的站点返回 404', { skip: !ENABLED && '需要 PAGESAI_MONGO_TEST=1' }, async () => {
  await assert.rejects(repository.mutateSite(crypto.randomUUID(), async () => {}), (error) => error.status === 404);
});
