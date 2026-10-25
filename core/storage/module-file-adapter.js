'use strict';
// C08 正式模块文件适配器。业务模块与 Disk 视图都委托同一个 ContentStore 提交契约。
// 适配器只接受固定 regionId，不接受调用方提供物理根。

const { CoreError, codes } = require('../errors');
const { assertSafeRelPath } = require('./registry');

function normalizeBaseRevision(value) {
  return value === undefined ? null : value;
}

class ModuleFileAdapter {
  constructor({ moduleId, regionId, registry, content, viaDisk = false } = {}) {
    if (!moduleId || !regionId || !registry || !content) {
      throw new CoreError(codes.CONFIG_INVALID, '模块文件适配器需要 moduleId、regionId、registry 与 content', { status: 500 });
    }
    this.moduleId = moduleId;
    this.regionId = regionId;
    this.registry = registry;
    this.content = content;
    this.viaDisk = viaDisk;
  }

  authorize(operation, actor, ownerId) {
    const userId = ownerId || (actor && actor.userId) || null;
    this.registry.authorize({ regionId: this.regionId, moduleId: this.moduleId, operation, userId, viaDisk: this.viaDisk });
    const region = this.registry.region(this.regionId).declaration;
    if (region.ownership.rule === 'per-user') {
      if (!actor || actor.userId !== userId) {
        throw new CoreError(codes.FORBIDDEN, '不能以当前身份读写其他用户文件', { status: 403 });
      }
    }
    return userId;
  }

  async beginUpload(input) {
    const actor = input && input.actor;
    const ownerId = this.authorize('write', actor, input.ownerId);
    const logicalPath = assertSafeRelPath(input.path);
    const existing = await this.content.metadata.getFile(this.regionId, input.fileId);
    if (existing && existing.ownerId !== ownerId) {
      throw new CoreError(codes.FORBIDDEN, '文件 ID 属于其他用户', { status: 403 });
    }
    return this.content.beginUpload({
      ...input,
      regionId: this.regionId,
      ownerId,
      path: logicalPath,
      actor
    });
  }

  async writeChunk(uploadId, offset, readable, { actor, ...options } = {}) {
    const upload = await this.content.requireUpload(uploadId);
    this.authorize('write', actor, upload.ownerId);
    return this.content.writeChunk(uploadId, offset, readable, options);
  }

  async commitUpload({ actor, ...input }) {
    const upload = await this.content.requireUpload(input.uploadId);
    this.authorize('write', actor, upload.ownerId);
    return this.content.commitUpload(input);
  }

  async put({ actor, ownerId, path, fileId, operationId, size, sha256, baseRevision = null, metadata = {}, stream, signal, quotaBytes }) {
    const upload = await this.beginUpload({ actor, ownerId, path, fileId, operationId, size, sha256, quotaBytes });
    if (upload.status === 'committed') return { ...upload.result, idempotent: true };
    if (upload.status !== 'uploading') throw new CoreError(codes.UPLOAD_STATE, `上传状态 ${upload.status} 不能自动写入`, { status: 409 });
    if (size > 0) await this.writeChunk(upload.uploadId, 0, stream, { actor, signal });
    return this.commitUpload({ actor, uploadId: upload.uploadId, baseRevision, metadata, path, signal });
  }

  async openRead({ actor, ownerId, fileId, revision = null, range = null, signal }) {
    this.authorize('read', actor, ownerId);
    const file = await this.content.metadata.getFile(this.regionId, fileId, revision);
    if (file && file.ownerId !== (ownerId || actor.userId)) {
      throw new CoreError(codes.FORBIDDEN, '不能读取其他用户文件', { status: 403 });
    }
    return this.content.openRead({ regionId: this.regionId, fileId, revision, range, signal });
  }

  async uploadState(uploadId) {
    const upload = await this.content.requireUpload(uploadId);
    this.authorize('write', upload.actor, upload.ownerId);
    return upload;
  }

  async abortUpload(uploadId) {
    const upload = await this.content.requireUpload(uploadId);
    this.authorize('write', upload.actor, upload.ownerId);
    return this.content.abortUpload(uploadId);
  }

  async deleteFile({ actor, ownerId, fileId, operationId, baseRevision = null }) {
    const userId = this.authorize('delete', actor, ownerId);
    const file = await this.content.metadata.getFile(this.regionId, fileId);
    if (file && file.ownerId !== userId) throw new CoreError(codes.FORBIDDEN, '不能删除其他用户文件', { status: 403 });
    return this.content.deleteFile({ regionId: this.regionId, ownerId: userId, fileId, operationId, baseRevision, actor });
  }

  async changesSince({ actor, ownerId, cursor = null, limit = 1000 } = {}) {
    const userId = this.authorize('read', actor, ownerId);
    const result = await this.content.metadata.changesSince({ regionId: this.regionId, cursor, limit });
    const declaration = this.registry.region(this.regionId).declaration;
    if (declaration.ownership.rule === 'per-user') {
      result.records = result.records.filter((record) => record.actor && record.actor.userId === userId);
    }
    return result;
  }

  async reconcile({ actor, ownerId, cursor = null, deep = false, signal } = {}) {
    this.authorize('read', actor, ownerId);
    return this.content.reconcile({ regionId: this.regionId, cursor, deep, signal });
  }

  async quotaUsage({ actor, ownerId }) {
    const userId = this.authorize('read', actor, ownerId);
    return this.content.metadata.quotaUsage(this.regionId, userId);
  }
}

function createModuleFileAdapter({ moduleId, regionId, registry, content }) {
  const region = registry.region(regionId).declaration;
  if (region.module !== moduleId) {
    throw new CoreError(codes.REGION_NOT_AUTHORIZED, '适配器 moduleId 与区域所属模块不符', { status: 403 });
  }
  return new ModuleFileAdapter({ moduleId, regionId, registry, content });
}

function createDiskFileAdapter({ regionId, registry, content }) {
  const region = registry.region(regionId).declaration;
  if (!region.disk.visible) throw new CoreError(codes.REGION_NOT_AUTHORIZED, '区域未暴露给 Disk', { status: 403 });
  return new ModuleFileAdapter({ moduleId: 'disk', regionId, registry, content, viaDisk: true });
}

module.exports = { ModuleFileAdapter, createModuleFileAdapter, createDiskFileAdapter, normalizeBaseRevision };
