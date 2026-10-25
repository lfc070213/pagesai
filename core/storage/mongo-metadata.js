'use strict';
// MongoDB 文件元数据、上传检查点、配额与统一变更事件。
// 所有跨文档提交均在事务内执行；文件内容永远不写入 MongoDB。

const { CoreError, codes } = require('../errors');
const { fileKey } = require('./memory-metadata');

const STORAGE_SCHEMA_VERSION = 1;
const COLLECTIONS = Object.freeze({
  metadata: 'runtime_metadata',
  migrations: 'runtime_migrations',
  regions: 'storage_regions',
  uploads: 'storage_uploads',
  operations: 'storage_operations',
  files: 'storage_files',
  revisions: 'storage_file_revisions',
  events: 'storage_file_events',
  quotas: 'storage_quotas',
  locks: 'storage_file_locks',
  controls: 'storage_controls'
});

function duplicateKey(error) { return Boolean(error && (error.code === 11000 || error.code === 11001)); }
function configError(message, details = null) { return new CoreError(codes.CONFIG_INVALID, message, { status: 500, details }); }
function conflict(message, details = null) { return new CoreError(codes.CONFLICT, message, { status: 409, details }); }
function stateError(message, status = 409) { return new CoreError(codes.UPLOAD_STATE, message, { status }); }
function clean(document) {
  if (!document) return null;
  const { _id, fingerprint, commitFingerprint, ...record } = document;
  return structuredClone(record);
}

class MongoStorageMetadata {
  constructor({ uri, dbName = 'pagesai', client = null, clientOptions = {}, mongo = null, clock = () => Date.now() } = {}) {
    if (!uri && !client) throw configError('MongoDB 文件元数据适配器需要连接 URI 或 client');
    this.uri = uri;
    this.dbName = dbName;
    this.client = client;
    this.clientOptions = { maxPoolSize: 20, ...clientOptions };
    this.mongo = mongo;
    this.clock = clock;
    this.ownsClient = !client;
    this.db = null;
    this.collections = null;
    this.migrated = false;
    this.deploymentId = null;
  }

  async connect() {
    if (this.db) return this.db;
    if (!this.client) {
      let MongoClient;
      try { ({ MongoClient } = this.mongo || require('mongodb')); }
      catch { throw configError('未安装 mongodb 驱动；正式文件元数据不能回落内存'); }
      this.client = new MongoClient(this.uri, this.clientOptions);
    }
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.collections = Object.fromEntries(Object.entries(COLLECTIONS).map(([key, name]) => [key, this.db.collection(name)]));
    return this.db;
  }

  async migrate({ targetVersion = STORAGE_SCHEMA_VERSION, deploymentId, allowInitialize = false, regions = [] } = {}) {
    if (targetVersion !== STORAGE_SCHEMA_VERSION) throw configError('不支持的文件元数据模式版本');
    if (!deploymentId) throw configError('文件元数据迁移需要 deploymentId');
    await this.connect();
    let metadata = await this.collections.metadata.findOne({ _id: 'storage' });
    if (!metadata) {
      if (!allowInitialize) throw configError('文件元数据尚未登记部署；拒绝自动初始化');
      // 与身份共享 runtime_metadata。identity/runtime 已登记时只允许同一 deploymentId。
      const runtime = await this.collections.metadata.findOne({ _id: 'runtime' });
      if (runtime && runtime.deploymentId !== deploymentId) throw configError('数据库 deploymentId 与当前部署不匹配');
      if (!runtime) {
        const existing = await this.db.listCollections({}, { nameOnly: true }).toArray();
        if (existing.length > 0) throw configError('非空数据库缺少部署元数据；拒绝登记文件存储');
      }
      try {
        await this.collections.metadata.insertOne({ _id: 'storage', schemaVersion: targetVersion, deploymentId, createdAt: new Date(this.clock()).toISOString() });
      } catch (error) { if (!duplicateKey(error)) throw error; }
      metadata = await this.collections.metadata.findOne({ _id: 'storage' });
    }
    if (!metadata || metadata.deploymentId !== deploymentId) throw configError('文件元数据 deploymentId 不匹配');
    if (metadata.schemaVersion !== targetVersion) {
      if (metadata.schemaVersion > targetVersion) throw configError('文件元数据模式版本高于当前程序支持版本');
      throw configError('文件元数据需要显式兼容迁移', { databaseVersion: metadata.schemaVersion, targetVersion });
    }
    await this.collections.uploads.createIndex({ uploadId: 1 }, { unique: true, name: 'storage_upload_id' });
    await this.collections.uploads.createIndex({ status: 1, updatedAt: 1 }, { name: 'storage_upload_recovery' });
    await this.collections.files.createIndex({ regionId: 1, ownerId: 1, path: 1 }, { name: 'storage_file_path' });
    await this.collections.revisions.createIndex({ regionId: 1, fileId: 1, revision: 1 }, { unique: true, name: 'storage_file_revision' });
    await this.collections.events.createIndex({ regionId: 1, cursorNumber: 1 }, { name: 'storage_event_region_cursor' });
    await this.collections.events.createIndex({ cursorNumber: 1 }, { unique: true, name: 'storage_event_cursor' });
    await this.collections.regions.createIndex({ regionId: 1 }, { unique: true, name: 'storage_region_id' });
    await this.collections.migrations.updateOne(
      { _id: `storage-${targetVersion}` },
      { $setOnInsert: { version: targetVersion, deploymentId, appliedAt: new Date(this.clock()).toISOString() } },
      { upsert: true }
    );
    this.deploymentId = deploymentId;
    this.migrated = true;
    for (const region of regions) await this.registerRegion(region);
    return { schemaVersion: targetVersion, deploymentId };
  }

  requireReady() {
    if (!this.migrated) throw configError('文件元数据尚未完成部署校验与迁移');
  }

  async getSchemaVersion() {
    await this.connect();
    const metadata = await this.collections.metadata.findOne({ _id: 'storage' });
    return metadata ? metadata.schemaVersion : null;
  }

  async registerRegion(input) {
    this.requireReady();
    const region = input.declaration
      ? { regionId: input.declaration.regionId, declaration: input.declaration, rootAbs: input.rootAbs }
      : input;
    const existing = await this.collections.regions.findOne({ _id: region.regionId });
    if (existing && existing.rootAbs !== region.rootAbs) {
      throw new CoreError(codes.IMPLICIT_DATA_ROOT_CHANGE, `区域 ${region.regionId} 的持久物理根不匹配`, {
        status: 409, details: { persisted: existing.rootAbs, configured: region.rootAbs }
      });
    }
    await this.collections.regions.replaceOne({ _id: region.regionId }, { _id: region.regionId, ...region }, { upsert: true });
    return clean(await this.collections.regions.findOne({ _id: region.regionId }));
  }

  async listRegions() {
    this.requireReady();
    return (await this.collections.regions.find({}).sort({ _id: 1 }).toArray()).map(clean);
  }

  async getRegion(regionId) {
    this.requireReady();
    return clean(await this.collections.regions.findOne({ _id: regionId }));
  }

  async withTransaction(callback) {
    this.requireReady();
    const session = this.client.startSession();
    try {
      let result;
      await session.withTransaction(async () => { result = await callback(session); }, {
        readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }
      });
      return result;
    } finally { await session.endSession(); }
  }

  fingerprint(input) {
    return JSON.stringify({
      regionId: input.regionId, fileId: input.fileId, size: input.size, sha256: input.sha256,
      ownerId: input.ownerId || null, path: input.path || null, actor: input.actor || null
    });
  }

  async ensureQuota(regionId, ownerId) {
    await this.collections.quotas.updateOne(
      { _id: fileKey(regionId, ownerId || '') },
      { $setOnInsert: { regionId, ownerId: ownerId || null, used: 0, reserved: 0 } },
      { upsert: true }
    );
  }

  async beginUpload(input) {
    this.requireReady();
    const fingerprint = this.fingerprint(input);
    const existingOperation = await this.collections.operations.findOne({ _id: input.operationId });
    if (existingOperation) {
      if (existingOperation.fingerprint !== fingerprint) throw conflict('同一 operationId 对应不同上传内容');
      return clean(await this.collections.uploads.findOne({ _id: input.operationId }));
    }
    await this.ensureQuota(input.regionId, input.ownerId);
    const now = new Date(this.clock()).toISOString();
    try {
      return await this.withTransaction(async (session) => {
        const current = await this.collections.files.findOne({ _id: fileKey(input.regionId, input.fileId) }, { session });
        const previousSize = current && !current.tombstone ? current.size : 0;
        const delta = input.size - previousSize;
        const reserve = Math.max(0, delta);
        const quotaId = fileKey(input.regionId, input.ownerId);
        const reserved = await this.collections.quotas.findOneAndUpdate({
          _id: quotaId,
          ...(Number.isSafeInteger(input.quotaBytes) ? {
            $expr: { $lte: [{ $add: ['$used', '$reserved', reserve] }, input.quotaBytes] }
          } : {})
        }, { $inc: { reserved: reserve } }, { session, returnDocument: 'after' });
        if (!reserved) {
          const quota = await this.collections.quotas.findOne({ _id: quotaId }, { session });
          throw new CoreError(codes.QUOTA_EXCEEDED, '存储配额不足', {
            status: 413,
            details: { quotaBytes: input.quotaBytes, used: quota && quota.used, reserved: quota && quota.reserved, required: reserve }
          });
        }
        const upload = {
          uploadId: input.uploadId, operationId: input.operationId, regionId: input.regionId,
          fileId: input.fileId, ownerId: input.ownerId || null, path: input.path || null,
          actor: input.actor, size: input.size, sha256: input.sha256, status: 'uploading',
          nextOffset: 0, chunks: [], previousSize, quotaDelta: delta, quotaReserved: reserve,
          createdAt: now, updatedAt: now
        };
        await this.collections.uploads.insertOne({ _id: input.operationId, ...upload }, { session });
        await this.collections.operations.insertOne({
          _id: input.operationId, fingerprint, kind: 'upload', uploadId: input.uploadId,
          status: 'uploading', createdAt: now, updatedAt: now
        }, { session });
        return upload;
      });
    } catch (error) {
      if (duplicateKey(error)) {
        const operation = await this.collections.operations.findOne({ _id: input.operationId });
        if (operation && operation.fingerprint === fingerprint) return clean(await this.collections.uploads.findOne({ _id: input.operationId }));
        throw conflict('operationId 已被其他操作占用');
      }
      throw error;
    }
  }

  async getUpload(uploadId) {
    this.requireReady();
    return clean(await this.collections.uploads.findOne({ uploadId }));
  }

  async recordChunk(uploadId, chunk) {
    this.requireReady();
    const current = await this.collections.uploads.findOne({ uploadId });
    if (!current) throw stateError('上传不存在', 404);
    if (current.status !== 'uploading') throw stateError(`上传状态 ${current.status} 不接受分块`);
    if (chunk.offset !== current.nextOffset) throw conflict('分块偏移不是持久化游标所要求的位置', { expectedOffset: current.nextOffset, receivedOffset: chunk.offset });
    if (chunk.size <= 0 || chunk.offset + chunk.size > current.size) throw new CoreError(codes.INVALID_INPUT, '分块长度或终点非法', { status: 400 });
    const result = await this.collections.uploads.findOneAndUpdate(
      { uploadId, status: 'uploading', nextOffset: chunk.offset },
      {
        $push: { chunks: chunk }, $inc: { nextOffset: chunk.size },
        $set: { updatedAt: new Date(this.clock()).toISOString() }
      },
      { returnDocument: 'after' }
    );
    if (!result) throw conflict('分块被并发上传抢占，请按最新偏移重试');
    return clean(result);
  }

  async acquireLock(regionId, fileId, uploadId, session) {
    const key = fileKey(regionId, fileId);
    const result = await this.collections.locks.updateOne(
      { _id: key, $or: [{ uploadId }, { uploadId: { $exists: false } }] },
      { $set: { uploadId, regionId, fileId, updatedAt: new Date(this.clock()).toISOString() } },
      { session, upsert: true }
    );
    if (!result.upsertedCount && !result.modifiedCount && !result.matchedCount) throw conflict('文件正在由另一操作提交');
  }

  async markCommitting(uploadId, request) {
    this.requireReady();
    const initial = await this.collections.uploads.findOne({ uploadId });
    if (!initial) throw stateError('上传不存在', 404);
    if (initial.status === 'committed') {
      const operation = await this.collections.operations.findOne({ _id: initial.operationId });
      return clean(operation.result);
    }
    if (initial.status === 'committing') {
      if (JSON.stringify(initial.commitRequest) !== JSON.stringify(request)) throw conflict('同一上传的条件提交参数发生变化');
      return clean(initial);
    }
    if (initial.status !== 'uploading') throw stateError(`上传状态 ${initial.status} 不能提交`);
    if (initial.nextOffset !== initial.size) throw stateError('上传分块不完整');
    const commitFingerprint = JSON.stringify(request);
    try {
      return await this.withTransaction(async (session) => {
        const upload = await this.collections.uploads.findOne({ uploadId }, { session });
        const key = fileKey(upload.regionId, upload.fileId);
        const current = await this.collections.files.findOne({ _id: key }, { session });
        const revision = current ? current.revision : 0;
        if (request.baseRevision !== null && request.baseRevision !== revision) {
          throw conflict('基础修订与当前修订不符', { currentRevision: revision, baseRevision: request.baseRevision });
        }
        await this.acquireLock(upload.regionId, upload.fileId, uploadId, session);
        const updated = await this.collections.uploads.findOneAndUpdate(
          { uploadId, status: 'uploading' },
          { $set: {
            status: 'committing', commitRequest: request, commitFingerprint,
            targetRevision: revision + 1, updatedAt: new Date(this.clock()).toISOString()
          } },
          { session, returnDocument: 'after' }
        );
        if (!updated) throw conflict('上传状态已变化');
        await this.collections.operations.updateOne({ _id: upload.operationId }, { $set: { status: 'committing', updatedAt: new Date(this.clock()).toISOString() } }, { session });
        return clean(updated);
      });
    } catch (error) {
      if (duplicateKey(error)) throw conflict('文件正在由另一操作提交');
      throw error;
    }
  }

  async nextCursor(session) {
    const control = await this.collections.controls.findOneAndUpdate(
      { _id: 'file-event-cursor' }, { $inc: { value: 1 } },
      { session, upsert: true, returnDocument: 'after' }
    );
    return control.value;
  }

  async completeCommit(uploadId, contentPath) {
    this.requireReady();
    const initial = await this.collections.uploads.findOne({ uploadId });
    if (!initial) throw stateError('上传不存在', 404);
    if (initial.status === 'committed') {
      const operation = await this.collections.operations.findOne({ _id: initial.operationId });
      return { ...clean(operation.result), idempotent: true };
    }
    if (initial.status !== 'committing') throw stateError(`上传状态 ${initial.status} 没有可完成的内容提交`);
    return this.withTransaction(async (session) => {
      const upload = await this.collections.uploads.findOne({ uploadId }, { session });
      if (upload.status !== 'committing') throw conflict('上传状态已变化');
      const request = upload.commitRequest;
      const now = new Date(this.clock()).toISOString();
      const key = fileKey(upload.regionId, upload.fileId);
      const file = {
        regionId: upload.regionId, fileId: upload.fileId, ownerId: upload.ownerId,
        path: request.path || upload.path, revision: upload.targetRevision, size: upload.size,
        contentHash: upload.sha256, contentPath, metadata: request.metadata || {},
        tombstone: false, updatedAt: now
      };
      await this.collections.files.replaceOne({ _id: key }, { _id: key, ...file }, { session, upsert: true });
      await this.collections.revisions.replaceOne(
        { _id: `${key}\0${file.revision}` }, { _id: `${key}\0${file.revision}`, ...file }, { session, upsert: true }
      );
      const cursorNumber = await this.nextCursor(session);
      const record = {
        operationId: upload.operationId, regionId: upload.regionId, fileId: upload.fileId,
        op: file.revision === 1 ? 'create' : 'update', path: file.path,
        baseRevision: request.baseRevision, revision: file.revision, cursor: String(cursorNumber), cursorNumber,
        actor: upload.actor, size: file.size, contentHash: file.contentHash, status: 'committed',
        tombstone: false, recordedAt: now, committedAt: now
      };
      await this.collections.events.insertOne({ _id: upload.operationId, ...record }, { session });
      const result = { ...record, idempotent: false };
      delete result.cursorNumber;
      await this.collections.operations.updateOne({ _id: upload.operationId }, {
        $set: { status: 'committed', result, updatedAt: now }
      }, { session });
      await this.collections.uploads.updateOne({ _id: upload.operationId }, {
        $set: { status: 'committed', result, updatedAt: now }
      }, { session });
      const quota = await this.collections.quotas.findOneAndUpdate(
        { _id: fileKey(upload.regionId, upload.ownerId) },
        { $inc: { reserved: -upload.quotaReserved, used: upload.quotaDelta } },
        { session, returnDocument: 'after' }
      );
      if (!quota || quota.used < 0 || quota.reserved < 0) throw new Error('配额账本更新失败');
      await this.collections.locks.deleteOne({ _id: key, uploadId }, { session });
      return result;
    });
  }

  async failUpload(uploadId, { status = 'failed', code = 'UPLOAD_FAILED', message = '上传失败' } = {}) {
    this.requireReady();
    const initial = await this.collections.uploads.findOne({ uploadId });
    if (!initial) throw stateError('上传不存在', 404);
    if (['committed', 'failed', 'cancelled'].includes(initial.status)) return clean(initial);
    if (initial.status === 'committing') throw stateError('已进入提交阶段，必须恢复提交而不能标记失败');
    return this.withTransaction(async (session) => {
      const updated = await this.collections.uploads.findOneAndUpdate(
        { uploadId, status: 'uploading' },
        { $set: { status, error: { code, message }, quotaReserved: 0, updatedAt: new Date(this.clock()).toISOString() } },
        { session, returnDocument: 'after' }
      );
      if (!updated) throw conflict('上传状态已变化');
      await this.collections.quotas.updateOne(
        { _id: fileKey(initial.regionId, initial.ownerId) },
        { $inc: { reserved: -initial.quotaReserved } }, { session }
      );
      await this.collections.operations.updateOne({ _id: initial.operationId }, {
        $set: { status, error: { code, message }, updatedAt: new Date(this.clock()).toISOString() }
      }, { session });
      return clean(updated);
    });
  }

  async getFile(regionId, fileId, revision = null) {
    this.requireReady();
    const key = fileKey(regionId, fileId);
    const document = revision === null
      ? await this.collections.files.findOne({ _id: key })
      : await this.collections.revisions.findOne({ _id: `${key}\0${revision}` });
    return clean(document);
  }

  async listFiles(regionId) {
    this.requireReady();
    return (await this.collections.files.find({ regionId }).sort({ fileId: 1 }).toArray()).map(clean);
  }

  async commitDelete(input) {
    this.requireReady();
    const fingerprint = JSON.stringify({ op: 'delete', regionId: input.regionId, fileId: input.fileId, actor: input.actor, baseRevision: input.baseRevision });
    const existing = await this.collections.operations.findOne({ _id: input.operationId });
    if (existing) {
      if (existing.fingerprint !== fingerprint || !existing.result) throw conflict('同一 operationId 对应不同删除');
      return { ...clean(existing.result), idempotent: true };
    }
    const lockId = `delete-${input.operationId}`;
    try {
      return await this.withTransaction(async (session) => {
        const key = fileKey(input.regionId, input.fileId);
        const current = await this.collections.files.findOne({ _id: key }, { session });
        const revision = current ? current.revision : 0;
        if (input.baseRevision !== null && input.baseRevision !== revision) throw conflict('基础修订与当前修订不符');
        if (!current || current.tombstone) throw new CoreError(codes.NOT_FOUND, '文件不存在', { status: 404 });
        await this.acquireLock(input.regionId, input.fileId, lockId, session);
        await this.collections.operations.insertOne({ _id: input.operationId, fingerprint, kind: 'delete', status: 'committing' }, { session });
        const now = new Date(this.clock()).toISOString();
        const file = { ...clean(current), revision: revision + 1, tombstone: true, updatedAt: now };
        await this.collections.files.replaceOne({ _id: key }, { _id: key, ...file }, { session });
        await this.collections.revisions.insertOne({ _id: `${key}\0${file.revision}`, ...file }, { session });
        const cursorNumber = await this.nextCursor(session);
        const record = {
          operationId: input.operationId, regionId: input.regionId, fileId: input.fileId,
          op: 'delete', path: current.path, baseRevision: input.baseRevision,
          revision: file.revision, cursor: String(cursorNumber), cursorNumber,
          actor: input.actor, status: 'committed', tombstone: true, recordedAt: now, committedAt: now
        };
        await this.collections.events.insertOne({ _id: input.operationId, ...record }, { session });
        const result = { ...record, idempotent: false };
        delete result.cursorNumber;
        await this.collections.operations.updateOne({ _id: input.operationId }, { $set: { status: 'committed', result, updatedAt: now } }, { session });
        await this.collections.quotas.updateOne({ _id: fileKey(current.regionId, current.ownerId) }, { $inc: { used: -current.size } }, { session });
        await this.collections.locks.deleteOne({ _id: key, uploadId: lockId }, { session });
        return result;
      });
    } catch (error) {
      if (duplicateKey(error)) throw conflict('operationId 或文件提交锁冲突');
      throw error;
    }
  }

  async changesSince({ regionId, cursor = null, limit = 1000 } = {}) {
    this.requireReady();
    if (cursor === null || cursor === undefined) {
      const records = await this.collections.events.find({ regionId }).sort({ cursorNumber: 1 }).limit(limit).toArray();
      return { reset: true, records: records.map((record) => { const value = clean(record); delete value.cursorNumber; return value; }), nextCursor: records.length ? String(records[records.length - 1].cursorNumber) : null };
    }
    const seq = Number(cursor);
    const first = await this.collections.events.find({ regionId }).sort({ cursorNumber: 1 }).limit(1).next();
    if (!Number.isSafeInteger(seq) || seq < 0 || (first && seq < first.cursorNumber - 1)) {
      const last = await this.collections.events.find({ regionId }).sort({ cursorNumber: -1 }).limit(1).next();
      return { reset: true, reason: 'cursor-expired', records: [], nextCursor: last ? String(last.cursorNumber) : null };
    }
    const records = await this.collections.events.find({ regionId, cursorNumber: { $gt: seq } }).sort({ cursorNumber: 1 }).limit(limit).toArray();
    return {
      reset: false,
      records: records.map((record) => { const value = clean(record); delete value.cursorNumber; return value; }),
      nextCursor: records.length ? String(records[records.length - 1].cursorNumber) : cursor
    };
  }

  async pendingUploads() {
    this.requireReady();
    return (await this.collections.uploads.find({ status: { $in: ['uploading', 'committing'] } }).toArray()).map(clean);
  }

  async quotaUsage(regionId, ownerId) {
    this.requireReady();
    await this.ensureQuota(regionId, ownerId);
    return clean(await this.collections.quotas.findOne({ _id: fileKey(regionId, ownerId) }));
  }

  async close() {
    if (this.client && this.ownsClient) await this.client.close();
    this.db = null;
    this.collections = null;
    this.migrated = false;
  }
}

module.exports = { MongoStorageMetadata, STORAGE_SCHEMA_VERSION, COLLECTIONS };
