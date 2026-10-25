'use strict';
// 仅供普通单元/集成测试的异步元数据适配器。正式部署使用 mongo-metadata.js。
// 这里只保存元数据，绝不保存文件内容或 base64。

const { CoreError, codes } = require('../errors');

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function conflict(message, details = null) {
  return new CoreError(codes.CONFLICT, message, { status: 409, details });
}

function stateError(message, status = 409) {
  return new CoreError(codes.UPLOAD_STATE, message, { status });
}

function fileKey(regionId, fileId) {
  return `${regionId}\0${fileId}`;
}

class InMemoryStorageMetadata {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.regions = new Map();
    this.uploads = new Map();
    this.files = new Map();
    this.fileRevisions = new Map();
    this.operations = new Map();
    this.events = [];
    this.quotas = new Map();
    this.locks = new Map();
    this.cursor = 0;
    this.schemaVersion = 1;
    this.deploymentId = null;
    this.migrated = false;
  }

  async migrate({ deploymentId, regions = [] } = {}) {
    if (this.deploymentId && this.deploymentId !== deploymentId) {
      throw new CoreError(codes.CONFIG_INVALID, '元数据 deploymentId 不匹配', { status: 500 });
    }
    this.deploymentId = deploymentId || this.deploymentId || 'in-memory-test';
    for (const region of regions) await this.registerRegion(region);
    this.migrated = true;
    return { schemaVersion: this.schemaVersion, deploymentId: this.deploymentId };
  }

  async getSchemaVersion() { return this.schemaVersion; }

  async registerRegion(input) {
    const region = input.declaration
      ? { regionId: input.declaration.regionId, declaration: clone(input.declaration), rootAbs: input.rootAbs }
      : clone(input);
    const previous = this.regions.get(region.regionId);
    if (previous && previous.rootAbs !== region.rootAbs) {
      throw new CoreError(codes.IMPLICIT_DATA_ROOT_CHANGE, `区域 ${region.regionId} 的持久物理根不匹配`, {
        status: 409, details: { persisted: previous.rootAbs, configured: region.rootAbs }
      });
    }
    this.regions.set(region.regionId, region);
    return clone(region);
  }

  async listRegions() { return [...this.regions.values()].map(clone); }

  async getRegion(regionId) { return clone(this.regions.get(regionId) || null); }

  requireReady() {
    if (!this.migrated) throw new CoreError(codes.CONFIG_INVALID, '存储元数据尚未迁移', { status: 500 });
  }

  quotaFor(regionId, ownerId) {
    const key = fileKey(regionId, ownerId || '');
    if (!this.quotas.has(key)) this.quotas.set(key, { used: 0, reserved: 0 });
    return this.quotas.get(key);
  }

  fingerprint(input) {
    return JSON.stringify({
      regionId: input.regionId,
      fileId: input.fileId,
      size: input.size,
      sha256: input.sha256,
      ownerId: input.ownerId || null,
      path: input.path || null,
      actor: input.actor || null
    });
  }

  async beginUpload(input) {
    this.requireReady();
    const fingerprint = this.fingerprint(input);
    const existing = this.uploads.get(input.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw conflict('同一 operationId 对应不同上传内容');
      return clone(existing.upload);
    }
    if (this.operations.has(input.operationId)) throw conflict('operationId 已被其他操作占用');
    const key = fileKey(input.regionId, input.fileId);
    const current = this.files.get(key);
    const previousSize = current && !current.tombstone ? current.size : 0;
    const delta = input.size - previousSize;
    const reserve = Math.max(0, delta);
    const quota = this.quotaFor(input.regionId, input.ownerId);
    if (Number.isSafeInteger(input.quotaBytes) && quota.used + quota.reserved + reserve > input.quotaBytes) {
      throw new CoreError(codes.QUOTA_EXCEEDED, '存储配额不足', {
        status: 413,
        details: { quotaBytes: input.quotaBytes, used: quota.used, reserved: quota.reserved, required: reserve }
      });
    }
    quota.reserved += reserve;
    const now = new Date(this.clock()).toISOString();
    const upload = {
      uploadId: input.uploadId,
      operationId: input.operationId,
      regionId: input.regionId,
      fileId: input.fileId,
      ownerId: input.ownerId || null,
      path: input.path || null,
      actor: clone(input.actor),
      size: input.size,
      sha256: input.sha256,
      status: 'uploading',
      nextOffset: 0,
      chunks: [],
      previousSize,
      quotaDelta: delta,
      quotaReserved: reserve,
      createdAt: now,
      updatedAt: now
    };
    this.uploads.set(input.operationId, { fingerprint, upload });
    return clone(upload);
  }

  async getUpload(uploadId) {
    this.requireReady();
    for (const { upload } of this.uploads.values()) {
      if (upload.uploadId === uploadId) return clone(upload);
    }
    return null;
  }

  mutableUpload(uploadId) {
    for (const entry of this.uploads.values()) if (entry.upload.uploadId === uploadId) return entry;
    throw stateError('上传不存在', 404);
  }

  async recordChunk(uploadId, chunk) {
    const entry = this.mutableUpload(uploadId);
    const upload = entry.upload;
    if (upload.status !== 'uploading') throw stateError(`上传状态 ${upload.status} 不接受分块`);
    if (chunk.offset !== upload.nextOffset) {
      throw conflict('分块偏移不是持久化游标所要求的位置', { expectedOffset: upload.nextOffset, receivedOffset: chunk.offset });
    }
    if (chunk.size <= 0 || chunk.offset + chunk.size > upload.size) {
      throw new CoreError(codes.INVALID_INPUT, '分块长度或终点非法', { status: 400 });
    }
    upload.chunks.push(clone(chunk));
    upload.nextOffset += chunk.size;
    upload.updatedAt = new Date(this.clock()).toISOString();
    return clone(upload);
  }

  async markCommitting(uploadId, request) {
    const entry = this.mutableUpload(uploadId);
    const upload = entry.upload;
    if (upload.status === 'committed') return clone(upload.result);
    if (upload.status === 'committing') {
      if (JSON.stringify(upload.commitRequest) !== JSON.stringify(request)) throw conflict('同一上传的条件提交参数发生变化');
      return clone(upload);
    }
    if (upload.status !== 'uploading') throw stateError(`上传状态 ${upload.status} 不能提交`);
    if (upload.nextOffset !== upload.size) throw stateError('上传分块不完整', 409);
    const key = fileKey(upload.regionId, upload.fileId);
    const current = this.files.get(key);
    const revision = current ? current.revision : 0;
    if (request.baseRevision !== null && request.baseRevision !== revision) {
      throw conflict('基础修订与当前修订不符', { currentRevision: revision, baseRevision: request.baseRevision });
    }
    const lockOwner = this.locks.get(key);
    if (lockOwner && lockOwner !== uploadId) throw conflict('文件正在由另一操作提交');
    this.locks.set(key, uploadId);
    upload.status = 'committing';
    upload.commitRequest = clone(request);
    upload.targetRevision = revision + 1;
    upload.updatedAt = new Date(this.clock()).toISOString();
    return clone(upload);
  }

  async completeCommit(uploadId, contentPath) {
    const entry = this.mutableUpload(uploadId);
    const upload = entry.upload;
    if (upload.status === 'committed') return clone(upload.result);
    if (upload.status !== 'committing') throw stateError(`上传状态 ${upload.status} 没有可完成的内容提交`);
    const request = upload.commitRequest;
    const now = new Date(this.clock()).toISOString();
    const key = fileKey(upload.regionId, upload.fileId);
    const file = {
      regionId: upload.regionId,
      fileId: upload.fileId,
      ownerId: upload.ownerId,
      path: request.path || upload.path,
      revision: upload.targetRevision,
      size: upload.size,
      contentHash: upload.sha256,
      contentPath,
      metadata: clone(request.metadata || {}),
      tombstone: false,
      updatedAt: now
    };
    this.files.set(key, file);
    this.fileRevisions.set(`${key}\0${file.revision}`, clone(file));
    this.cursor += 1;
    const record = {
      operationId: upload.operationId,
      regionId: upload.regionId,
      fileId: upload.fileId,
      op: file.revision === 1 ? 'create' : 'update',
      path: file.path,
      baseRevision: request.baseRevision,
      revision: file.revision,
      cursor: String(this.cursor),
      actor: clone(upload.actor),
      size: file.size,
      contentHash: file.contentHash,
      status: 'committed',
      tombstone: false,
      recordedAt: now,
      committedAt: now
    };
    this.events.push(record);
    const result = { ...clone(record), idempotent: false };
    upload.status = 'committed';
    upload.result = result;
    upload.updatedAt = now;
    this.operations.set(upload.operationId, { fingerprint: entry.fingerprint, result });
    this.locks.delete(key);
    const quota = this.quotaFor(upload.regionId, upload.ownerId);
    quota.reserved -= upload.quotaReserved;
    quota.used += upload.quotaDelta;
    if (quota.used < 0 || quota.reserved < 0) throw new Error('配额账本出现负值');
    return clone(result);
  }

  async failUpload(uploadId, { status = 'failed', code = 'UPLOAD_FAILED', message = '上传失败' } = {}) {
    const entry = this.mutableUpload(uploadId);
    const upload = entry.upload;
    if (upload.status === 'committed') return clone(upload);
    if (upload.status === 'failed' || upload.status === 'cancelled') return clone(upload);
    if (upload.status === 'committing') throw stateError('已进入提交阶段，必须恢复提交而不能标记失败');
    const quota = this.quotaFor(upload.regionId, upload.ownerId);
    quota.reserved -= upload.quotaReserved;
    upload.quotaReserved = 0;
    upload.status = status;
    upload.error = { code, message };
    upload.updatedAt = new Date(this.clock()).toISOString();
    return clone(upload);
  }

  async getFile(regionId, fileId, revision = null) {
    this.requireReady();
    const key = fileKey(regionId, fileId);
    const file = revision === null ? this.files.get(key) : this.fileRevisions.get(`${key}\0${revision}`);
    if (!file) return null;
    return clone(file);
  }

  async listFiles(regionId) {
    return [...this.files.values()].filter((file) => file.regionId === regionId).map(clone);
  }

  async commitDelete(input) {
    this.requireReady();
    const fingerprint = JSON.stringify({ op: 'delete', regionId: input.regionId, fileId: input.fileId, actor: input.actor, baseRevision: input.baseRevision });
    const existing = this.operations.get(input.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw conflict('同一 operationId 对应不同删除');
      return { ...clone(existing.result), idempotent: true };
    }
    if (this.uploads.has(input.operationId)) throw conflict('operationId 已被其他操作占用');
    const key = fileKey(input.regionId, input.fileId);
    const current = this.files.get(key);
    const revision = current ? current.revision : 0;
    if (input.baseRevision !== null && input.baseRevision !== revision) throw conflict('基础修订与当前修订不符');
    if (!current || current.tombstone) throw new CoreError(codes.NOT_FOUND, '文件不存在', { status: 404 });
    const lockOwner = this.locks.get(key);
    if (lockOwner) throw conflict('文件正在由另一操作提交');
    this.locks.set(key, `delete-${input.operationId}`);
    const now = new Date(this.clock()).toISOString();
    const file = { ...current, revision: revision + 1, tombstone: true, updatedAt: now };
    this.files.set(key, file);
    this.fileRevisions.set(`${key}\0${file.revision}`, clone(file));
    this.cursor += 1;
    const record = {
      operationId: input.operationId, regionId: input.regionId, fileId: input.fileId,
      op: 'delete', path: current.path, baseRevision: input.baseRevision,
      revision: file.revision, cursor: String(this.cursor), actor: clone(input.actor),
      status: 'committed', tombstone: true, recordedAt: now, committedAt: now
    };
    this.events.push(record);
    this.operations.set(input.operationId, { fingerprint, result: record });
    this.locks.delete(key);
    const quota = this.quotaFor(input.regionId, current.ownerId);
    quota.used -= current.size;
    return { ...clone(record), idempotent: false };
  }

  async changesSince({ regionId, cursor = null, limit = 1000 } = {}) {
    const scoped = this.events.filter((event) => event.regionId === regionId);
    if (cursor === null || cursor === undefined) {
      const records = scoped.slice(0, limit);
      return { reset: true, records: clone(records), nextCursor: records.length ? records[records.length - 1].cursor : null };
    }
    const seq = Number(cursor);
    if (!Number.isSafeInteger(seq) || seq < 0 || (scoped.length && seq < Number(scoped[0].cursor) - 1)) {
      return { reset: true, reason: 'cursor-expired', records: [], nextCursor: scoped.length ? scoped[scoped.length - 1].cursor : null };
    }
    const records = scoped.filter((event) => Number(event.cursor) > seq).slice(0, limit);
    return { reset: false, records: clone(records), nextCursor: records.length ? records[records.length - 1].cursor : cursor };
  }

  async pendingUploads() {
    return [...this.uploads.values()].map((entry) => entry.upload)
      .filter((upload) => upload.status === 'uploading' || upload.status === 'committing').map(clone);
  }

  async quotaUsage(regionId, ownerId) { return clone(this.quotaFor(regionId, ownerId)); }

  async close() {}
}

module.exports = { InMemoryStorageMetadata, fileKey };
