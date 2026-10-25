'use strict';

const { CoreError, codes } = require('../../../core/errors.js');

const PAGES_SCHEMA_VERSION = 1;
const COLLECTIONS = Object.freeze({
  sites: 'pages_sites',
  models: 'pages_models',
  tasks: 'pages_tasks',
  backends: 'pages_backends'
});

function duplicateKey(error) {
  return Boolean(error && (error.code === 11000 || error.code === 11001));
}

function clean(document) {
  if (!document) return null;
  const { _id, ...record } = document;
  return structuredClone({ ...record, id: record.id || _id });
}

class PagesRepository {
  constructor({ db, deploymentId, allowInitialize = false, clock = () => Date.now() }) {
    if (!db || !deploymentId) throw new CoreError(codes.CONFIG_INVALID, 'Pages 正式仓库需要 Mongo DB 与 deploymentId', { status: 500 });
    this.db = db;
    this.deploymentId = deploymentId;
    this.allowInitialize = allowInitialize;
    this.clock = clock;
    this.collections = Object.fromEntries(Object.entries(COLLECTIONS).map(([key, name]) => [key, db.collection(name)]));
    // 单进程内的站点写锁：嵌入式文件表必须串行读改写，避免并发保存互相覆盖。
    this.siteLocks = new Map();
  }

  now() { return new Date(this.clock()).toISOString(); }

  async migrate() {
    const metadata = this.db.collection('runtime_metadata');
    let current = await metadata.findOne({ _id: 'pages' });
    if (!current) {
      if (!this.allowInitialize) throw new CoreError(codes.CONFIG_INVALID, 'Pages 元数据尚未登记；请显式初始化', { status: 500 });
      try {
        await metadata.insertOne({ _id: 'pages', schemaVersion: PAGES_SCHEMA_VERSION, deploymentId: this.deploymentId, createdAt: this.now() });
      } catch (error) { if (!duplicateKey(error)) throw error; }
      current = await metadata.findOne({ _id: 'pages' });
    }
    if (!current || current.deploymentId !== this.deploymentId || current.schemaVersion !== PAGES_SCHEMA_VERSION) {
      throw new CoreError(codes.CONFIG_INVALID, 'Pages 数据模式或 deploymentId 不匹配', { status: 500 });
    }
    await this.collections.sites.createIndex({ slug: 1 }, { unique: true, name: 'pages_site_slug' });
    await this.collections.sites.createIndex({ ownerId: 1, createdAt: 1 }, { name: 'pages_site_owner' });
    await this.collections.models.createIndex({ enabled: 1, sort: 1 }, { name: 'pages_model_enabled' });
    await this.collections.tasks.createIndex({ ownerId: 1, createdAt: -1 }, { name: 'pages_task_owner' });
    await this.collections.tasks.createIndex({ status: 1, updatedAt: 1 }, { name: 'pages_task_recovery' });
    await this.collections.backends.createIndex({ ownerId: 1 }, { name: 'pages_backend_owner' });
    return { schemaVersion: PAGES_SCHEMA_VERSION, deploymentId: this.deploymentId };
  }

  async insertSite(site) {
    try { await this.collections.sites.insertOne({ ...site, _id: site.id }); }
    catch (error) {
      if (duplicateKey(error)) throw new CoreError('pages.slug_taken', 'slug 已被占用', { status: 409 });
      throw error;
    }
    return site;
  }

  async getSite(id) { return clean(await this.collections.sites.findOne({ _id: id })); }
  async getSiteBySlug(slug) { return clean(await this.collections.sites.findOne({ slug })); }
  async listSites(ownerId) {
    return (await this.collections.sites.find({ ownerId }).sort({ createdAt: 1 }).toArray()).map(clean);
  }

  /**
   * 带修订号的站点整文档替换。并发写者拿到旧 revision 时明确报 409，
   * 而不是静默覆盖对方刚写入的文件表。
   */
  async replaceSite(site) {
    const expected = Number.isInteger(site.revision) ? site.revision : 0;
    const { _id, ...document } = site;
    const update = { $set: { ...document, revision: expected + 1 } };
    let saved;
    try {
      saved = await this.collections.sites.findOneAndUpdate(
        { _id: site.id, revision: expected },
        update,
        { returnDocument: 'after' }
      );
      if (!saved && expected === 0) {
        // 兼容迁移前没有 revision 字段的旧文档。
        saved = await this.collections.sites.findOneAndUpdate(
          { _id: site.id, revision: { $exists: false } },
          { $set: { ...document, revision: 1 } },
          { returnDocument: 'after' }
        );
      }
    } catch (error) {
      if (duplicateKey(error)) throw new CoreError('pages.slug_taken', 'slug 已被占用', { status: 409 });
      throw error;
    }
    if (!saved) throw new CoreError('pages.site_conflict', '站点元数据已被并发修改，请重试', { status: 409 });
    return clean(saved);
  }

  async withSiteLock(siteId, task) {
    const previous = this.siteLocks.get(siteId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate, () => gate);
    this.siteLocks.set(siteId, tail);
    await previous.catch(() => {});
    try { return await task(); }
    finally {
      release();
      if (this.siteLocks.get(siteId) === tail) this.siteLocks.delete(siteId);
    }
  }

  /**
   * 在站点写锁内重新读取最新文档并提交变更。
   * mutator 同步或异步修改传入的站点副本；返回值原样返回给调用方。
   */
  async mutateSite(siteId, mutator, { attempts = 3 } = {}) {
    return this.withSiteLock(siteId, async () => {
      let lastError = null;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const site = await this.getSite(siteId);
        if (!site) throw new CoreError(codes.NOT_FOUND, '站点不存在', { status: 404 });
        const working = structuredClone(site);
        const result = await mutator(working);
        try {
          working.updatedAt = this.now();
          const saved = await this.replaceSite(working);
          working.revision = saved.revision;
          return result;
        } catch (error) {
          if (error && error.status === 409) { lastError = error; continue; }
          throw error;
        }
      }
      throw lastError || new CoreError('pages.site_conflict', '站点元数据并发更新失败，请重试', { status: 409 });
    });
  }

  async deleteSite(id) { await this.collections.sites.deleteOne({ _id: id }); }

  async listModels({ enabledOnly = false } = {}) {
    const query = enabledOnly ? { enabled: true } : {};
    return (await this.collections.models.find(query).sort({ sort: 1, _id: 1 }).toArray()).map(clean);
  }
  async getModel(id) { return clean(await this.collections.models.findOne({ _id: id })); }
  async putModel(model) {
    await this.collections.models.replaceOne({ _id: model.id }, { ...model, _id: model.id }, { upsert: true });
    return model;
  }
  async deleteModel(id) { return (await this.collections.models.deleteOne({ _id: id })).deletedCount > 0; }

  async createTask(task) {
    await this.collections.tasks.insertOne({ ...task, _id: task.id });
    return task;
  }
  async getTask(id) { return clean(await this.collections.tasks.findOne({ _id: id })); }
  async listTasks(ownerId, siteId = null, limit = 100) {
    const query = { ownerId, ...(siteId ? { siteId } : {}) };
    return (await this.collections.tasks.find(query).sort({ createdAt: -1 }).limit(limit).toArray()).map(clean);
  }
  async updateTask(id, patch) {
    return clean(await this.collections.tasks.findOneAndUpdate(
      { _id: id },
      { $set: { ...patch, updatedAt: this.now() } },
      { returnDocument: 'after' }
    ));
  }
  async claimTask(id, patch) {
    return clean(await this.collections.tasks.findOneAndUpdate(
      { _id: id, status: 'queued' },
      { $set: { ...patch, updatedAt: this.now() } },
      { returnDocument: 'after' }
    ));
  }
  /**
   * 条件状态迁移：只有当前状态在 fromStatuses 内才更新。
   * 并发取消/完成/失败时只有第一个迁移生效，不会互相覆盖终态。
   */
  async transitionTask(id, fromStatuses, patch) {
    const statuses = Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses];
    return clean(await this.collections.tasks.findOneAndUpdate(
      { _id: id, status: { $in: statuses } },
      { $set: { ...patch, updatedAt: this.now() } },
      { returnDocument: 'after' }
    ));
  }
  async pushTaskEvent(id, event) {
    const sequence = (event && event.sequence) || `${Date.now()}-${Math.random()}`;
    await this.collections.tasks.updateOne(
      { _id: id },
      {
        $push: { events: { $each: [{ ...event, sequence, at: event.at || this.now() }], $slice: -500 } },
        $inc: { eventSequence: 1 },
        $set: { updatedAt: this.now() }
      }
    );
  }
  async tasksInStatuses(statuses) {
    return (await this.collections.tasks.find({ status: { $in: statuses } }).toArray()).map(clean);
  }

  async getBackend(siteId) { return clean(await this.collections.backends.findOne({ _id: siteId })); }
  async putBackend(backend) {
    await this.collections.backends.replaceOne({ _id: backend.siteId }, { ...backend, _id: backend.siteId }, { upsert: true });
    return backend;
  }
  async listBackends() { return (await this.collections.backends.find({}).toArray()).map(clean); }
}

module.exports = { PagesRepository, PAGES_SCHEMA_VERSION, clean };
