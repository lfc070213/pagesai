'use strict';
// C14 正式 Disk 数据面：MongoDB 元数据 + 统一 ContentStore 文件修订。
//
// 边界：
//  - 只有一个逻辑盘，正式区域固定为 disk.user-files；不扫描宿主目录，不接受客户端物理路径。
//  - 文件正文只在 ContentStore 中；Mongo 只保存 fileId、名称、大小、哈希与状态引用。
//  - 上传必须声明 size 与 sha256；配额由核心 beginUpload({quotaBytes}) 原子预留。
//  - 软删只改状态，不调用 ContentStore 删除，因此内容与逻辑字节仍计入配额，恢复不重传。
//  - 下载复用 ContentStore 的修订与 Range；公开分享只读、可过期、可撤销。

const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { CoreError, codes } = require('../../../core/errors.js');
const { parseRange } = require('../../../core/http-transport.js');
const { EMPTY_SHA256 } = require('../../../core/storage/content-store.js');

const MODULE_ID = 'disk';
const MODULE_VERSION = '0.2.0';
const REGION = 'disk.user-files';
const DEFAULT_QUOTA_BYTES = 1024 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 5 * 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_FILE_NAME = 255;
const MAX_OPERATION_ID = 128;
const MAX_SHARE_TTL_SECONDS = 31536000;
const DEFAULT_SHARE_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_SHARE_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SYNC_HISTORY = 100000;
const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FOLDER_NAME_FORBIDDEN = /[/\\\u0000-\u001f\u007f]/;

function error(code, message, status = 400, details = null) {
  return new CoreError(code, message, { status, details });
}
function invalid(message) { return error(codes.INVALID_INPUT, message, 400); }
function bodyOf(ctx) { return ctx && ctx.body && typeof ctx.body === 'object' && !Buffer.isBuffer(ctx.body) ? ctx.body : {}; }
function headerValue(ctx, name) {
  if (!ctx) return undefined;
  const lower = String(name).toLowerCase();
  for (const headers of [ctx.req && ctx.req.headers, ctx.headers]) {
    if (!headers || typeof headers !== 'object') continue;
    if (headers[lower] !== undefined) return Array.isArray(headers[lower]) ? headers[lower][0] : headers[lower];
    if (headers[name] !== undefined) return Array.isArray(headers[name]) ? headers[name][0] : headers[name];
  }
  return undefined;
}
function queryValue(ctx, name) {
  if (!ctx) return undefined;
  if (ctx.query && ctx.query[name] !== undefined) {
    return Array.isArray(ctx.query[name]) ? ctx.query[name][0] : ctx.query[name];
  }
  if (ctx.url && ctx.url.searchParams) return ctx.url.searchParams.get(name);
  return undefined;
}
function pick(object, ...keys) {
  for (const key of keys) if (object && object[key] !== undefined) return object[key];
  return undefined;
}
function truthy(value) {
  const text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}
function integerValue(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return null;
    throw invalid(`${field} 必须是整数`);
  }
  let number = value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) number = Number(value.trim());
  if (!Number.isInteger(number) || number < min || number > max) throw invalid(`${field} 必须在 ${min}-${max} 之间`);
  return number;
}
function text(value, field, max = 200) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${field} 不能为空`);
  const result = value.trim();
  if (result.length > max) throw invalid(`${field} 不能超过 ${max} 个字符`);
  return result;
}
function validateName(value) {
  const name = text(value, 'name', MAX_FILE_NAME);
  if (name === '.' || name === '..' || /[\\/]/.test(name) || /[\u0000-\u001f\u007f]/.test(name)) {
    throw invalid('name 不能包含路径分隔符或控制字符');
  }
  return name;
}
function validateMime(value) {
  if (value === undefined || value === null || value === '') return 'application/octet-stream';
  const mime = text(value, 'mimeType', 200);
  if (/[\u0000-\u001f\u007f]/.test(mime) || !/^[a-z0-9][\w!#$&^_.+-]*\/[a-z0-9][\w!#$&^_.+-]*(?:;\s*charset=[\w-]+)?$/i.test(mime)) {
    throw invalid('mimeType 格式非法');
  }
  return mime;
}
function normalizeSha(value, size) {
  if (value === undefined || value === null || value === '') {
    if (size === 0) return EMPTY_SHA256;
    throw invalid('非空上传必须提供 sha256');
  }
  if (typeof value !== 'string') throw invalid('sha256 必须是字符串');
  const hex = value.trim().toLowerCase().replace(/^sha256:/, '');
  if (!HEX_SHA256.test(hex)) throw invalid('sha256 必须是 64 位十六进制');
  if (size === 0 && hex !== EMPTY_SHA256) throw invalid('零字节文件的 sha256 不匹配');
  return hex;
}
function validateOperationId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw invalid('operationId 必须是字符串');
  const result = value.trim();
  if (!result) return null;
  if (result.length > MAX_OPERATION_ID) throw invalid(`operationId 不能超过 ${MAX_OPERATION_ID} 个字符`);
  return result;
}
function hashText(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function actor(userId) { return { userId, service: MODULE_ID }; }
function encodeFilename(name) {
  return encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
function decodeBase64(value, field) {
  let textValue = String(value === undefined || value === null ? '' : value).trim();
  const dataUrl = /^data:[^,]*;base64,/i.exec(textValue);
  if (dataUrl) textValue = textValue.slice(dataUrl[0].length);
  textValue = textValue.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(textValue) || textValue.length % 4 === 1) throw invalid(`${field} 不是合法 base64`);
  return Buffer.from(textValue, 'base64');
}
function chunkBuffer(ctx) {
  const body = ctx && ctx.body;
  let buffer = null;
  if (Buffer.isBuffer(body)) buffer = body;
  else if (typeof body === 'string') buffer = decodeBase64(body, '分块内容');
  else {
    const object = bodyOf(ctx);
    if (Buffer.isBuffer(object.data)) buffer = object.data;
    else if (typeof object.data === 'string') {
      buffer = object.encoding === 'utf8' || object.encoding === 'text'
        ? Buffer.from(object.data, 'utf8')
        : decodeBase64(object.data, '分块内容');
    } else if (typeof object.base64 === 'string') buffer = decodeBase64(object.base64, '分块内容');
    else if (typeof object.chunk === 'string') buffer = decodeBase64(object.chunk, '分块内容');
    else if (typeof object.text === 'string') buffer = Buffer.from(object.text, 'utf8');
  }
  if (!buffer) throw invalid('请求体缺少分块内容');
  return buffer;
}
function fileView(file) {
  return {
    fileId: file.fileId,
    folderId: file.folderId || null,
    name: file.name,
    size: file.size,
    revision: file.revision,
    status: file.status,
    regionId: file.regionId,
    mimeType: file.mimeType,
    contentHash: file.contentHash,
    sha256: file.contentHash ? `sha256:${file.contentHash}` : null,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    deletedAt: file.deletedAt || null,
    restoredAt: file.restoredAt || null
  };
}
function publicFileView(file) {
  return {
    fileId: file.fileId,
    name: file.name,
    size: file.size,
    revision: file.revision,
    mimeType: file.mimeType,
    contentHash: file.contentHash,
    sha256: file.contentHash ? `sha256:${file.contentHash}` : null,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt
  };
}
function shareView(share) {
  return {
    shareId: share.shareId,
    fileId: share.fileId,
    readOnly: true,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    revokedAt: share.revokedAt || null
  };
}
function folderView(folder) {
  return {
    folderId: folder.folderId,
    parentId: folder.parentId || null,
    name: folder.name,
    revision: folder.revision,
    status: folder.status,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
    deletedAt: folder.deletedAt || null
  };
}
function deviceView(device) {
  return {
    deviceId: device.deviceId,
    name: device.name,
    platform: device.platform,
    protocolVersion: device.protocolVersion,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt || null,
    revokedAt: device.revokedAt || null
  };
}
function normalizeConfig(input) {
  try {
    return normalizeConfigValues(input);
  } catch (cause) {
    if (cause instanceof CoreError && cause.code === codes.INVALID_INPUT) {
      throw error(codes.CONFIG_INVALID, cause.message, 500);
    }
    throw cause;
  }
}
function normalizeConfigValues(input) {
  const config = input && typeof input === 'object' ? input : {};
  const quotaBytes = integerValue(config.quotaBytes === undefined ? DEFAULT_QUOTA_BYTES : config.quotaBytes, 'quotaBytes', { min: 1, max: Number.MAX_SAFE_INTEGER });
  const chunkSizeBytes = integerValue(config.chunkSizeBytes === undefined ? DEFAULT_CHUNK_BYTES : config.chunkSizeBytes, 'chunkSizeBytes', { min: 1, max: MAX_CHUNK_BYTES });
  const maxChunkBytes = integerValue(config.maxChunkBytes === undefined ? MAX_CHUNK_BYTES : config.maxChunkBytes, 'maxChunkBytes', { min: 1, max: MAX_CHUNK_BYTES });
  if (maxChunkBytes < chunkSizeBytes) throw error(codes.CONFIG_INVALID, 'maxChunkBytes 不得小于 chunkSizeBytes', 500);
  const maxFileBytes = integerValue(config.maxFileBytes === undefined ? 0 : config.maxFileBytes, 'maxFileBytes', { min: 0, max: Number.MAX_SAFE_INTEGER });
  const share = config.share && typeof config.share === 'object' ? config.share : {};
  const shareDefaultTtlSeconds = integerValue(share.defaultTtlSeconds === undefined ? DEFAULT_SHARE_TTL_SECONDS : share.defaultTtlSeconds, 'share.defaultTtlSeconds', { min: 1, max: MAX_SHARE_TTL_SECONDS });
  const shareMaxTtlSeconds = integerValue(share.maxTtlSeconds === undefined ? DEFAULT_SHARE_MAX_TTL_SECONDS : share.maxTtlSeconds, 'share.maxTtlSeconds', { min: 1, max: MAX_SHARE_TTL_SECONDS });
  if (shareDefaultTtlSeconds > shareMaxTtlSeconds) throw error(codes.CONFIG_INVALID, 'share.defaultTtlSeconds 不得大于 share.maxTtlSeconds', 500);
  const uploadTtlMs = integerValue(config.uploadTtlMs === undefined ? DEFAULT_UPLOAD_TTL_MS : config.uploadTtlMs, 'uploadTtlMs', { min: 60000, max: 365 * 24 * 60 * 60 * 1000 });
  const syncHistoryLimit = integerValue(config.syncHistoryLimit === undefined ? DEFAULT_SYNC_HISTORY : config.syncHistoryLimit, 'syncHistoryLimit', { min: 1, max: 10000000 });
  if (Array.isArray(config.regions) && config.regions.some((region) => region !== REGION)) {
    throw error(codes.CONFIG_INVALID, `Disk 正式数据面只支持区域 ${REGION}`, 500);
  }
  return {
    regionId: REGION,
    quotaBytes,
    chunkSizeBytes,
    maxChunkBytes,
    maxFileBytes,
    shareDefaultTtlSeconds,
    shareMaxTtlSeconds,
    uploadTtlMs,
    syncHistoryLimit
  };
}

class DiskRepository {
  constructor({ db, deploymentId, allowInitialize = false, clock = () => Date.now() }) {
    if (!db || !deploymentId) throw error(codes.CONFIG_INVALID, 'Disk 正式仓库需要 Mongo DB 与 deploymentId', 500);
    this.db = db;
    this.deploymentId = deploymentId;
    this.allowInitialize = allowInitialize;
    this.clock = clock;
    this.files = db.collection('disk_files');
    this.folders = db.collection('disk_folders');
    this.uploads = db.collection('disk_uploads');
    this.shares = db.collection('disk_shares');
    this.syncStates = db.collection('disk_sync_states');
    this.pairingCodes = db.collection('disk_pairing_codes');
    this.devices = db.collection('disk_devices');
  }

  now() { return new Date(this.clock()).toISOString(); }
  clean(document) {
    if (!document) return null;
    const { _id, ...record } = document;
    return structuredClone({ ...record, fileId: record.fileId || _id });
  }

  async migrate() {
    const metadata = this.db.collection('runtime_metadata');
    let current = await metadata.findOne({ _id: 'disk' });
    if (!current) {
      if (!this.allowInitialize) throw error(codes.CONFIG_INVALID, 'Disk 元数据尚未登记；请显式初始化', 500);
      try {
        await metadata.insertOne({ _id: 'disk', schemaVersion: 1, deploymentId: this.deploymentId, createdAt: this.now() });
      } catch (cause) {
        if (!(cause && (cause.code === 11000 || cause.code === 11001))) throw cause;
      }
      current = await metadata.findOne({ _id: 'disk' });
    }
    if (!current || current.deploymentId !== this.deploymentId || current.schemaVersion !== 1) {
      throw error(codes.CONFIG_INVALID, 'Disk 数据模式或 deploymentId 不匹配', 500);
    }
    await this.files.createIndex({ ownerId: 1, status: 1, updatedAt: -1 }, { name: 'disk_file_owner' });
    await this.files.createIndex({ ownerId: 1, syncSeq: 1 }, { name: 'disk_file_sync' });
    await this.folders.createIndex({ ownerId: 1, parentId: 1, status: 1, name: 1 }, { name: 'disk_folder_parent' });
    await this.folders.createIndex({ ownerId: 1, syncSeq: 1 }, { name: 'disk_folder_sync' });
    await this.uploads.createIndex({ ownerId: 1, createdAt: -1 }, { name: 'disk_upload_owner' });
    await this.uploads.createIndex({ status: 1, updatedAt: 1 }, { name: 'disk_upload_recovery' });
    await this.shares.createIndex({ tokenHash: 1 }, { unique: true, name: 'disk_share_token' });
    await this.shares.createIndex({ ownerId: 1, fileId: 1, createdAt: -1 }, { name: 'disk_share_owner' });
    await this.shares.createIndex({ expiresAt: 1 }, { name: 'disk_share_expiry' });
    await this.devices.createIndex({ tokenHash: 1 }, { unique: true, name: 'disk_device_token' });
    await this.devices.createIndex({ ownerId: 1, createdAt: -1 }, { name: 'disk_device_owner' });
    await this.pairingCodes.createIndex({ codeHash: 1 }, { unique: true, name: 'disk_pairing_code' });
    await this.pairingCodes.createIndex({ expiresAt: 1 }, { name: 'disk_pairing_expiry' });
    return { schemaVersion: 1, deploymentId: this.deploymentId };
  }

  /** 对元数据变更使用 Mongo 事务；副本集不可用时返回明确错误，不静默降级。 */
  async withTransaction(task) {
    const client = this.db && this.db.client;
    if (!client || typeof client.startSession !== 'function') {
      throw error('SYNC_UNAVAILABLE', '同步元数据需要 MongoDB 事务支持', 503);
    }
    const session = client.startSession();
    try {
      let value;
      await session.withTransaction(async () => { value = await task(session); });
      return value;
    } finally {
      await session.endSession();
    }
  }

  async nextSeq(ownerId, session, historyLimit) {
    const existing = await this.syncStates.findOne({ _id: ownerId }, { session });
    if (!existing) {
      await this.syncStates.insertOne({
        _id: ownerId, seq: 0, prunedThrough: 0, epoch: this.deploymentId, updatedAt: this.now()
      }, { session });
    }
    const updated = await this.syncStates.findOneAndUpdate(
      { _id: ownerId },
      { $inc: { seq: 1 }, $set: { updatedAt: this.now() } },
      { session, returnDocument: 'after' }
    );
    const value = updated && (updated.value || updated);
    const seq = value && Number.isSafeInteger(value.seq) ? value.seq : 1;
    const limit = Number.isSafeInteger(historyLimit) && historyLimit > 0 ? historyLimit : DEFAULT_SYNC_HISTORY;
    const floor = Math.max(0, seq - limit);
    if (floor > (value.prunedThrough || 0)) {
      await this.syncStates.updateOne({ _id: ownerId }, { $set: { prunedThrough: floor } }, { session });
      value.prunedThrough = floor;
    }
    return { seq, prunedThrough: value.prunedThrough || 0 };
  }

  async getSyncState(ownerId) {
    const state = await this.syncStates.findOne({ _id: ownerId });
    return state
      ? { seq: state.seq || 0, prunedThrough: state.prunedThrough || 0, epoch: state.epoch || this.deploymentId }
      : { seq: 0, prunedThrough: 0, epoch: this.deploymentId };
  }

  async getFile(fileId, session = null) {
    return this.clean(await this.files.findOne({ _id: fileId }, { session }));
  }
  async listFiles(ownerId, { includeDeleted = false } = {}) {
    const query = { ownerId, ...(includeDeleted ? {} : { status: 'active' }) };
    return (await this.files.find(query).sort({ updatedAt: -1, _id: 1 }).toArray()).map((item) => this.clean(item));
  }
  async countFiles(ownerId) { return this.files.countDocuments({ ownerId }); }
  async putFile(file, session = null) {
    await this.files.replaceOne({ _id: file.fileId }, { ...file, _id: file.fileId }, { upsert: true, session });
    return file;
  }

  async getFolder(folderId, session = null) { return this.clean(await this.folders.findOne({ _id: folderId }, { session })); }
  async listFolders(ownerId, { parentId = undefined, includeDeleted = false } = {}) {
    const query = { ownerId, ...(includeDeleted ? {} : { status: 'active' }) };
    if (parentId !== undefined) query.parentId = parentId;
    return (await this.folders.find(query).sort({ name: 1, _id: 1 }).toArray()).map((item) => this.clean(item));
  }
  async listAllFolders(ownerId, session = null) {
    return (await this.folders.find({ ownerId }, { session }).toArray()).map((item) => this.clean(item));
  }
  async listAllFiles(ownerId, session = null) {
    return (await this.files.find({ ownerId }, { session }).toArray()).map((item) => this.clean(item));
  }
  async putFolder(folder, session = null) {
    await this.folders.replaceOne({ _id: folder.folderId }, { ...folder, _id: folder.folderId }, { upsert: true, session });
    return folder;
  }
  async changesFor(ownerId, cursor, limit) {
    const query = { ownerId, syncSeq: { $gt: cursor } };
    const [files, folders] = await Promise.all([
      this.files.find(query).sort({ syncSeq: 1 }).limit(limit).toArray(),
      this.folders.find(query).sort({ syncSeq: 1 }).limit(limit).toArray()
    ]);
    return {
      files: files.map((item) => this.clean(item)),
      folders: folders.map((item) => this.clean(item))
    };
  }

  async getUpload(uploadId) { return this.clean(await this.uploads.findOne({ _id: uploadId })); }
  async putUpload(upload, session = null) {
    await this.uploads.replaceOne({ _id: upload.uploadId }, { ...upload, _id: upload.uploadId }, { upsert: true, session });
    return upload;
  }
  async listOpenUploads(olderThanIso) {
    return (await this.uploads.find({ status: 'uploading', updatedAt: { $lt: olderThanIso } }).toArray()).map((item) => this.clean(item));
  }

  async getShare(shareId) { return this.clean(await this.shares.findOne({ _id: shareId })); }
  async getShareByToken(tokenHash) { return this.clean(await this.shares.findOne({ tokenHash })); }
  async listShares(ownerId, fileId) {
    return (await this.shares.find({ ownerId, fileId }).sort({ createdAt: -1 }).toArray()).map((item) => this.clean(item));
  }
  async putShare(share) {
    await this.shares.replaceOne({ _id: share.shareId }, { ...share, _id: share.shareId }, { upsert: true });
    return share;
  }

  async putPairingCode(code) {
    await this.pairingCodes.replaceOne({ _id: code.codeId }, { ...code, _id: code.codeId }, { upsert: true });
    return code;
  }
  async getPairingCode(codeHash) { return this.clean(await this.pairingCodes.findOne({ codeHash })); }
  async getDeviceByTokenHash(tokenHash) { return this.clean(await this.devices.findOne({ tokenHash })); }
  async getDevice(deviceId) { return this.clean(await this.devices.findOne({ _id: deviceId })); }
  async listDevices(ownerId) {
    return (await this.devices.find({ ownerId }).sort({ createdAt: -1 }).toArray()).map((item) => this.clean(item));
  }
  async putDevice(device, session = null) {
    await this.devices.replaceOne({ _id: device.deviceId }, { ...device, _id: device.deviceId }, { upsert: true, session });
    return device;
  }
  async touchDevice(deviceId) {
    await this.devices.updateOne({ _id: deviceId }, { $set: { lastSeenAt: this.now() } }).catch(() => {});
  }
}

class DiskPlatform {
  constructor(options) {
    this.options = options || {};
    this.runtime = this.options.runtime;
    this.config = normalizeConfig(this.options.config || {});
    this.logger = this.options.logger || console;
    this.clock = typeof this.options.clock === 'function' ? this.options.clock : () => Date.now();
    this.files = this.options.fileAdapter({ moduleId: MODULE_ID, regionId: this.config.regionId });
    this.repository = new DiskRepository({
      db: this.runtime.db,
      deploymentId: this.runtime.deploymentId,
      allowInitialize: Boolean(this.runtime.initialize),
      clock: this.clock
    });
    this.uploadLocks = new Map();
  }

  async start() {
    await this.repository.migrate();
    await this.cleanupStaleUploads();
    return { ok: true, storage: 'mongodb+content-store', region: this.config.regionId };
  }

  async stop() {}

  /**
   * 清理过期上传。committing 状态意味着内容已进入提交阶段：必须完成提交或保持原状，
   * 绝不能标记 expired 或删除分块。核心启动时的 content.recover() 通常已先完成这类提交。
   */
  async cleanupStaleUploads() {
    const cutoff = new Date(this.clock() - this.config.uploadTtlMs).toISOString();
    let records = [];
    try { records = await this.repository.listOpenUploads(cutoff); } catch { records = []; }
    for (const record of records) {
      const state = await this.files.uploadState(record.uploadId).catch(() => null);
      if (!state) {
        await this.repository.putUpload({ ...record, status: 'expired', updatedAt: this.now() }).catch(() => {});
        continue;
      }
      if (state.status === 'committed') {
        await this.applyCommit(record, state.result).catch((cause) => {
          this.logger.warn(`[disk] 过期上传 ${record.uploadId} 已完成但文件登记失败：${cause.message}`);
        });
        continue;
      }
      if (state.status === 'committing') {
        try {
          const result = await this.files.commitUpload({
            actor: actor(record.ownerId), uploadId: record.uploadId, baseRevision: record.baseRevision,
            metadata: { name: record.name, mimeType: record.mimeType, contentType: record.mimeType, kind: 'disk-file' },
            path: record.path
          });
          await this.applyCommit(record, result);
        } catch (cause) {
          this.logger.warn(`[disk] 过期上传 ${record.uploadId} 处于提交阶段，保留待恢复：${cause.message}`);
        }
        continue;
      }
      if (state.status !== 'uploading') {
        await this.repository.putUpload({ ...record, status: state.status, updatedAt: this.now() }).catch(() => {});
        continue;
      }
      try {
        await this.files.abortUpload(record.uploadId);
        await this.repository.putUpload({ ...record, status: 'expired', updatedAt: this.now() });
      } catch (cause) {
        this.logger.warn(`[disk] 过期上传 ${record.uploadId} 清理失败，保留待重试：${cause.message}`);
      }
    }
  }

  user(ctx, write = false) {
    if (ctx && ctx.user && typeof ctx.user.id === 'string' && SAFE_ID.test(ctx.user.id)) return ctx.user;
    throw error(write ? codes.FORBIDDEN : codes.SESSION_INVALID, write ? '未认证的写操作被拒绝' : '需要登录后访问', write ? 403 : 401);
  }
  userId(ctx) { return this.user(ctx).id; }

  /** 同步接口同时接受登录会话与设备令牌；两者都映射到同一用户身份。 */
  async userOrDevice(ctx, write = true) {
    try {
      return this.user(ctx, write);
    } catch { /* 无会话时尝试设备令牌 */ }
    const authorization = String(headerValue(ctx, 'authorization') || '');
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (!match) throw error(write ? codes.FORBIDDEN : codes.SESSION_INVALID, write ? '未认证的写操作被拒绝' : '需要登录后访问', write ? 403 : 401);
    const token = match[1].trim();
    const device = await this.repository.getDeviceByTokenHash(hashText(token));
    if (!device || device.revokedAt) throw error('DEVICE_REVOKED', '设备令牌无效或已撤销', 401);
    this.repository.touchDevice(device.deviceId);
    return { id: device.ownerId, deviceId: device.deviceId };
  }

  body(ctx) { return bodyOf(ctx); }
  folderIdOf(ctx) { return text(ctx.params && ctx.params.folderId, 'folderId', 128); }
  fileIdOf(ctx) { return text(ctx.params && ctx.params.fileId, 'fileId', 128); }
  uploadIdOf(ctx) { return text(ctx.params && ctx.params.uploadId, 'uploadId', 128); }
  now() { return this.repository.now(); }

  async withUploadLock(uploadId, task) {
    const previous = this.uploadLocks.get(uploadId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate, () => gate);
    this.uploadLocks.set(uploadId, tail);
    await previous.catch(() => {});
    try { return await task(); }
    finally {
      release();
      if (this.uploadLocks.get(uploadId) === tail) this.uploadLocks.delete(uploadId);
    }
  }

  effectiveFileLimit() {
    return this.config.maxFileBytes > 0
      ? Math.min(this.config.maxFileBytes, this.config.quotaBytes)
      : this.config.quotaBytes;
  }

  async quotaFor(userId) {
    const usage = await this.files.quotaUsage({ actor: actor(userId), ownerId: userId });
    const used = Number.isSafeInteger(usage.used) ? usage.used : 0;
    const reserved = Number.isSafeInteger(usage.reserved) ? usage.reserved : 0;
    return {
      usedBytes: used,
      reservedBytes: reserved,
      quotaBytes: this.config.quotaBytes,
      remainingBytes: Math.max(0, this.config.quotaBytes - used - reserved),
      fileCount: await this.repository.countFiles(userId),
      basis: 'logical-bytes',
      includesDeleted: true
    };
  }

  uploadView(record, state = null) {
    const chunks = state && Array.isArray(state.chunks) ? state.chunks : [];
    const receivedBytes = chunks.reduce((sum, chunk) => sum + (Number.isSafeInteger(chunk.size) ? chunk.size : 0), 0);
    return {
      uploadId: record.uploadId,
      fileId: record.fileId,
      regionId: record.regionId,
      name: record.name,
      mimeType: record.mimeType,
      size: record.size,
      sha256: record.sha256,
      chunkSize: this.config.chunkSizeBytes,
      totalChunks: Math.ceil(record.size / this.config.chunkSizeBytes),
      baseRevision: record.baseRevision,
      status: state && state.status ? state.status : record.status,
      receivedChunks: chunks.length,
      receivedBytes: state && Number.isSafeInteger(state.nextOffset) ? state.nextOffset : receivedBytes,
      nextOffset: state && Number.isSafeInteger(state.nextOffset) ? state.nextOffset : receivedBytes,
      createdAt: record.createdAt,
      completedAt: record.completedAt || null,
      result: record.result || null
    };
  }

  async stateOf(uploadId, userId) {
    let state;
    try { state = await this.files.uploadState(uploadId); }
    catch (cause) {
      if (cause instanceof CoreError && cause.status === 404) throw error('UPLOAD_NOT_FOUND', '上传任务不存在', 404);
      throw cause;
    }
    if (state.ownerId !== userId) throw error(codes.FORBIDDEN, '无权操作该上传任务', 403);
    return state;
  }

  // -- 上传 -----------------------------------------------------------------

  async initUpload(ctx) {
    const user = this.user(ctx, true);
    const body = this.body(ctx);
    const name = validateName(pick(body, 'name', 'fileName', 'filename'));
    const mimeType = validateMime(pick(body, 'mimeType', 'contentType'));
    const size = integerValue(pick(body, 'size', 'sizeBytes', 'size_bytes'), 'size', { min: 0 });
    const sha256 = normalizeSha(pick(body, 'sha256', 'contentHash'), size);
    const operationId = validateOperationId(pick(body, 'operationId', 'operation_id', 'opId'));
    const targetInput = pick(body, 'fileId', 'file_id');
    const baseRevisionInput = pick(body, 'baseRevision', 'base_revision');
    const folderIdInput = pick(body, 'folderId', 'folder_id');
    let folderId = folderIdInput === undefined || folderIdInput === null || folderIdInput === ''
      ? null
      : text(folderIdInput, 'folderId', 128);
    if (folderId !== null) {
      const folder = await this.ownedFolder(user, folderId);
      if (folder.status !== 'active') throw error('FOLDER_DELETED', '目标文件夹已删除', 409);
    }

    if (size > this.effectiveFileLimit()) {
      throw error(size > this.config.quotaBytes ? codes.QUOTA_EXCEEDED : 'FILE_TOO_LARGE', `文件不得超过 ${this.effectiveFileLimit()} 字节`, 413);
    }

    let target = null;
    // operationId 决定 uploadId，也决定新建文件的 fileId，保证重放同一操作可幂等续传。
    let fileId = operationId
      ? `fil_${hashText(`${user.id}\0${operationId}`).slice(0, 24)}`
      : `fil_${crypto.randomBytes(12).toString('hex')}`;
    let baseRevision = 0;
    if (targetInput !== undefined && targetInput !== null && targetInput !== '') {
      if (typeof targetInput !== 'string' || !SAFE_ID.test(targetInput)) throw invalid('fileId 格式非法');
      target = await this.repository.getFile(targetInput);
      if (!target) throw error('FILE_NOT_FOUND', '要覆盖的文件不存在', 404);
      if (target.ownerId !== user.id) throw error(codes.FORBIDDEN, '无权覆盖其他用户的文件', 403);
      if (target.status !== 'active') throw error('FILE_DELETED', '文件已删除，请先恢复', 409);
      if (baseRevisionInput === undefined || baseRevisionInput === null) throw invalid('覆盖已有文件时必须提供 baseRevision');
      baseRevision = integerValue(baseRevisionInput, 'baseRevision', { min: 0 });
      if (baseRevision !== target.revision) {
        throw error('REVISION_CONFLICT', `基础修订不匹配：当前 ${target.revision}，收到 ${baseRevision}`, 409);
      }
      fileId = target.fileId;
      if (folderIdInput === undefined || folderIdInput === null || folderIdInput === '') folderId = target.folderId || null;
    } else if (baseRevisionInput !== undefined && baseRevisionInput !== null) {
      const supplied = integerValue(baseRevisionInput, 'baseRevision', { min: 0 });
      if (supplied !== 0) throw error('REVISION_CONFLICT', '新建文件的基础修订必须为 0', 409);
    }

    const uploadId = operationId
      ? `upl_${hashText(`${user.id}\0${operationId}`).slice(0, 32)}`
      : `upl_${crypto.randomBytes(12).toString('hex')}`;
    const existing = await this.repository.getUpload(uploadId);
    if (existing) {
      const same = existing.ownerId === user.id && existing.name === name && existing.mimeType === mimeType
        && existing.size === size && existing.sha256 === sha256 && existing.fileId === fileId
        && existing.baseRevision === baseRevision && (existing.folderId || null) === folderId;
      if (!same) throw error('OPERATION_CONFLICT', '该 operationId 已用于不同的上传声明', 409);
      const state = await this.stateOf(uploadId, user.id).catch(() => null);
      return { status: 200, body: { uploadId, fileId, baseRevision, chunkSize: this.config.chunkSizeBytes, regionId: REGION, totalChunks: Math.ceil(size / this.config.chunkSizeBytes), operationId, upload: this.uploadView(existing, state), idempotent: true } };
    }

    let upload;
    try {
      upload = await this.files.beginUpload({
        actor: actor(user.id), ownerId: user.id,
        path: `files/${user.id}/${fileId}`, fileId,
        uploadId, operationId: `disk-${hashText(`${user.id}\0${uploadId}`).slice(0, 32)}`,
        size, sha256, quotaBytes: this.config.quotaBytes
      });
    } catch (cause) {
      if (cause instanceof CoreError) throw cause;
      throw error('STORAGE_UNAVAILABLE', '上传初始化失败', 500);
    }

    const record = {
      uploadId, ownerId: user.id, name, mimeType, fileId, baseRevision, folderId,
      regionId: REGION, size, sha256, path: upload.path,
      operationId: operationId || null, status: upload.status || 'uploading',
      result: upload.result || null, createdAt: this.now(), updatedAt: this.now(), completedAt: null
    };
    await this.repository.putUpload(record);
    return {
      status: 201,
      body: {
        uploadId, fileId, baseRevision, chunkSize: this.config.chunkSizeBytes,
        regionId: REGION, totalChunks: Math.ceil(size / this.config.chunkSizeBytes),
        operationId, upload: this.uploadView(record, upload)
      }
    };
  }

  async putChunk(ctx) {
    const user = this.user(ctx, true);
    const uploadId = this.uploadIdOf(ctx);
    const record = await this.repository.getUpload(uploadId);
    if (!record) throw error('UPLOAD_NOT_FOUND', '上传任务不存在', 404);
    if (record.ownerId !== user.id) throw error(codes.FORBIDDEN, '无权操作该上传任务', 403);

    return this.withUploadLock(uploadId, async () => {
      const state = await this.stateOf(uploadId, user.id);
      if (state.status === 'committed') throw error('UPLOAD_COMPLETED', '上传任务已提交，不能继续上传分块', 409);
      if (state.status !== 'uploading') throw error('UPLOAD_STATE', `上传状态 ${state.status} 不接受分块`, 409);
      const indexInput = ctx.params && ctx.params.index !== undefined
        ? ctx.params.index
        : pick(this.body(ctx), 'index', 'chunkIndex', 'chunk_index');
      const expectedIndex = Array.isArray(state.chunks) ? state.chunks.length : 0;
      const index = integerValue(indexInput === undefined ? expectedIndex : indexInput, '分块序号', { min: 0, max: 1000000 });
      if (index !== expectedIndex) {
        throw error('CHUNK_ORDER', `分块必须按顺序上传：期望 ${expectedIndex}`, 409, { expectedIndex, nextOffset: state.nextOffset });
      }

      let stream;
      if (ctx.stream && typeof ctx.stream[Symbol.asyncIterator] === 'function') {
        // 二进制分块：核心在写盘时限制分块大小；整文件 sha256 在提交阶段校验。
        stream = ctx.stream;
      } else {
        const buffer = chunkBuffer(ctx);
        if (buffer.length === 0) throw invalid('分块内容不能为空');
        if (buffer.length > this.config.maxChunkBytes) throw error('CHUNK_TOO_LARGE', `单个分块不得超过 ${this.config.maxChunkBytes} 字节`, 413);
        const supplied = pick(this.body(ctx), 'sha256');
        if (supplied !== undefined && supplied !== null && supplied !== '') {
          const normalized = String(supplied).trim().toLowerCase().replace(/^sha256:/, '');
          if (!HEX_SHA256.test(normalized) || normalized !== hashText(buffer)) throw error('CHUNK_HASH_MISMATCH', '分块 sha256 校验失败', 400);
        }
        stream = Readable.from(buffer);
      }

      const written = await this.files.writeChunk(uploadId, state.nextOffset, stream, { actor: actor(user.id), signal: ctx.signal });
      await this.repository.putUpload({ ...record, status: 'uploading', updatedAt: this.now() });
      return {
        status: 200,
        body: {
          uploadId, index, size: written.size, nextOffset: written.nextOffset,
          receivedChunks: expectedIndex + 1,
          receivedBytes: written.nextOffset,
          totalChunks: Math.ceil(record.size / this.config.chunkSizeBytes)
        }
      };
    });
  }

  /** 把 ContentStore 的提交结果登记为磁盘文件，并落定上传记录（幂等、带同步序号）。 */
  async applyCommit(record, result) {
    if (!result) throw error('STORAGE_UNAVAILABLE', '提交结果缺失', 500);
    return this.repository.withTransaction(async (session) => {
      const previous = await this.repository.getFile(record.fileId, session);
      const now = this.now();
      if (record.folderId) {
        const folder = await this.repository.getFolder(record.folderId, session);
        if (!folder || folder.ownerId !== record.ownerId || folder.status !== 'active') {
          throw error('FOLDER_DELETED', '目标文件夹已删除或不存在', 409);
        }
      }
      const sibling = await this.repository.files.findOne({
        ownerId: record.ownerId, folderId: record.folderId || null,
        status: 'active', name: record.name, fileId: { $ne: record.fileId }
      }, { session });
      if (sibling) throw error('NAME_CONFLICT', '同级已存在同名文件', 409);
      const { seq } = await this.repository.nextSeq(record.ownerId, session, this.config.syncHistoryLimit);
      const file = {
        fileId: record.fileId,
        ownerId: record.ownerId,
        regionId: REGION,
        folderId: record.folderId || null,
        name: record.name,
        mimeType: record.mimeType,
        size: result.size,
        revision: result.revision,
        status: 'active',
        contentHash: result.contentHash,
        createdAt: previous ? previous.createdAt : now,
        updatedAt: now,
        deletedAt: null,
        restoredAt: null,
        syncSeq: seq
      };
      await this.repository.putFile(file, session);
      await this.repository.putUpload({
        ...record, status: 'committed',
        result: { fileId: file.fileId, revision: file.revision, size: file.size, contentHash: file.contentHash },
        completedAt: now, updatedAt: now
      }, session);
      return file;
    });
  }

  async completeUpload(ctx) {
    const user = this.user(ctx, true);
    const uploadId = this.uploadIdOf(ctx);
    const record = await this.repository.getUpload(uploadId);
    if (!record) throw error('UPLOAD_NOT_FOUND', '上传任务不存在', 404);
    if (record.ownerId !== user.id) throw error(codes.FORBIDDEN, '无权提交该上传任务', 403);

    return this.withUploadLock(uploadId, async () => {
      let state = await this.stateOf(uploadId, user.id);
      if (state.status === 'failed' || state.status === 'cancelled') {
        throw error('UPLOAD_FAILED', `上传已${state.status === 'cancelled' ? '取消' : '失败'}，请重新发起`, 409);
      }
      if (state.status === 'uploading' && state.nextOffset !== state.size) {
        throw error('MISSING_CHUNKS', `分块不完整：已接收 ${state.nextOffset}/${state.size} 字节`, 400, { receivedBytes: state.nextOffset, size: state.size });
      }

      let result;
      const alreadyCommitted = state.status === 'committed';
      if (alreadyCommitted) {
        result = state.result;
      } else {
        try {
          result = await this.files.commitUpload({
            actor: actor(user.id), uploadId, baseRevision: record.baseRevision,
            metadata: { name: record.name, mimeType: record.mimeType, contentType: record.mimeType, kind: 'disk-file' },
            path: record.path, signal: ctx.signal
          });
        } catch (cause) {
          if (cause instanceof CoreError) throw cause;
          throw error('STORAGE_UNAVAILABLE', '上传提交失败', 500);
        }
      }
      const file = await this.applyCommit(record, result);
      const idempotent = Boolean(result.idempotent || alreadyCommitted);
      return {
        status: idempotent ? 200 : 201,
        body: { file: fileView(file), idempotent, fileId: file.fileId, revision: file.revision, contentHash: file.contentHash, sha256: `sha256:${file.contentHash}` }
      };
    });
  }

  async getUpload(ctx) {
    const user = this.user(ctx);
    const uploadId = this.uploadIdOf(ctx);
    const record = await this.repository.getUpload(uploadId);
    if (!record) throw error('UPLOAD_NOT_FOUND', '上传任务不存在', 404);
    if (record.ownerId !== user.id) throw error(codes.FORBIDDEN, '无权查看该上传任务', 403);
    let state = null;
    try { state = await this.files.uploadState(uploadId); } catch { state = null; }
    return { status: 200, body: { upload: this.uploadView(record, state) } };
  }

  async abortUpload(ctx) {
    const user = this.user(ctx, true);
    const uploadId = this.uploadIdOf(ctx);
    const record = await this.repository.getUpload(uploadId);
    if (!record) throw error('UPLOAD_NOT_FOUND', '上传任务不存在', 404);
    if (record.ownerId !== user.id) throw error(codes.FORBIDDEN, '无权取消该上传任务', 403);
    const result = await this.withUploadLock(uploadId, async () => {
      const aborted = await this.files.abortUpload(uploadId);
      const status = aborted.status === 'committed' ? 'committed' : 'cancelled';
      await this.repository.putUpload({ ...record, status, updatedAt: this.now() });
      return aborted;
    });
    return { status: 200, body: { uploadId, status: result.status, cancelledAt: result.cancelledAt || null, idempotent: Boolean(result.idempotent) } };
  }

  // -- 文件 -----------------------------------------------------------------

  async listFiles(ctx) {
    const user = this.user(ctx);
    const includeDeleted = truthy(queryValue(ctx, 'includeDeleted')) || truthy(queryValue(ctx, 'include_deleted'));
    const files = await this.repository.listFiles(user.id, { includeDeleted });
    return {
      status: 200,
      body: {
        files: files.map(fileView),
        regions: [REGION],
        quota: await this.quotaFor(user.id),
        chunkSizeBytes: this.config.chunkSizeBytes,
        maxChunkBytes: this.config.maxChunkBytes,
        maxFileBytes: this.effectiveFileLimit()
      }
    };
  }

  async ownedFile(user, fileId) {
    const file = await this.repository.getFile(fileId);
    if (!file) throw error('FILE_NOT_FOUND', '文件不存在', 404);
    if (file.ownerId !== user.id) throw error(codes.FORBIDDEN, '无权访问该文件', 403);
    return file;
  }

  async getFile(ctx) {
    const user = this.user(ctx);
    const file = await this.ownedFile(user, this.fileIdOf(ctx));
    return { status: 200, body: { file: fileView(file) } };
  }

  // -- 文件夹与同步元数据 ---------------------------------------------------

  async ownedFolder(user, folderId, session = null) {
    const folder = await this.repository.getFolder(folderId, session);
    if (!folder) throw error('FOLDER_NOT_FOUND', '文件夹不存在', 404);
    if (folder.ownerId !== user.id) throw error(codes.FORBIDDEN, '无权访问该文件夹', 403);
    return folder;
  }

  validateFolderName(value) {
    const name = text(value, 'name', MAX_FILE_NAME);
    if (name === '.' || name === '..' || name.trim() !== name || FOLDER_NAME_FORBIDDEN.test(name)) {
      throw invalid('文件夹名称不能包含路径分隔符、控制字符或首尾空白');
    }
    return name;
  }

  async listFolders(ctx) {
    const user = await this.userOrDevice(ctx, false);
    const parentRaw = queryValue(ctx, 'parentId');
    const parentId = parentRaw === undefined || parentRaw === '' || parentRaw === 'null' ? undefined : String(parentRaw);
    const folders = await this.repository.listFolders(user.id, { parentId });
    return {
      status: 200,
      body: {
        folders: folders.map(folderView),
        parentId: parentId === undefined ? null : parentId
      }
    };
  }

  async createFolder(ctx) {
    const user = await this.userOrDevice(ctx, true);
    const body = this.body(ctx);
    const name = this.validateFolderName(pick(body, 'name', 'folderName'));
    const parentInput = pick(body, 'parentId', 'parent_id');
    const parentId = parentInput === undefined || parentInput === null || parentInput === '' ? null : text(parentInput, 'parentId', 128);
    const operationId = validateOperationId(pick(body, 'operationId', 'operation_id', 'opId'));
    const folderId = operationId
      ? `fld_${hashText(`${user.id}\0${operationId}`).slice(0, 24)}`
      : `fld_${crypto.randomBytes(12).toString('hex')}`;

    const result = await this.repository.withTransaction(async (session) => {
      if (parentId) {
        const parent = await this.ownedFolder(user, parentId, session);
        if (parent.status !== 'active') throw error('FOLDER_DELETED', '父文件夹已删除', 409);
      }
      const existing = await this.repository.getFolder(folderId, session);
      if (existing) {
        if (existing.ownerId !== user.id || existing.name !== name || (existing.parentId || null) !== parentId) {
          throw error('OPERATION_CONFLICT', '该 operationId 已用于不同的文件夹声明', 409);
        }
        return { folder: existing, idempotent: true };
      }
      const sibling = await this.repository.folders.findOne({
        ownerId: user.id, parentId: parentId || null, status: 'active', name
      }, { session });
      if (sibling) throw error('NAME_CONFLICT', '同级已存在同名文件夹', 409);
      const now = this.now();
      const { seq } = await this.repository.nextSeq(user.id, session, this.config.syncHistoryLimit);
      const folder = {
        folderId, ownerId: user.id, parentId, name, revision: 1, status: 'active',
        createdAt: now, updatedAt: now, deletedAt: null, syncSeq: seq
      };
      await this.repository.putFolder(folder, session);
      return { folder, idempotent: false };
    });
    return { status: result.idempotent ? 200 : 201, body: { folder: folderView(result.folder), idempotent: result.idempotent } };
  }

  async patchFolder(ctx) {
    const user = await this.userOrDevice(ctx, true);
    const folderId = this.folderIdOf(ctx);
    const body = this.body(ctx);
    const baseRevision = integerValue(pick(body, 'baseRevision', 'base_revision'), 'baseRevision', { min: 1 });
    const folder = await this.repository.withTransaction(async (session) => {
      const current = await this.ownedFolder(user, folderId, session);
      if (current.status !== 'active') throw error('FOLDER_DELETED', '文件夹已删除', 409);
      if (current.revision !== baseRevision) {
        throw error('REVISION_CONFLICT', `基础修订不匹配：当前 ${current.revision}，收到 ${baseRevision}`, 409);
      }
      const hasName = body.name !== undefined || body.folderName !== undefined;
      const hasParent = body.parentId !== undefined || body.parent_id !== undefined;
      if (!hasName && !hasParent) throw invalid('至少提供 name 或 parentId');
      const name = hasName ? this.validateFolderName(pick(body, 'name', 'folderName')) : current.name;
      let parentId = current.parentId || null;
      if (hasParent) {
        const parentInput = pick(body, 'parentId', 'parent_id');
        parentId = parentInput === null || parentInput === '' ? null : text(parentInput, 'parentId', 128);
      }
      if (parentId) {
        const parent = await this.ownedFolder(user, parentId, session);
        if (parent.status !== 'active') throw error('FOLDER_DELETED', '目标父文件夹已删除', 409);
        if (parentId === folderId) throw invalid('文件夹不能移动到自身');
        // 防止把父目录移动到自己的后代，形成环。
        let cursor = parent;
        const seen = new Set();
        while (cursor && cursor.parentId) {
          if (seen.has(cursor.folderId)) throw error('FOLDER_CYCLE', '检测到文件夹环路', 409);
          seen.add(cursor.folderId);
          if (cursor.parentId === folderId) throw invalid('文件夹不能移动到自己的后代');
          cursor = await this.repository.getFolder(cursor.parentId, session);
        }
      }
      const sibling = await this.repository.folders.findOne({
        ownerId: user.id, parentId, status: 'active', name, folderId: { $ne: folderId }
      }, { session });
      if (sibling) throw error('NAME_CONFLICT', '同级已存在同名文件夹', 409);
      const { seq } = await this.repository.nextSeq(user.id, session, this.config.syncHistoryLimit);
      const updated = { ...current, name, parentId, revision: current.revision + 1, updatedAt: this.now(), syncSeq: seq };
      await this.repository.putFolder(updated, session);
      return updated;
    });
    return { status: 200, body: { folder: folderView(folder) } };
  }

  async deleteFolder(ctx) {
    const user = await this.userOrDevice(ctx, true);
    const folderId = this.folderIdOf(ctx);
    const body = this.body(ctx);
    const baseRevisionInput = pick(body, 'baseRevision', 'base_revision');
    const counts = await this.repository.withTransaction(async (session) => {
      const root = await this.ownedFolder(user, folderId, session);
      if (root.status !== 'active') throw error('FOLDER_ALREADY_DELETED', '文件夹已处于删除状态', 409);
      if (baseRevisionInput !== undefined && baseRevisionInput !== null) {
        const expected = integerValue(baseRevisionInput, 'baseRevision', { min: 1 });
        if (expected !== root.revision) throw error('REVISION_CONFLICT', `基础修订不匹配：当前 ${root.revision}，收到 ${expected}`, 409);
      }
      const folders = await this.repository.listAllFolders(user.id, session);
      const files = await this.repository.listAllFiles(user.id, session);
      const descendants = new Set([folderId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const folder of folders) {
          if (folder.status === 'active' && folder.parentId && descendants.has(folder.parentId) && !descendants.has(folder.folderId)) {
            descendants.add(folder.folderId);
            grew = true;
          }
        }
      }
      const now = this.now();
      let deletedFolders = 0;
      let deletedFiles = 0;
      for (const folder of folders) {
        if (!descendants.has(folder.folderId) || folder.status !== 'active') continue;
        const { seq } = await this.repository.nextSeq(user.id, session, this.config.syncHistoryLimit);
        await this.repository.putFolder({
          ...folder, status: 'deleted', deletedAt: now, updatedAt: now,
          revision: folder.revision + 1, syncSeq: seq
        }, session);
        deletedFolders += 1;
      }
      for (const file of files) {
        if (file.status !== 'active' || !file.folderId || !descendants.has(file.folderId)) continue;
        const { seq } = await this.repository.nextSeq(user.id, session, this.config.syncHistoryLimit);
        await this.repository.putFile({
          ...file, status: 'deleted', deletedAt: now, updatedAt: now,
          revision: file.revision + 1, syncSeq: seq
        }, session);
        deletedFiles += 1;
      }
      return { deletedFolders, deletedFiles };
    });
    return { status: 200, body: { folderId, deleted: true, ...counts } };
  }

  async restoreFolder(ctx) {
    const user = await this.userOrDevice(ctx, true);
    const folderId = this.folderIdOf(ctx);
    const body = this.body(ctx);
    const baseRevision = pick(body, 'baseRevision', 'base_revision');
    const folder = await this.repository.withTransaction(async (session) => {
      const current = await this.ownedFolder(user, folderId, session);
      if (current.status !== 'deleted') throw error('FOLDER_NOT_DELETED', '文件夹未处于删除状态', 409);
      if (baseRevision !== undefined && baseRevision !== null) {
        const expected = integerValue(baseRevision, 'baseRevision', { min: 1 });
        if (expected !== current.revision) throw error('REVISION_CONFLICT', `基础修订不匹配：当前 ${current.revision}，收到 ${expected}`, 409);
      }
      if (current.parentId) {
        const parent = await this.repository.getFolder(current.parentId, session);
        if (!parent || parent.status !== 'active') throw error('PARENT_DELETED', '父文件夹未恢复，不能恢复该文件夹', 409);
      }
      const { seq } = await this.repository.nextSeq(user.id, session, this.config.syncHistoryLimit);
      const updated = {
        ...current, status: 'active', deletedAt: null, restoredAt: this.now(),
        updatedAt: this.now(), revision: current.revision + 1, syncSeq: seq
      };
      await this.repository.putFolder(updated, session);
      return updated;
    });
    return { status: 200, body: { folder: folderView(folder) } };
  }

  async patchFile(ctx) {
    const user = await this.userOrDevice(ctx, true);
    const fileId = this.fileIdOf(ctx);
    const body = this.body(ctx);
    const baseRevision = integerValue(pick(body, 'baseRevision', 'base_revision'), 'baseRevision', { min: 1 });
    const updated = await this.repository.withTransaction(async (session) => {
      const current = await this.repository.getFile(fileId, session);
      if (!current) throw error('FILE_NOT_FOUND', '文件不存在', 404);
      if (current.ownerId !== user.id) throw error(codes.FORBIDDEN, '无权修改该文件', 403);
      if (current.status !== 'active') throw error('FILE_DELETED', '文件已删除', 409);
      if (current.revision !== baseRevision) {
        throw error('REVISION_CONFLICT', `基础修订不匹配：当前 ${current.revision}，收到 ${baseRevision}`, 409);
      }
      const hasName = body.name !== undefined || body.fileName !== undefined;
      const hasFolder = body.folderId !== undefined || body.folder_id !== undefined;
      if (!hasName && !hasFolder) throw invalid('至少提供 name 或 folderId');
      const name = hasName ? validateName(pick(body, 'name', 'fileName')) : current.name;
      let folderId = current.folderId || null;
      if (hasFolder) {
        const folderInput = pick(body, 'folderId', 'folder_id');
        folderId = folderInput === null || folderInput === '' ? null : text(folderInput, 'folderId', 128);
        if (folderId) {
          const folder = await this.ownedFolder(user, folderId, session);
          if (folder.status !== 'active') throw error('FOLDER_DELETED', '目标文件夹已删除', 409);
        }
      }
      const sibling = await this.repository.files.findOne({
        ownerId: user.id, folderId: folderId || null, status: 'active', name, fileId: { $ne: fileId }
      }, { session });
      if (sibling) throw error('NAME_CONFLICT', '同级已存在同名文件', 409);
      const { seq } = await this.repository.nextSeq(user.id, session, this.config.syncHistoryLimit);
      const next = { ...current, name, folderId, revision: current.revision + 1, updatedAt: this.now(), syncSeq: seq };
      await this.repository.putFile(next, session);
      return next;
    });
    return { status: 200, body: { file: fileView(updated) } };
  }

  async getSyncState(ctx) {
    const user = await this.userOrDevice(ctx, false);
    const state = await this.repository.getSyncState(user.id);
    return { status: 200, body: { ...state, epoch: state.epoch || this.runtime.deploymentId, historyLimit: this.config.syncHistoryLimit } };
  }

  async getSyncChanges(ctx) {
    const user = await this.userOrDevice(ctx, false);
    const state = await this.repository.getSyncState(user.id);
    const epoch = queryValue(ctx, 'epoch');
    if (epoch !== undefined && epoch !== null && epoch !== '' && epoch !== state.epoch) {
      throw error('SYNC_EPOCH_MISMATCH', '同步纪元已变化，需要全量对账', 410, { epoch: state.epoch });
    }
    const cursorInput = queryValue(ctx, 'cursor');
    let cursor = 0;
    if (cursorInput !== undefined && cursorInput !== null && cursorInput !== '') {
      if (typeof cursorInput !== 'string' || !/^\d+$/.test(cursorInput)) {
        throw error('SYNC_CURSOR_INVALID', '同步游标格式非法', 410, { cursor: state.seq });
      }
      cursor = Number(cursorInput);
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw error('SYNC_CURSOR_INVALID', '同步游标格式非法', 410, { cursor: state.seq });
    }
    if (cursor > state.seq || cursor < state.prunedThrough) {
      throw error('SYNC_CURSOR_EXPIRED', '同步游标已失效，需要全量对账', 410, { cursor: state.seq, prunedThrough: state.prunedThrough });
    }
    const limit = Math.min(1000, Math.max(1, integerValue(queryValue(ctx, 'limit') || 500, 'limit', { min: 1, max: 1000 })));
    const rows = await this.repository.changesFor(user.id, cursor, limit + 1);
    const merged = [
      ...rows.folders.map((folder) => ({
        kind: 'folder', action: folder.status === 'active' ? 'upsert' : 'delete',
        cursor: folder.syncSeq, folder: folderView(folder), revision: folder.revision
      })),
      ...rows.files.map((file) => ({
        kind: 'file', action: file.status === 'active' ? 'upsert' : 'delete',
        cursor: file.syncSeq, file: fileView(file), revision: file.revision
      }))
    ].sort((a, b) => a.cursor - b.cursor);
    const page = merged.slice(0, limit);
    const nextCursor = page.length ? page[page.length - 1].cursor : cursor;
    return {
      status: 200,
      body: {
        epoch: state.epoch, cursor: nextCursor, serverCursor: state.seq,
        hasMore: merged.length > limit, changes: page
      }
    };
  }

  async getSyncTree(ctx) {
    const user = await this.userOrDevice(ctx, false);
    const state = await this.repository.getSyncState(user.id);
    const [folders, files] = await Promise.all([
      this.repository.listFolders(user.id, { includeDeleted: false }),
      this.repository.listFiles(user.id, { includeDeleted: false })
    ]);
    return {
      status: 200,
      body: {
        epoch: state.epoch, cursor: state.seq,
        folders: folders.map(folderView),
        files: files.map(fileView)
      }
    };
  }

  // -- 设备配对与令牌 -------------------------------------------------------

  async createPairingCode(ctx) {
    const user = this.user(ctx, true);
    const code = crypto.randomBytes(9).toString('base64url');
    const now = this.clock();
    const record = {
      codeId: `pair_${crypto.randomBytes(12).toString('hex')}`,
      ownerId: user.id,
      codeHash: hashText(code),
      createdAt: this.now(),
      expiresAt: new Date(now + DEFAULT_PAIRING_TTL_MS).toISOString(),
      usedAt: null
    };
    await this.repository.putPairingCode(record);
    return { status: 201, body: { code, expiresAt: record.expiresAt, readOnly: false } };
  }

  async pairDevice(ctx) {
    const body = this.body(ctx);
    const code = text(pick(body, 'code', 'pairingCode'), 'code', 256);
    const name = text(pick(body, 'deviceName', 'name'), 'deviceName', 120);
    const platform = text(pick(body, 'platform') || 'unknown', 'platform', 40);
    const protocolVersion = integerValue(pick(body, 'protocolVersion') || 1, 'protocolVersion', { min: 1, max: 100 });
    const publicKey = pick(body, 'publicKey');
    if (publicKey !== undefined && publicKey !== null && (typeof publicKey !== 'string' || publicKey.length > 4096)) {
      throw invalid('publicKey 格式非法');
    }
    const codeHash = hashText(code);
    const record = await this.repository.getPairingCode(codeHash);
    if (!record) throw error('PAIRING_NOT_FOUND', '配对码不存在', 404);
    if (record.usedAt) throw error('PAIRING_USED', '配对码已使用', 409);
    if (Date.parse(record.expiresAt) <= this.clock()) throw error('PAIRING_EXPIRED', '配对码已过期', 410);
    const token = crypto.randomBytes(32).toString('base64url');
    const device = {
      deviceId: `dev_${crypto.randomBytes(12).toString('hex')}`,
      ownerId: record.ownerId,
      name,
      platform,
      protocolVersion,
      publicKey: typeof publicKey === 'string' ? publicKey : null,
      tokenHash: hashText(token),
      createdAt: this.now(),
      lastSeenAt: null,
      revokedAt: null
    };
    const paired = await this.repository.withTransaction(async (session) => {
      const fresh = await this.repository.pairingCodes.findOne({ _id: record.codeId }, { session });
      if (!fresh || fresh.usedAt) throw error('PAIRING_USED', '配对码已使用', 409);
      await this.repository.pairingCodes.updateOne({ _id: record.codeId }, { $set: { usedAt: this.now() } }, { session });
      await this.repository.putDevice(device, session);
      return device;
    });
    return { status: 201, body: { device: deviceView(paired), token, protocolVersion } };
  }

  async listDevices(ctx) {
    const user = this.user(ctx);
    const devices = await this.repository.listDevices(user.id);
    return { status: 200, body: { devices: devices.map(deviceView) } };
  }

  async revokeDevice(ctx) {
    const user = this.user(ctx, true);
    const deviceId = text(ctx.params && ctx.params.deviceId, 'deviceId', 128);
    const device = await this.repository.getDevice(deviceId);
    if (!device) throw error('DEVICE_NOT_FOUND', '设备不存在', 404);
    if (device.ownerId !== user.id) throw error(codes.FORBIDDEN, '无权撤销该设备', 403);
    if (device.revokedAt) return { status: 200, body: { device: deviceView(device), idempotent: true } };
    const updated = { ...device, revokedAt: this.now(), tokenHash: null };
    await this.repository.putDevice(updated);
    return { status: 200, body: { device: deviceView(updated), idempotent: false } };
  }

  async deleteFile(ctx) {
    const user = await this.userOrDevice(ctx, true);
    const fileId = this.fileIdOf(ctx);
    const body = this.body(ctx);
    const baseRevision = pick(body, 'baseRevision', 'base_revision');
    const updated = await this.repository.withTransaction(async (session) => {
      const file = await this.repository.getFile(fileId, session);
      if (!file) throw error('FILE_NOT_FOUND', '文件不存在', 404);
      if (file.ownerId !== user.id) throw error(codes.FORBIDDEN, '无权访问该文件', 403);
      if (file.status === 'deleted') throw error('FILE_ALREADY_DELETED', '文件已处于删除状态', 409);
      if (baseRevision !== undefined && baseRevision !== null) {
        const expected = integerValue(baseRevision, 'baseRevision', { min: 0 });
        if (expected !== file.revision) throw error('REVISION_CONFLICT', `基础修订不匹配：当前 ${file.revision}，收到 ${expected}`, 409);
      }
      const now = this.now();
      const { seq } = await this.repository.nextSeq(user.id, session, this.config.syncHistoryLimit);
      const next = { ...file, status: 'deleted', deletedAt: now, restoredAt: null, updatedAt: now, revision: file.revision + 1, syncSeq: seq };
      await this.repository.putFile(next, session);
      return next;
    });
    return { status: 200, body: { file: fileView(updated), fileId: updated.fileId, revision: updated.revision, status: updated.status } };
  }

  async restoreFile(ctx) {
    const user = await this.userOrDevice(ctx, true);
    const fileId = this.fileIdOf(ctx);
    const body = this.body(ctx);
    const baseRevision = pick(body, 'baseRevision', 'base_revision');
    const updated = await this.repository.withTransaction(async (session) => {
      const file = await this.repository.getFile(fileId, session);
      if (!file) throw error('FILE_NOT_FOUND', '文件不存在', 404);
      if (file.ownerId !== user.id) throw error(codes.FORBIDDEN, '无权访问该文件', 403);
      if (file.status !== 'deleted') throw error('FILE_NOT_DELETED', '文件未处于删除状态，无需恢复', 409);
      if (baseRevision !== undefined && baseRevision !== null) {
        const expected = integerValue(baseRevision, 'baseRevision', { min: 0 });
        if (expected !== file.revision) throw error('REVISION_CONFLICT', `基础修订不匹配：当前 ${file.revision}，收到 ${expected}`, 409);
      }
      if (file.folderId) {
        const folder = await this.repository.getFolder(file.folderId, session);
        if (!folder || folder.status !== 'active') throw error('PARENT_DELETED', '父文件夹未恢复，不能恢复该文件', 409);
      }
      const now = this.now();
      const { seq } = await this.repository.nextSeq(user.id, session, this.config.syncHistoryLimit);
      const next = { ...file, status: 'active', deletedAt: null, restoredAt: now, updatedAt: now, revision: file.revision + 1, syncSeq: seq };
      await this.repository.putFile(next, session);
      return next;
    });
    return { status: 200, body: { file: fileView(updated), fileId: updated.fileId, revision: updated.revision, status: updated.status } };
  }

  // -- 下载与分享 -----------------------------------------------------------

  async contentResponse(ctx, file, { viaShare = false } = {}) {
    const contentType = file.mimeType || 'application/octet-stream';
    const contentDisposition = `attachment; filename*=UTF-8''${encodeFilename(file.name)}`;
    const transportDownload = Boolean(ctx && ctx.transport && ctx.transport.kind === 'download');

    // 正式宿主：把完整流交给 HTTP transport，由它统一处理 Range、HEAD 与 416，
    // 避免下载路由返回普通 JSON 结果而被传输层判为 500。
    if (transportDownload || (ctx && ctx.res && typeof ctx.res.writeHead === 'function')) {
      let opened;
      try {
        opened = await this.files.openRead({
          actor: actor(file.ownerId), ownerId: file.ownerId, fileId: file.fileId,
          range: null, signal: ctx.signal
        });
      } catch (cause) {
        if (cause instanceof CoreError) throw cause;
        throw error('STORAGE_UNAVAILABLE', '文件内容读取失败', 500);
      }
      return {
        stream: opened.stream,
        size: opened.size,
        contentType: opened.contentType || contentType,
        etag: opened.etag,
        contentDisposition,
        close: typeof opened.close === 'function' ? opened.close : undefined,
        headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }
      };
    }

    // 直接调用 handler 的测试路径：自行解析 Range 并返回缓冲内容。
    const rangeHeader = headerValue(ctx, 'range');
    let range = null;
    if (rangeHeader !== undefined && rangeHeader !== null && rangeHeader !== '') {
      range = parseRange(rangeHeader, file.size);
      if (range === false) {
        return {
          status: 416,
          headers: { 'accept-ranges': 'bytes', 'content-range': `bytes */${file.size}` },
          body: { code: codes.INVALID_INPUT, message: 'Range 不可满足' }
        };
      }
    }
    let opened;
    try {
      opened = await this.files.openRead({
        actor: actor(file.ownerId), ownerId: file.ownerId, fileId: file.fileId,
        range: range ? { start: range.start, end: range.end } : null, signal: ctx.signal
      });
    } catch (cause) {
      if (cause instanceof CoreError) throw cause;
      throw error('STORAGE_UNAVAILABLE', '文件内容读取失败', 500);
    }
    const headers = {
      'content-type': opened.contentType || contentType,
      'content-length': String(range ? range.length : opened.size),
      'accept-ranges': 'bytes',
      'cache-control': 'private, no-store',
      etag: opened.etag,
      'x-content-type-options': 'nosniff',
      'content-disposition': contentDisposition
    };
    if (range) headers['content-range'] = `bytes ${range.start}-${range.end}/${opened.size}`;
    const chunks = [];
    try {
      for await (const chunk of opened.stream) chunks.push(chunk);
    } finally {
      if (typeof opened.close === 'function') await opened.close();
    }
    return { status: range ? 206 : 200, headers, body: Buffer.concat(chunks) };
  }

  async getFileContent(ctx) {
    const user = ctx && ctx.user && typeof ctx.user.id === 'string' ? ctx.user : null;
    const file = await this.repository.getFile(this.fileIdOf(ctx));
    if (!file) throw error('FILE_NOT_FOUND', '文件不存在', 404);
    let viaShare = false;
    if (user && user.id === file.ownerId) {
      viaShare = false;
    } else {
      const token = this.tokenFrom(ctx);
      if (token) {
        const share = await this.requireShare(token);
        if (share.fileId !== file.fileId) throw error('SHARE_NOT_FOUND', '分享令牌与文件不匹配', 404);
        viaShare = true;
      } else if (!user) {
        throw error('UNAUTHENTICATED', '未认证，且未提供分享令牌', 401);
      } else {
        throw error(codes.FORBIDDEN, '无权读取该文件', 403);
      }
    }
    if (file.status !== 'active' && viaShare) throw error('FILE_DELETED', '文件已删除，分享不可用', 410);
    return this.contentResponse(ctx, file, { viaShare });
  }

  tokenFrom(ctx) {
    const fromQuery = queryValue(ctx, 'token') || queryValue(ctx, 'share');
    if (typeof fromQuery === 'string' && fromQuery.trim()) return fromQuery.trim();
    const header = headerValue(ctx, 'x-share-token');
    if (typeof header === 'string' && header.trim()) return header.trim();
    const authorization = headerValue(ctx, 'authorization');
    if (typeof authorization === 'string' && /^share\s+/i.test(authorization.trim())) return authorization.trim().replace(/^share\s+/i, '').trim();
    return null;
  }

  async requireShare(token) {
    if (typeof token !== 'string' || !token.trim()) throw error('SHARE_NOT_FOUND', '分享令牌不存在', 404);
    const share = await this.repository.getShareByToken(hashText(token.trim()));
    if (!share) throw error('SHARE_NOT_FOUND', '分享令牌不存在', 404);
    if (share.revokedAt) throw error('SHARE_REVOKED', '分享令牌已撤销', 410);
    if (Date.parse(share.expiresAt) <= this.clock()) throw error('SHARE_EXPIRED', '分享令牌已过期', 410);
    if (share.readOnly !== true) throw error('SHARE_INVALID', '分享令牌权限非法', 500);
    return share;
  }

  async createShare(ctx) {
    const user = this.user(ctx, true);
    const file = await this.ownedFile(user, this.fileIdOf(ctx));
    if (file.status !== 'active') throw error('FILE_DELETED', '已删除文件不能创建分享', 409);
    const body = this.body(ctx);
    const expiresIn = pick(body, 'expiresInSeconds', 'expires_in_seconds', 'ttlSeconds', 'expiresIn', 'ttl');
    const expiresAtInput = pick(body, 'expiresAt', 'expires_at');
    if (expiresIn !== undefined && expiresIn !== null && expiresAtInput !== undefined && expiresAtInput !== null) {
      throw invalid('expiresInSeconds 与 expiresAt 只能提供一个');
    }
    const now = this.clock();
    let expiresMs;
    if (expiresAtInput !== undefined && expiresAtInput !== null) {
      if (typeof expiresAtInput !== 'string' || !Number.isFinite(Date.parse(expiresAtInput))) throw invalid('expiresAt 必须是 RFC 3339 时间字符串');
      expiresMs = Date.parse(expiresAtInput);
    } else {
      const seconds = expiresIn === undefined || expiresIn === null
        ? this.config.shareDefaultTtlSeconds
        : integerValue(expiresIn, 'expiresInSeconds', { min: 1, max: this.config.shareMaxTtlSeconds });
      expiresMs = now + seconds * 1000;
    }
    if (expiresMs <= now) throw invalid('分享过期时间必须晚于当前时间');
    if (expiresMs > now + this.config.shareMaxTtlSeconds * 1000) throw invalid(`分享有效期不能超过 ${this.config.shareMaxTtlSeconds} 秒`);

    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashText(token);
    const share = {
      shareId: `shr_${crypto.randomBytes(12).toString('hex')}`,
      fileId: file.fileId,
      ownerId: user.id,
      tokenHash,
      readOnly: true,
      createdAt: this.now(),
      expiresAt: new Date(expiresMs).toISOString(),
      revokedAt: null
    };
    await this.repository.putShare(share);
    return {
      status: 201,
      body: {
        share: { ...shareView(share), token, urlPath: `/api/disk/shares/${token}/content` },
        shareId: share.shareId, fileId: file.fileId, token, expiresAt: share.expiresAt,
        readOnly: true, urlPath: `/api/disk/shares/${token}/content`, file: publicFileView(file)
      }
    };
  }

  async listShares(ctx) {
    const user = this.user(ctx);
    const file = await this.ownedFile(user, this.fileIdOf(ctx));
    const shares = await this.repository.listShares(user.id, file.fileId);
    return { status: 200, body: { shares: shares.map(shareView) } };
  }

  async revokeShare(ctx) {
    const user = this.user(ctx, true);
    const shareId = text(ctx.params && ctx.params.shareId, 'shareId', 128);
    const share = await this.repository.getShare(shareId);
    if (!share) throw error('SHARE_NOT_FOUND', '分享不存在', 404);
    if (share.ownerId !== user.id) throw error(codes.FORBIDDEN, '无权撤销该分享', 403);
    if (share.revokedAt) return { status: 200, body: { share: shareView(share), idempotent: true } };
    const updated = { ...share, revokedAt: this.now() };
    await this.repository.putShare(updated);
    return { status: 200, body: { share: shareView(updated), idempotent: false } };
  }

  async getShare(ctx) {
    const token = text(ctx.params && ctx.params.token, 'token', 512);
    const share = await this.requireShare(token);
    const file = await this.repository.getFile(share.fileId);
    if (!file) throw error('FILE_NOT_FOUND', '分享对应的文件不存在', 404);
    if (file.status !== 'active') throw error('FILE_DELETED', '文件已删除，分享不可用', 410);
    return {
      status: 200,
      body: {
        share: shareView(share), file: publicFileView(file),
        shareId: share.shareId, fileId: share.fileId, expiresAt: share.expiresAt, readOnly: true
      }
    };
  }

  async getShareContent(ctx) {
    const token = text(ctx.params && ctx.params.token, 'token', 512);
    const share = await this.requireShare(token);
    const file = await this.repository.getFile(share.fileId);
    if (!file) throw error('FILE_NOT_FOUND', '分享对应的文件不存在', 404);
    if (file.status !== 'active') throw error('FILE_DELETED', '文件已删除，分享不可用', 410);
    return this.contentResponse(ctx, file, { viaShare: true });
  }

  // -- 视图 -----------------------------------------------------------------

  async getQuota(ctx) {
    const user = this.user(ctx);
    return { status: 200, body: { ...(await this.quotaFor(user.id)), regions: [REGION], chunkSizeBytes: this.config.chunkSizeBytes, maxChunkBytes: this.config.maxChunkBytes, maxFileBytes: this.effectiveFileLimit() } };
  }

  async health() {
    return { status: 200, body: { ok: true, module: MODULE_ID, storage: 'mongodb+content-store', region: REGION, regions: [REGION] } };
  }

  async info() {
    return {
      status: 200,
      body: {
        module: MODULE_ID, version: MODULE_VERSION, ready: true,
        storage: 'mongodb+content-store', region: REGION, regions: [REGION],
        chunkSizeBytes: this.config.chunkSizeBytes, maxChunkBytes: this.config.maxChunkBytes,
        maxFileBytes: this.effectiveFileLimit(), quotaBytes: this.config.quotaBytes
      }
    };
  }

  async listRegions(ctx) {
    this.user(ctx);
    return { status: 200, body: { regions: [{ regionId: REGION, visible: true, syncable: true, quotaBasis: 'logical-bytes', quotaBytes: this.config.quotaBytes }], defaultRegion: REGION } };
  }

  async handle(method, ctx) {
    try {
      if (!this[method] || method === 'handle' || method.startsWith('_')) throw error(codes.NOT_FOUND, '接口不存在', 404);
      return await this[method](ctx);
    } catch (cause) {
      if (cause instanceof CoreError) {
        return {
          status: cause.status,
          body: { code: cause.code, message: cause.message, ...(cause.details && cause.status < 500 ? { details: cause.details } : {}) }
        };
      }
      this.logger.error(`[disk] ${method} 失败：${cause && cause.message ? cause.message : 'unknown'}`);
      return { status: 500, body: { code: 'INTERNAL', message: '内部错误' } };
    }
  }
}

module.exports = { DiskPlatform, DiskRepository, REGION, normalizeConfig, fileView, publicFileView };
