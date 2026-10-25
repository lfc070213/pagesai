'use strict';
// PagesAI 公开版 · Disk 模块（单逻辑盘）服务端
// 方案依据：§6.1（数据根与区域）、§6.2（Disk 是授权视图）、§6.3（写入一致性）、§7.2（Disk 服务）。
//
// 范围与硬性约束：
//  - 只有一个逻辑盘：不出现盘号、跨盘复制、双数据根；对外区域固定为 manifest 声明的 disk.user-files。
//  - 只暴露 config.regions 声明的区域；不扫描宿主目录，文件内容与元数据全部来自 JsonStore。
//  - 稳定 fileId + revision；complete 校验 baseRevision，冲突返回 409；operationId 保证完成幂等。
//  - 分块上传 init/chunks/complete、Range 下载、软删与恢复、只读分享令牌（带过期时间）。
//  - 配额按用户逻辑字节数（active + 软删文件都计入），默认 1 GiB，超限 413。
//  - 网络策略中性：不包含校园探测、校内域名判定或任何链路分流逻辑。
//  - 未配置/未实现的存储适配器明确返回 409，绝不伪造上传、下载、分享等业务结果。
//
// 统一模块接口：module.exports = { start, stop, health, routes, tools }。
// 所有路由以 /api/disk/ 开头；handler(ctx) 返回 { status, body }（二进制下载额外返回 headers）。

const crypto = require('node:crypto');
const path = require('node:path');
const { Readable } = require('node:stream');

const { JsonStore } = require('../../../core/storage/json-store');
const { CoreError, codes } = require('../../../core/errors');
const { validate } = require('../../../core/contracts/validate');
const CONFIG_SCHEMA = require('../config.schema.json');

const MODULE_ID = 'disk';
const ROUTE_PREFIX = '/api/disk';
const REGION_FILES = 'disk.user-files';
const DEFAULT_QUOTA_BYTES = 1024 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 5 * 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_FILE_NAME = 255;
const MAX_OPERATION_ID = 128;
const MAX_CHUNK_INDEX = 1000000;
const DEFAULT_SHARE_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_SHARE_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
const COLLECTIONS = Object.freeze(['files', 'uploads', 'chunks', 'blobs', 'shares', 'shareTokens', 'operations']);

let active = null;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function fail(code, message, status = 400) {
  throw new CoreError(code, message, { status });
}

function invalid(message) {
  fail(codes.INVALID_INPUT, message, 400);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function newId(prefix, byteLength = 12) {
  // prefix 自带下划线（fil_/upl_/shr_），避免出现双下划线。
  return `${prefix}${crypto.randomBytes(byteLength).toString('hex')}`;
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value) ? value : {};
}

function bodyOf(ctx) {
  return asObject(ctx && ctx.body);
}

function arrayFirst(value) {
  return Array.isArray(value) ? value[0] : value;
}

function headerValue(ctx, name) {
  if (!ctx) return undefined;
  const lower = String(name).toLowerCase();
  for (const headers of [ctx.req && ctx.req.headers, ctx.headers]) {
    if (!headers || typeof headers !== 'object') continue;
    if (headers[lower] !== undefined) return arrayFirst(headers[lower]);
    if (headers[name] !== undefined) return arrayFirst(headers[name]);
  }
  return undefined;
}

function queryValue(ctx, name) {
  if (!ctx) return undefined;
  if (ctx.query && typeof ctx.query === 'object' && ctx.query[name] !== undefined) {
    return arrayFirst(ctx.query[name]);
  }
  if (ctx.url && typeof ctx.url.searchParams === 'object' && typeof ctx.url.searchParams.get === 'function') {
    const value = ctx.url.searchParams.get(name);
    if (value !== null) return value;
  }
  return undefined;
}

function truthy(value) {
  const text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

/** 兼容常见字段别名，减少客户端迁移期的无谓失败。 */
function pick(object, ...keys) {
  for (const key of keys) {
    if (object && object[key] !== undefined) return object[key];
  }
  return undefined;
}

function loggerOf(input) {
  if (input && typeof input === 'object') {
    return {
      info: typeof input.info === 'function' ? input.info.bind(input) : () => {},
      warn: typeof input.warn === 'function' ? input.warn.bind(input) : () => {},
      error: typeof input.error === 'function' ? input.error.bind(input) : () => {}
    };
  }
  return { info() {}, warn() {}, error() {} };
}

function integerValue(value, field, options = {}) {
  const { min = 0, max = Number.MAX_SAFE_INTEGER, required = true } = options;
  if (value === undefined || value === null || value === '') {
    if (!required) return null;
    invalid(`${field} 必须是整数`);
  }
  let number = value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) number = Number(value.trim());
  if (!Number.isInteger(number)) invalid(`${field} 必须是整数`);
  if (number < min || number > max) invalid(`${field} 必须在 ${min}-${max} 之间`);
  return number;
}

function optionalString(value, field, maxLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') invalid(`${field} 必须是字符串`);
  const text = value.trim();
  if (!text) invalid(`${field} 不能为空`);
  if (text.length > maxLength) invalid(`${field} 不能超过 ${maxLength} 个字符`);
  return text;
}

function validateName(value) {
  if (typeof value !== 'string') invalid('name 必须是字符串');
  const name = value.trim();
  if (!name) invalid('name 不能为空');
  if (name.length > MAX_FILE_NAME) invalid(`name 不能超过 ${MAX_FILE_NAME} 个字符`);
  if (name === '.' || name === '..') invalid('name 不能是 . 或 ..');
  if (/[\\/]/.test(name)) invalid('name 不能包含路径分隔符');
  if (/[\u0000-\u001f\u007f]/.test(name)) invalid('name 不能包含控制字符');
  return name;
}

function validateMimeType(value) {
  if (value === undefined || value === null || value === '') return 'application/octet-stream';
  if (typeof value !== 'string') invalid('mimeType 必须是字符串');
  const mime = value.trim();
  if (!mime) return 'application/octet-stream';
  if (mime.length > 200) invalid('mimeType 不能超过 200 个字符');
  if (/[\u0000-\u001f\u007f]/.test(mime)) invalid('mimeType 不能包含控制字符');
  return mime;
}

function validateOperationId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') invalid('operationId 必须是字符串');
  const operationId = value.trim();
  if (!operationId) return null;
  // 契约建议 8-128；这里放宽下限以避免旧客户端迁移期被误拒，但仍限制长度与字符。
  if (operationId.length > MAX_OPERATION_ID) invalid(`operationId 不能超过 ${MAX_OPERATION_ID} 个字符`);
  return operationId;
}

function validateDeclaredHash(value) {
  if (typeof value !== 'string') invalid('sha256 必须是字符串');
  const text = value.trim().toLowerCase();
  const hex = text.startsWith('sha256:') ? text.slice('sha256:'.length) : text;
  if (!/^[0-9a-f]{64}$/.test(hex)) invalid('sha256 必须是 64 位十六进制（可带 sha256: 前缀）');
  return `sha256:${hex}`;
}

function decodeBase64(value, field) {
  let text = String(value === undefined || value === null ? '' : value).trim();
  const dataUrl = /^data:[^,]*;base64,/i.exec(text);
  if (dataUrl) text = text.slice(dataUrl[0].length);
  text = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) invalid(`${field} 不是合法 base64`);
  if (text.length % 4 === 1) invalid(`${field} 不是合法 base64`);
  return Buffer.from(text, 'base64');
}

/** 分块请求体：支持原始 Buffer、base64 字符串、{data|base64|chunk}、{text}。 */
function chunkPayload(ctx) {
  const body = ctx && ctx.body;
  let buffer = null;
  let declaredHash = null;

  if (Buffer.isBuffer(body)) {
    buffer = body;
  } else if (typeof body === 'string') {
    buffer = decodeBase64(body, '分块内容');
  } else if (body && typeof body === 'object' && !Array.isArray(body)) {
    if (body.sha256 !== undefined && body.sha256 !== null && body.sha256 !== '') {
      declaredHash = validateDeclaredHash(body.sha256);
    }
    if (Buffer.isBuffer(body.data)) {
      buffer = body.data;
    } else if (typeof body.data === 'string') {
      buffer = body.encoding === 'utf8' || body.encoding === 'text'
        ? Buffer.from(body.data, 'utf8')
        : decodeBase64(body.data, '分块内容');
    } else if (typeof body.base64 === 'string') {
      buffer = decodeBase64(body.base64, '分块内容');
    } else if (typeof body.chunk === 'string') {
      buffer = decodeBase64(body.chunk, '分块内容');
    } else if (typeof body.text === 'string') {
      buffer = Buffer.from(body.text, 'utf8');
    }
  }

  if (!buffer) invalid('请求体缺少分块内容（data/base64/chunk，base64 编码）');

  if (!declaredHash) {
    const headerHash = headerValue(ctx, 'x-chunk-sha256');
    if (headerHash !== undefined && headerHash !== null && headerHash !== '') {
      declaredHash = validateDeclaredHash(headerHash);
    }
  }
  return { buffer, declaredHash };
}

function encodeFilename(name) {
  // RFC 5987：只保留 attr-char，其余百分号编码，避免头部注入。
  return encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function parseRange(value, size) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (!/^bytes=/i.test(text)) fail('RANGE_NOT_SATISFIABLE', '只支持 bytes 范围', 416);
  const specs = text.slice('bytes='.length).split(',').map((item) => item.trim()).filter(Boolean);
  if (specs.length !== 1) fail('RANGE_NOT_SATISFIABLE', '不支持多段 Range', 416);
  const matched = /^(\d*)-(\d*)$/.exec(specs[0]);
  if (!matched || (matched[1] === '' && matched[2] === '')) {
    fail('RANGE_NOT_SATISFIABLE', 'Range 格式无效', 416);
  }
  if (size <= 0) fail('RANGE_NOT_SATISFIABLE', '空文件没有可满足的范围', 416);

  let start;
  let end;
  if (matched[1] === '') {
    const suffix = Number(matched[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) fail('RANGE_NOT_SATISFIABLE', 'Range 后缀无效', 416);
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(matched[1]);
    end = matched[2] === '' ? size - 1 : Number(matched[2]);
    if (!Number.isSafeInteger(start) || start < 0) fail('RANGE_NOT_SATISFIABLE', 'Range 起点无效', 416);
    if (!Number.isSafeInteger(end) || end < start) fail('RANGE_NOT_SATISFIABLE', 'Range 终点无效', 416);
    if (start >= size) fail('RANGE_NOT_SATISFIABLE', 'Range 起点超出文件大小', 416);
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function fileView(file) {
  return {
    fileId: file.fileId,
    name: file.name,
    size: file.size,
    revision: file.revision,
    status: file.status,
    regionId: file.regionId,
    mimeType: file.mimeType,
    contentHash: file.contentHash,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    deletedAt: file.deletedAt === undefined ? null : file.deletedAt,
    restoredAt: file.restoredAt === undefined ? null : file.restoredAt
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
    revokedAt: share.revokedAt === undefined ? null : share.revokedAt
  };
}

function operationKey(operationId) {
  // 加固定前缀，避免用户提供的 operationId 命中对象原型属性。
  return `op:${operationId}`;
}

function normalizeConfig(input) {
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
    fail(codes.CONFIG_INVALID, 'Disk 配置必须是对象', 500);
  }
  const raw = input === undefined || input === null ? {} : input;
  const result = validate(CONFIG_SCHEMA, raw);
  if (!result.valid) {
    fail(codes.CONFIG_INVALID, 'Disk 配置不符合 config.schema.json', 500);
  }

  const regions = Array.isArray(raw.regions) ? raw.regions.slice() : [REGION_FILES];
  if (regions.length === 0) fail(codes.CONFIG_INVALID, 'config.regions 至少需要一个区域', 500);
  for (const region of regions) {
    if (region !== REGION_FILES) {
      fail(codes.CONFIG_INVALID, `区域 ${region} 未在模块清单中登记`, 500);
    }
  }

  let dataFile = null;
  if (raw.dataFile !== undefined && raw.dataFile !== null) {
    dataFile = path.resolve(String(raw.dataFile));
  }

  const quotaBytes = integerValue(raw.quotaBytes === undefined ? DEFAULT_QUOTA_BYTES : raw.quotaBytes, 'quotaBytes', {
    min: 1,
    max: Number.MAX_SAFE_INTEGER
  });
  const chunkSizeBytes = integerValue(raw.chunkSizeBytes === undefined ? DEFAULT_CHUNK_BYTES : raw.chunkSizeBytes, 'chunkSizeBytes', {
    min: 1,
    max: MAX_CHUNK_BYTES
  });
  const maxChunkBytes = integerValue(raw.maxChunkBytes === undefined ? MAX_CHUNK_BYTES : raw.maxChunkBytes, 'maxChunkBytes', {
    min: 1,
    max: MAX_CHUNK_BYTES
  });
  if (maxChunkBytes < chunkSizeBytes) {
    fail(codes.CONFIG_INVALID, 'maxChunkBytes 不得小于 chunkSizeBytes', 500);
  }
  const maxFileBytes = integerValue(raw.maxFileBytes === undefined ? 0 : raw.maxFileBytes, 'maxFileBytes', {
    min: 0,
    max: Number.MAX_SAFE_INTEGER
  });
  const share = raw.share && typeof raw.share === 'object' ? raw.share : {};
  const shareDefaultTtlSeconds = integerValue(
    share.defaultTtlSeconds === undefined ? DEFAULT_SHARE_TTL_SECONDS : share.defaultTtlSeconds,
    'share.defaultTtlSeconds',
    { min: 1, max: 31536000 }
  );
  const shareMaxTtlSeconds = integerValue(
    share.maxTtlSeconds === undefined ? DEFAULT_SHARE_MAX_TTL_SECONDS : share.maxTtlSeconds,
    'share.maxTtlSeconds',
    { min: 1, max: 31536000 }
  );
  if (shareDefaultTtlSeconds > shareMaxTtlSeconds) {
    fail(codes.CONFIG_INVALID, 'share.defaultTtlSeconds 不得大于 share.maxTtlSeconds', 500);
  }

  const storageAdapter = raw.storageAdapter === undefined ? 'json' : String(raw.storageAdapter);
  if (storageAdapter !== 'json' && storageAdapter !== 'object-storage') {
    fail(codes.CONFIG_INVALID, `不支持的 storageAdapter: ${storageAdapter}`, 500);
  }

  return {
    dataFile,
    regions,
    defaultRegion: regions[0],
    quotaBytes,
    chunkSizeBytes,
    maxChunkBytes,
    maxFileBytes,
    shareDefaultTtlSeconds,
    shareMaxTtlSeconds,
    storageAdapter
  };
}

// ---------------------------------------------------------------------------
// DiskService：单盘数据面
// ---------------------------------------------------------------------------

class DiskService {
  constructor(configInput, logger, clock) {
    this.config = normalizeConfig(configInput);
    this.logger = loggerOf(logger);
    this.clock = typeof clock === 'function' ? clock : () => Date.now();
    try {
      this.store = new JsonStore({ filePath: this.config.dataFile });
    } catch (err) {
      fail(codes.CONFIG_INVALID, `Disk 数据文件无法加载：${err.message}`, 500);
    }
    for (const collection of COLLECTIONS) this.store.get(collection);
  }

  // -- 状态与存储 ------------------------------------------------------------

  nowMs() {
    const value = this.clock();
    const ms = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(ms)) fail('CLOCK_INVALID', '时钟返回了非法时间', 500);
    return ms;
  }

  nowIso() {
    return new Date(this.nowMs()).toISOString();
  }

  bucket(name) {
    return this.store.get(name);
  }

  save() {
    try {
      this.store.save();
    } catch (err) {
      this.logger.error('[disk] JsonStore 写入失败', err);
      fail('STORAGE_UNAVAILABLE', '数据写入失败，请检查 dataFile 权限与磁盘空间', 500);
    }
  }

  /** 适配器守卫：未实现的存储适配器一律 409，不返回任何伪造成功结果。 */
  requireAdapter() {
    if (this.config.storageAdapter !== 'json') {
      fail(
        'DISK_ADAPTER_NOT_CONFIGURED',
        `存储适配器 ${this.config.storageAdapter} 尚未配置或未实现；请使用内置 json 适配器`,
        409
      );
    }
  }

  ensureRegion(regionId) {
    const value = regionId === undefined || regionId === null || regionId === '' ? this.config.defaultRegion : String(regionId);
    if (!this.config.regions.includes(value)) {
      fail('REGION_NOT_EXPOSED', `区域 ${value} 未在 config.regions 中声明`, 404);
    }
    return value;
  }

  principal(ctx, options = {}) {
    const write = options.write === true;
    const user = ctx && ctx.user;
    if (!user || typeof user !== 'object' || Array.isArray(user)) {
      throw new CoreError(write ? codes.FORBIDDEN : 'UNAUTHENTICATED', write ? '未认证的写操作' : '未认证', {
        status: write ? 403 : 401
      });
    }
    let id = user.id === undefined ? user.userId : user.id;
    if (typeof id === 'number') id = String(id);
    if (typeof id !== 'string' || !id.trim()) {
      throw new CoreError(write ? codes.FORBIDDEN : 'UNAUTHENTICATED', '用户身份缺少稳定 ID', {
        status: write ? 403 : 401
      });
    }
    return { id: id.trim(), username: typeof user.username === 'string' ? user.username : null };
  }

  optionalPrincipal(ctx) {
    const user = ctx && ctx.user;
    if (!user || typeof user !== 'object' || Array.isArray(user)) return null;
    try {
      return this.principal(ctx, { write: false });
    } catch {
      return null;
    }
  }

  usageFor(ownerId) {
    let usedBytes = 0;
    let fileCount = 0;
    const bucket = this.bucket('files');
    for (const key of Object.keys(bucket)) {
      const file = bucket[key];
      if (!file || file.ownerId !== ownerId) continue;
      usedBytes += Number.isSafeInteger(file.size) ? file.size : 0;
      fileCount += 1;
    }
    // 软删文件保留内容与逻辑字节，计入配额；恢复因此不会额外占用。
    return { usedBytes, fileCount };
  }

  quotaView(ownerId) {
    const usage = this.usageFor(ownerId);
    return {
      usedBytes: usage.usedBytes,
      quotaBytes: this.config.quotaBytes,
      remainingBytes: Math.max(0, this.config.quotaBytes - usage.usedBytes),
      fileCount: usage.fileCount,
      basis: 'logical-bytes',
      includesDeleted: true
    };
  }

  effectiveFileLimit() {
    return this.config.maxFileBytes > 0
      ? Math.min(this.config.quotaBytes, this.config.maxFileBytes)
      : this.config.quotaBytes;
  }

  fileRecord(fileId) {
    const id = typeof fileId === 'string' ? fileId : '';
    if (!/^fil_[0-9a-f]{24}$/.test(id)) return null;
    const bucket = this.bucket('files');
    return hasOwn(bucket, id) ? bucket[id] : null;
  }

  uploadRecord(uploadId) {
    const id = typeof uploadId === 'string' ? uploadId : '';
    if (!/^upl_[0-9a-f]{24}$/.test(id)) return null;
    const bucket = this.bucket('uploads');
    return hasOwn(bucket, id) ? bucket[id] : null;
  }

  shareRecord(shareId) {
    const id = typeof shareId === 'string' ? shareId : '';
    if (!/^shr_[0-9a-f]{24}$/.test(id)) return null;
    const bucket = this.bucket('shares');
    return hasOwn(bucket, id) ? bucket[id] : null;
  }

  operationRecord(operationId) {
    if (!operationId) return null;
    const bucket = this.bucket('operations');
    const key = operationKey(operationId);
    return hasOwn(bucket, key) ? bucket[key] : null;
  }

  // -- 分块上传 --------------------------------------------------------------

  initUpload(ctx) {
    const principal = this.principal(ctx, { write: true });
    this.requireAdapter();
    const body = bodyOf(ctx);
    const regionId = this.ensureRegion(pick(body, 'regionId', 'region'));
    const name = validateName(pick(body, 'name', 'fileName', 'filename'));
    const mimeType = validateMimeType(pick(body, 'mimeType', 'contentType'));
    const operationId = validateOperationId(pick(body, 'operationId', 'operation_id', 'opId'));
    const chunkSizeInput = pick(body, 'chunkSize', 'chunk_size');
    const sizeInput = pick(body, 'size', 'sizeBytes', 'size_bytes');
    const targetFileId = pick(body, 'fileId', 'file_id');
    const baseRevisionInput = pick(body, 'baseRevision', 'base_revision');
    const totalChunksInput = pick(body, 'totalChunks', 'total_chunks');

    const chunkSize = chunkSizeInput === undefined
      ? this.config.chunkSizeBytes
      : integerValue(chunkSizeInput, 'chunkSize', { min: 1, max: this.config.maxChunkBytes });

    const expectedSize = sizeInput === undefined || sizeInput === null
      ? null
      : integerValue(sizeInput, 'size', { min: 0, max: Number.MAX_SAFE_INTEGER });
    if (expectedSize !== null) {
      if (this.config.maxFileBytes > 0 && expectedSize > this.config.maxFileBytes) {
        fail('FILE_TOO_LARGE', `单文件不得超过 ${this.config.maxFileBytes} 字节`, 413);
      }
      if (expectedSize > this.config.quotaBytes) {
        fail('QUOTA_EXCEEDED', `文件大小超过配额 ${this.config.quotaBytes} 字节`, 413);
      }
    }

    let fileId = null;
    let baseRevision = 0;
    let target = null;
    if (targetFileId !== undefined && targetFileId !== null && targetFileId !== '') {
      if (typeof targetFileId !== 'string') invalid('fileId 必须是字符串');
      target = this.fileRecord(targetFileId);
      if (!target) fail('FILE_NOT_FOUND', '要覆盖的文件不存在', 404);
      this.ensureRegion(target.regionId);
      if (target.ownerId !== principal.id) fail(codes.FORBIDDEN, '无权覆盖其他用户的文件', 403);
      if (target.regionId !== regionId) fail('REGION_MISMATCH', '覆盖上传不得改变文件所属区域', 409);
      if (target.status !== 'active') fail('FILE_DELETED', '文件已删除，请先恢复', 409);
      if (baseRevisionInput === undefined || baseRevisionInput === null) {
        invalid('覆盖已有文件时必须提供 baseRevision');
      }
      baseRevision = integerValue(baseRevisionInput, 'baseRevision', { min: 0 });
      if (baseRevision !== target.revision) {
        fail('REVISION_CONFLICT', `基础修订不匹配：当前 ${target.revision}，收到 ${baseRevision}`, 409);
      }
      fileId = target.fileId;
    } else if (baseRevisionInput !== undefined && baseRevisionInput !== null) {
      const supplied = integerValue(baseRevisionInput, 'baseRevision', { min: 0 });
      if (supplied !== 0) {
        fail('REVISION_CONFLICT', '新建文件的基础修订必须为 0', 409);
      }
    }

    if (expectedSize !== null) {
      const usage = this.usageFor(principal.id);
      const replacing = target ? target.size : 0;
      if (usage.usedBytes - replacing + expectedSize > this.config.quotaBytes) {
        fail(
          'QUOTA_EXCEEDED',
          `配额不足：已用 ${usage.usedBytes} 字节，配额 ${this.config.quotaBytes} 字节`,
          413
        );
      }
    }

    const totalChunks = totalChunksInput === undefined || totalChunksInput === null
      ? null
      : integerValue(totalChunksInput, 'totalChunks', { min: 0, max: MAX_CHUNK_INDEX });
    if (totalChunks === 0 && expectedSize !== null && expectedSize !== 0) {
      invalid('totalChunks=0 只适用于空文件');
    }

    const ts = this.nowIso();
    const uploadId = newId('upl_');
    const upload = {
      uploadId,
      ownerId: principal.id,
      regionId,
      name,
      mimeType,
      fileId,
      baseRevision,
      expectedSize,
      chunkSize,
      totalChunks,
      status: 'open',
      initOperationId: operationId,
      createdAt: ts,
      completedAt: null,
      result: null
    };
    this.bucket('uploads')[uploadId] = upload;
    this.save();

    return {
      status: 201,
      body: {
        uploadId,
        fileId,
        baseRevision,
        chunkSize,
        regionId,
        totalChunks,
        operationId,
        upload: this.uploadView(upload)
      }
    };
  }

  uploadView(upload) {
    let receivedChunks = 0;
    let receivedBytes = 0;
    const chunks = this.bucket('chunks');
    for (const key of Object.keys(chunks)) {
      const chunk = chunks[key];
      if (!chunk || chunk.uploadId !== upload.uploadId) continue;
      receivedChunks += 1;
      receivedBytes += chunk.size;
    }
    return {
      uploadId: upload.uploadId,
      fileId: upload.fileId,
      regionId: upload.regionId,
      name: upload.name,
      mimeType: upload.mimeType,
      size: upload.expectedSize,
      chunkSize: upload.chunkSize,
      totalChunks: upload.totalChunks,
      baseRevision: upload.baseRevision,
      status: upload.status,
      receivedChunks,
      receivedBytes,
      createdAt: upload.createdAt,
      completedAt: upload.completedAt
    };
  }

  putChunk(ctx) {
    const principal = this.principal(ctx, { write: true });
    this.requireAdapter();
    const uploadId = ctx && ctx.params ? ctx.params.uploadId : undefined;
    const upload = this.uploadRecord(uploadId);
    if (!upload) fail('UPLOAD_NOT_FOUND', '上传任务不存在', 404);
    this.ensureRegion(upload.regionId);
    if (upload.ownerId !== principal.id) fail(codes.FORBIDDEN, '无权操作该上传任务', 403);
    if (upload.status !== 'open') fail('UPLOAD_COMPLETED', '上传任务已提交，不能继续上传分块', 409);

    const indexInput = ctx && ctx.params && ctx.params.index !== undefined
      ? ctx.params.index
      : pick(bodyOf(ctx), 'index', 'chunkIndex', 'chunk_index');
    const index = integerValue(indexInput, '分块序号', { min: 0, max: MAX_CHUNK_INDEX });
    if (upload.totalChunks !== null && index >= upload.totalChunks) {
      invalid(`分块序号超出 totalChunks=${upload.totalChunks}`);
    }

    const { buffer, declaredHash } = chunkPayload(ctx);
    if (buffer.length === 0) invalid('分块内容不能为空');
    if (buffer.length > this.config.maxChunkBytes) {
      fail('CHUNK_TOO_LARGE', `单个分块不得超过 ${this.config.maxChunkBytes} 字节`, 413);
    }
    const contentHash = `sha256:${sha256Hex(buffer)}`;
    if (declaredHash && declaredHash !== contentHash) {
      fail('CHUNK_HASH_MISMATCH', '分块 sha256 校验失败', 400);
    }

    const ts = this.nowIso();
    const key = `${upload.uploadId}:${index}`;
    // 同一序号重试是幂等的：覆盖旧分块，不产生第二份数据。
    this.bucket('chunks')[key] = {
      uploadId: upload.uploadId,
      index,
      size: buffer.length,
      contentHash,
      data: buffer.toString('base64'),
      receivedAt: ts
    };
    this.save();

    return {
      status: 200,
      body: {
        uploadId: upload.uploadId,
        index,
        size: buffer.length,
        contentHash,
        sha256: contentHash,
        receivedChunks: this.uploadView(upload).receivedChunks,
        receivedBytes: this.uploadView(upload).receivedBytes,
        totalChunks: upload.totalChunks
      }
    };
  }

  completeUpload(ctx) {
    const principal = this.principal(ctx, { write: true });
    this.requireAdapter();
    const uploadId = ctx && ctx.params ? ctx.params.uploadId : undefined;
    const upload = this.uploadRecord(uploadId);
    if (!upload) fail('UPLOAD_NOT_FOUND', '上传任务不存在', 404);
    this.ensureRegion(upload.regionId);
    if (upload.ownerId !== principal.id) fail(codes.FORBIDDEN, '无权提交该上传任务', 403);

    // 已完成的上传天然幂等：无论 operationId 是否重复，都不再产生第二份文件。
    if (upload.status === 'completed') {
      const existing = this.fileRecord(upload.result && upload.result.fileId);
      if (!existing) fail('STORAGE_UNAVAILABLE', '上传记录已完成，但文件索引缺失', 500);
      return {
        status: 200,
        body: {
          file: fileView(existing),
          idempotent: true,
          operationId: upload.operationId === undefined ? null : upload.operationId,
          fileId: existing.fileId,
          revision: existing.revision
        }
      };
    }

    const body = bodyOf(ctx);
    const operationId = validateOperationId(pick(body, 'operationId', 'operation_id', 'opId'));
    const baseRevisionInput = pick(body, 'baseRevision', 'base_revision');
    const totalChunksInput = pick(body, 'totalChunks', 'total_chunks');
    if (operationId) {
      const previous = this.operationRecord(operationId);
      if (previous) {
        if (previous.kind !== 'file-complete' || previous.uploadId !== upload.uploadId || previous.ownerId !== principal.id) {
          fail('OPERATION_CONFLICT', '该 operationId 已用于其他操作，不能复用', 409);
        }
        const existing = this.fileRecord(previous.fileId);
        if (!existing) fail('STORAGE_UNAVAILABLE', '幂等记录存在，但文件索引缺失', 500);
        return {
          status: 200,
          body: { file: fileView(existing), idempotent: true, operationId, fileId: existing.fileId, revision: existing.revision }
        };
      }
    }

    if (baseRevisionInput !== undefined && baseRevisionInput !== null) {
      const hinted = integerValue(baseRevisionInput, 'baseRevision', { min: 0 });
      if (hinted !== upload.baseRevision) {
        fail(
          'REVISION_CONFLICT',
          `baseRevision 不匹配：上传任务基于 ${upload.baseRevision}，提交携带 ${hinted}`,
          409
        );
      }
    }

    let target = null;
    if (upload.fileId) {
      target = this.fileRecord(upload.fileId);
      if (!target) fail('FILE_NOT_FOUND', '目标文件不存在，无法提交覆盖', 409);
      this.ensureRegion(target.regionId);
      if (target.ownerId !== principal.id) fail(codes.FORBIDDEN, '无权覆盖该文件', 403);
      if (target.regionId !== upload.regionId) fail('REGION_MISMATCH', '文件所属区域已变化', 409);
      if (target.status !== 'active') fail('FILE_DELETED', '目标文件已删除，请先恢复', 409);
      if (target.revision !== upload.baseRevision) {
        fail(
          'REVISION_CONFLICT',
          `基础修订不匹配：当前 ${target.revision}，上传任务基于 ${upload.baseRevision}`,
          409
        );
      }
    }

    let expectedTotal = upload.totalChunks;
    if (totalChunksInput !== undefined && totalChunksInput !== null) {
      const suppliedTotal = integerValue(totalChunksInput, 'totalChunks', { min: 0, max: MAX_CHUNK_INDEX });
      if (expectedTotal !== null && suppliedTotal !== expectedTotal) {
        fail('CHUNK_COUNT_MISMATCH', `totalChunks 不匹配：上传任务为 ${expectedTotal}，提交携带 ${suppliedTotal}`, 400);
      }
      expectedTotal = suppliedTotal;
    }

    const chunkBucket = this.bucket('chunks');
    const chunkList = [];
    for (const key of Object.keys(chunkBucket)) {
      const chunk = chunkBucket[key];
      if (chunk && chunk.uploadId === upload.uploadId) chunkList.push(chunk);
    }
    chunkList.sort((a, b) => a.index - b.index);

    if (expectedTotal === null) {
      if (chunkList.length === 0) {
        if (upload.expectedSize === 0) {
          expectedTotal = 0;
        } else {
          fail('MISSING_CHUNKS', '尚未上传任何分块', 400);
        }
      } else {
        expectedTotal = chunkList[chunkList.length - 1].index + 1;
      }
    }
    if (chunkList.length !== expectedTotal) {
      fail('MISSING_CHUNKS', `分块数量不完整：期望 ${expectedTotal}，收到 ${chunkList.length}`, 400);
    }
    for (let index = 0; index < expectedTotal; index += 1) {
      if (!chunkList[index] || chunkList[index].index !== index) {
        fail('MISSING_CHUNKS', `缺少分块 ${index}`, 400);
      }
    }

    const parts = [];
    for (const chunk of chunkList) {
      const buffer = Buffer.from(chunk.data, 'base64');
      if (buffer.length !== chunk.size || `sha256:${sha256Hex(buffer)}` !== chunk.contentHash) {
        fail('CONTENT_INTEGRITY_ERROR', '分块内容校验失败，已拒绝提交', 500);
      }
      parts.push(buffer);
    }
    const content = Buffer.concat(parts);

    if (upload.expectedSize !== null && content.length !== upload.expectedSize) {
      fail('SIZE_MISMATCH', `文件大小不匹配：声明 ${upload.expectedSize}，实际 ${content.length}`, 400);
    }
    const limit = this.effectiveFileLimit();
    if (content.length > limit) {
      if (content.length > this.config.quotaBytes) {
        fail('QUOTA_EXCEEDED', `文件超过用户配额 ${this.config.quotaBytes} 字节`, 413);
      }
      fail('FILE_TOO_LARGE', `单文件不得超过 ${limit} 字节`, 413);
    }
    const usage = this.usageFor(principal.id);
    const replacing = target ? target.size : 0;
    if (usage.usedBytes - replacing + content.length > this.config.quotaBytes) {
      fail(
        'QUOTA_EXCEEDED',
        `配额不足：已用 ${usage.usedBytes} 字节，本次 ${content.length} 字节，配额 ${this.config.quotaBytes} 字节`,
        413
      );
    }

    const ts = this.nowIso();
    const contentHash = `sha256:${sha256Hex(content)}`;
    let file;
    if (target) {
      file = {
        ...target,
        name: upload.name,
        mimeType: upload.mimeType,
        size: content.length,
        revision: target.revision + 1,
        status: 'active',
        contentHash,
        updatedAt: ts,
        deletedAt: null,
        restoredAt: null,
        lastOperationId: operationId
      };
    } else {
      const fileId = newId('fil_');
      file = {
        fileId,
        ownerId: principal.id,
        regionId: upload.regionId,
        name: upload.name,
        mimeType: upload.mimeType,
        size: content.length,
        revision: 1,
        status: 'active',
        contentHash,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        restoredAt: null,
        lastOperationId: operationId
      };
    }

    // 单次内存变更 + 一次原子替换写：文件索引、内容、上传状态与操作记录一起提交。
    this.bucket('blobs')[file.fileId] = {
      fileId: file.fileId,
      size: content.length,
      contentHash,
      data: content.toString('base64'),
      updatedAt: ts
    };
    this.bucket('files')[file.fileId] = file;
    upload.status = 'completed';
    upload.completedAt = ts;
    upload.totalChunks = expectedTotal;
    upload.result = { fileId: file.fileId, revision: file.revision, size: file.size, contentHash };
    upload.operationId = operationId;

    // 提交成功后分块不再保留，避免临时数据重复占用空间。
    for (const key of Object.keys(chunkBucket)) {
      const chunk = chunkBucket[key];
      if (chunk && chunk.uploadId === upload.uploadId) delete chunkBucket[key];
    }

    if (operationId) {
      this.bucket('operations')[operationKey(operationId)] = {
        operationId,
        kind: 'file-complete',
        ownerId: principal.id,
        regionId: file.regionId,
        fileId: file.fileId,
        uploadId: upload.uploadId,
        baseRevision: upload.baseRevision,
        revision: file.revision,
        status: 'committed',
        recordedAt: ts,
        result: { fileId: file.fileId, revision: file.revision, size: file.size, contentHash }
      };
    }
    this.save();

    return {
      status: 201,
      body: {
        file: fileView(file),
        idempotent: false,
        operationId,
        fileId: file.fileId,
        revision: file.revision,
        contentHash
      }
    };
  }

  getUpload(ctx) {
    const principal = this.principal(ctx, { write: false });
    this.requireAdapter();
    const uploadId = ctx && ctx.params ? ctx.params.uploadId : undefined;
    const upload = this.uploadRecord(uploadId);
    if (!upload) fail('UPLOAD_NOT_FOUND', '上传任务不存在', 404);
    this.ensureRegion(upload.regionId);
    if (upload.ownerId !== principal.id) fail(codes.FORBIDDEN, '无权查看该上传任务', 403);
    return { status: 200, body: { upload: this.uploadView(upload) } };
  }

  // -- 文件列表、元数据与内容 -------------------------------------------------

  listFiles(ctx) {
    const principal = this.principal(ctx, { write: false });
    this.requireAdapter();
    const regionFilter = queryValue(ctx, 'region');
    if (regionFilter !== undefined && regionFilter !== null && regionFilter !== '') {
      this.ensureRegion(regionFilter);
    }
    const includeDeleted = truthy(queryValue(ctx, 'includeDeleted')) || truthy(queryValue(ctx, 'include_deleted'));
    const files = [];
    const bucket = this.bucket('files');
    for (const key of Object.keys(bucket)) {
      const file = bucket[key];
      if (!file || file.ownerId !== principal.id) continue;
      if (!this.config.regions.includes(file.regionId)) continue;
      if (!includeDeleted && file.status !== 'active') continue;
      if (regionFilter && file.regionId !== regionFilter) continue;
      files.push(fileView(file));
    }
    files.sort((a, b) => {
      if (a.updatedAt === b.updatedAt) return a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0;
      return a.updatedAt < b.updatedAt ? 1 : -1;
    });
    return {
      status: 200,
      body: { files, regions: this.config.regions.slice(), quota: this.quotaView(principal.id) }
    };
  }

  getFile(ctx) {
    const principal = this.principal(ctx, { write: false });
    this.requireAdapter();
    const fileId = ctx && ctx.params ? ctx.params.fileId : undefined;
    const file = this.fileRecord(fileId);
    if (!file) fail('FILE_NOT_FOUND', '文件不存在', 404);
    this.ensureRegion(file.regionId);
    if (file.ownerId !== principal.id) fail(codes.FORBIDDEN, '无权访问该文件', 403);
    return { status: 200, body: { file: fileView(file) } };
  }

  getFileContent(ctx) {
    const principal = this.optionalPrincipal(ctx);
    const token = shareTokenFrom(ctx);
    if (!principal && !token) {
      fail('UNAUTHENTICATED', '未认证，且未提供分享令牌', 401);
    }
    this.requireAdapter();

    const fileId = ctx && ctx.params ? ctx.params.fileId : undefined;
    const file = this.fileRecord(fileId);
    if (!file) fail('FILE_NOT_FOUND', '文件不存在', 404);
    this.ensureRegion(file.regionId);

    let viaShare = false;
    if (principal && principal.id === file.ownerId) {
      viaShare = false;
    } else if (token) {
      this.requireShareToken(token, { expectedFileId: file.fileId });
      viaShare = true;
    } else {
      fail(codes.FORBIDDEN, '无权读取该文件', 403);
    }

    if (file.status !== 'active' && viaShare) {
      fail('FILE_DELETED', '文件已删除，分享不可用', 410);
    }
    return this.contentResponse(file, ctx);
  }

  contentResponse(file, ctx) {
    const blob = this.bucket('blobs')[file.fileId];
    if (!blob || typeof blob.data !== 'string') {
      fail('STORAGE_UNAVAILABLE', '文件内容缺失，拒绝返回伪造内容', 500);
    }
    const content = Buffer.from(blob.data, 'base64');
    if (content.length !== file.size) {
      fail('CONTENT_INTEGRITY_ERROR', '文件内容长度与索引不一致', 500);
    }

    const headers = {
      'content-type': file.mimeType || 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-disposition': `attachment; filename*=UTF-8''${encodeFilename(file.name)}`,
      etag: `"${file.contentHash}"`
    };

    let range = null;
    try {
      range = parseRange(headerValue(ctx, 'range'), content.length);
    } catch (err) {
      if (err instanceof CoreError) {
        return {
          status: 416,
          headers: { 'content-range': `bytes */${content.length}`, 'accept-ranges': 'bytes' },
          body: { code: err.code, message: err.message }
        };
      }
      throw err;
    }

    if (ctx && ctx.transport && ctx.transport.kind === 'download') {
      // 正式宿主负责 Range/HEAD；这里返回完整流，避免二次切片。
      return {
        stream: Readable.from(content),
        size: content.length,
        contentType: file.mimeType || 'application/octet-stream',
        etag: `"${file.contentHash}"`,
        contentDisposition: `attachment; filename*=UTF-8''${encodeFilename(file.name)}`
      };
    }

    if (!range) {
      headers['content-length'] = String(content.length);
      return { status: 200, headers, body: content };
    }

    const slice = content.subarray(range.start, range.end + 1);
    headers['content-length'] = String(slice.length);
    headers['content-range'] = `bytes ${range.start}-${range.end}/${content.length}`;
    return { status: 206, headers, body: slice };
  }

  // -- 软删与恢复 ------------------------------------------------------------

  deleteFile(ctx) {
    const principal = this.principal(ctx, { write: true });
    this.requireAdapter();
    const body = bodyOf(ctx);
    const fileId = ctx && ctx.params ? ctx.params.fileId : undefined;
    const file = this.fileRecord(fileId);
    if (!file) fail('FILE_NOT_FOUND', '文件不存在', 404);
    this.ensureRegion(file.regionId);
    if (file.ownerId !== principal.id) fail(codes.FORBIDDEN, '无权删除该文件', 403);

    const operationId = validateOperationId(pick(body, 'operationId', 'operation_id', 'opId'));
    const baseRevisionInput = pick(body, 'baseRevision', 'base_revision');
    if (operationId) {
      const previous = this.operationRecord(operationId);
      if (previous) {
        if (previous.kind !== 'file-delete' || previous.fileId !== file.fileId || previous.ownerId !== principal.id) {
          fail('OPERATION_CONFLICT', '该 operationId 已用于其他操作，不能复用', 409);
        }
        if (file.status !== 'deleted') {
          fail('OPERATION_CONFLICT', '该 operationId 已用于删除，文件已被恢复', 409);
        }
        return {
          status: 200,
          body: { file: fileView(file), idempotent: true, operationId }
        };
      }
    }

    if (file.status === 'deleted') fail('FILE_ALREADY_DELETED', '文件已处于删除状态', 409);
    if (baseRevisionInput !== undefined && baseRevisionInput !== null) {
      const baseRevision = integerValue(baseRevisionInput, 'baseRevision', { min: 0 });
      if (baseRevision !== file.revision) {
        fail('REVISION_CONFLICT', `基础修订不匹配：当前 ${file.revision}，收到 ${baseRevision}`, 409);
      }
    }

    const ts = this.nowIso();
    const previousRevision = file.revision;
    const updated = {
      ...file,
      status: 'deleted',
      revision: file.revision + 1,
      updatedAt: ts,
      deletedAt: ts,
      restoredAt: null
    };
    this.bucket('files')[file.fileId] = updated;
    if (operationId) {
      this.bucket('operations')[operationKey(operationId)] = {
        operationId,
        kind: 'file-delete',
        ownerId: principal.id,
        regionId: file.regionId,
        fileId: file.fileId,
        baseRevision: previousRevision,
        revision: updated.revision,
        status: 'committed',
        recordedAt: ts,
        result: { fileId: file.fileId, revision: updated.revision, status: 'deleted' }
      };
    }
    this.save();
    return {
      status: 200,
      body: {
        file: fileView(updated),
        idempotent: false,
        operationId,
        fileId: updated.fileId,
        revision: updated.revision,
        status: updated.status
      }
    };
  }

  restoreFile(ctx) {
    const principal = this.principal(ctx, { write: true });
    this.requireAdapter();
    const body = bodyOf(ctx);
    const fileId = ctx && ctx.params ? ctx.params.fileId : undefined;
    const file = this.fileRecord(fileId);
    if (!file) fail('FILE_NOT_FOUND', '文件不存在', 404);
    this.ensureRegion(file.regionId);
    if (file.ownerId !== principal.id) fail(codes.FORBIDDEN, '无权恢复该文件', 403);

    const operationId = validateOperationId(pick(body, 'operationId', 'operation_id', 'opId'));
    const baseRevisionInput = pick(body, 'baseRevision', 'base_revision');
    if (operationId) {
      const previous = this.operationRecord(operationId);
      if (previous) {
        if (previous.kind !== 'file-restore' || previous.fileId !== file.fileId || previous.ownerId !== principal.id) {
          fail('OPERATION_CONFLICT', '该 operationId 已用于其他操作，不能复用', 409);
        }
        if (file.status !== 'active') {
          fail('OPERATION_CONFLICT', '该 operationId 已用于恢复，文件已再次删除', 409);
        }
        return {
          status: 200,
          body: { file: fileView(file), idempotent: true, operationId }
        };
      }
    }

    if (file.status !== 'deleted') fail('FILE_NOT_DELETED', '文件未处于删除状态，无需恢复', 409);
    if (baseRevisionInput !== undefined && baseRevisionInput !== null) {
      const baseRevision = integerValue(baseRevisionInput, 'baseRevision', { min: 0 });
      if (baseRevision !== file.revision) {
        fail('REVISION_CONFLICT', `基础修订不匹配：当前 ${file.revision}，收到 ${baseRevision}`, 409);
      }
    }

    const ts = this.nowIso();
    const previousRevision = file.revision;
    const updated = {
      ...file,
      status: 'active',
      revision: file.revision + 1,
      updatedAt: ts,
      deletedAt: null,
      restoredAt: ts
    };
    this.bucket('files')[file.fileId] = updated;
    if (operationId) {
      this.bucket('operations')[operationKey(operationId)] = {
        operationId,
        kind: 'file-restore',
        ownerId: principal.id,
        regionId: file.regionId,
        fileId: file.fileId,
        baseRevision: previousRevision,
        revision: updated.revision,
        status: 'committed',
        recordedAt: ts,
        result: { fileId: file.fileId, revision: updated.revision, status: 'active' }
      };
    }
    this.save();
    return {
      status: 200,
      body: {
        file: fileView(updated),
        idempotent: false,
        operationId,
        fileId: updated.fileId,
        revision: updated.revision,
        status: updated.status
      }
    };
  }

  // -- 只读分享 --------------------------------------------------------------

  createShare(ctx) {
    const principal = this.principal(ctx, { write: true });
    this.requireAdapter();
    const body = bodyOf(ctx);
    const fileId = ctx && ctx.params ? ctx.params.fileId : undefined;
    const file = this.fileRecord(fileId);
    if (!file) fail('FILE_NOT_FOUND', '文件不存在', 404);
    this.ensureRegion(file.regionId);
    if (file.ownerId !== principal.id) fail(codes.FORBIDDEN, '无权分享该文件', 403);
    if (file.status !== 'active') fail('FILE_DELETED', '已删除文件不能创建分享', 409);

    const expiresInInput = pick(body, 'expiresInSeconds', 'expires_in_seconds', 'ttlSeconds', 'expiresIn', 'ttl');
    const expiresAtInput = pick(body, 'expiresAt', 'expires_at');
    const hasExpiresIn = expiresInInput !== undefined && expiresInInput !== null;
    const hasExpiresAt = expiresAtInput !== undefined && expiresAtInput !== null;
    if (hasExpiresIn && hasExpiresAt) {
      invalid('expiresInSeconds 与 expiresAt 只能提供一个');
    }
    const now = this.nowMs();
    let expiresMs;
    if (expiresAtInput !== undefined && expiresAtInput !== null) {
      if (typeof expiresAtInput !== 'string' || !Number.isFinite(Date.parse(expiresAtInput))) {
        invalid('expiresAt 必须是 RFC 3339 时间字符串');
      }
      expiresMs = Date.parse(expiresAtInput);
    } else {
      const seconds = expiresInInput === undefined || expiresInInput === null
        ? this.config.shareDefaultTtlSeconds
        : integerValue(expiresInInput, 'expiresInSeconds', { min: 1, max: this.config.shareMaxTtlSeconds });
      expiresMs = now + seconds * 1000;
    }
    if (expiresMs <= now) invalid('分享过期时间必须晚于当前时间');
    if (expiresMs > now + this.config.shareMaxTtlSeconds * 1000) {
      invalid(`分享有效期不能超过 ${this.config.shareMaxTtlSeconds} 秒`);
    }

    let token = crypto.randomBytes(32).toString('base64url');
    let tokenHash = sha256Hex(Buffer.from(token, 'utf8'));
    let attempts = 0;
    while (hasOwn(this.bucket('shareTokens'), tokenHash) && attempts < 3) {
      token = crypto.randomBytes(32).toString('base64url');
      tokenHash = sha256Hex(Buffer.from(token, 'utf8'));
      attempts += 1;
    }
    const shareId = newId('shr_');
    const ts = this.nowIso();
    const share = {
      shareId,
      fileId: file.fileId,
      ownerId: principal.id,
      tokenHash,
      readOnly: true,
      createdAt: ts,
      expiresAt: new Date(expiresMs).toISOString(),
      revokedAt: null
    };
    this.bucket('shares')[shareId] = share;
    this.bucket('shareTokens')[tokenHash] = shareId;
    this.save();

    return {
      status: 201,
      body: {
        share: {
          ...shareView(share),
          token,
          urlPath: `${ROUTE_PREFIX}/shares/${token}/content`
        },
        // 兼容客户端常见的顶层读取方式；明文 token 只在此响应出现一次。
        shareId: share.shareId,
        fileId: share.fileId,
        token,
        expiresAt: share.expiresAt,
        readOnly: true,
        urlPath: `${ROUTE_PREFIX}/shares/${token}/content`,
        file: publicFileView(file)
      }
    };
  }

  requireShareToken(token, options = {}) {
    if (typeof token !== 'string' || !token.trim()) {
      fail('SHARE_NOT_FOUND', '分享令牌不存在', 404);
    }
    const tokenHash = sha256Hex(Buffer.from(token.trim(), 'utf8'));
    const shareId = this.bucket('shareTokens')[tokenHash];
    const share = shareId ? this.shareRecord(shareId) : null;
    if (!share) fail('SHARE_NOT_FOUND', '分享令牌不存在', 404);
    if (share.revokedAt) fail('SHARE_REVOKED', '分享令牌已撤销', 410);
    if (Date.parse(share.expiresAt) <= this.nowMs()) fail('SHARE_EXPIRED', '分享令牌已过期', 410);
    if (share.readOnly !== true) fail('SHARE_INVALID', '分享令牌权限非法', 500);
    if (options.expectedFileId && share.fileId !== options.expectedFileId) {
      fail('SHARE_NOT_FOUND', '分享令牌与文件不匹配', 404);
    }
    return share;
  }

  getShare(ctx) {
    const token = ctx && ctx.params ? ctx.params.token : undefined;
    if (!token) fail('SHARE_NOT_FOUND', '分享令牌不存在', 404);
    this.requireAdapter();
    const share = this.requireShareToken(token);
    const file = this.fileRecord(share.fileId);
    if (!file) fail('FILE_NOT_FOUND', '分享对应的文件不存在', 404);
    this.ensureRegion(file.regionId);
    if (file.status !== 'active') fail('FILE_DELETED', '文件已删除，分享不可用', 410);
    return {
      status: 200,
      body: {
        share: shareView(share),
        file: publicFileView(file),
        shareId: share.shareId,
        fileId: share.fileId,
        expiresAt: share.expiresAt,
        readOnly: true
      }
    };
  }

  getShareContent(ctx) {
    const token = ctx && ctx.params ? ctx.params.token : undefined;
    if (!token) fail('SHARE_NOT_FOUND', '分享令牌不存在', 404);
    this.requireAdapter();
    const share = this.requireShareToken(token);
    const file = this.fileRecord(share.fileId);
    if (!file) fail('FILE_NOT_FOUND', '分享对应的文件不存在', 404);
    this.ensureRegion(file.regionId);
    if (file.status !== 'active') fail('FILE_DELETED', '文件已删除，分享不可用', 410);
    return this.contentResponse(file, ctx);
  }

  listShares(ctx) {
    const principal = this.principal(ctx, { write: false });
    this.requireAdapter();
    const fileId = ctx && ctx.params ? ctx.params.fileId : undefined;
    const file = this.fileRecord(fileId);
    if (!file) fail('FILE_NOT_FOUND', '文件不存在', 404);
    this.ensureRegion(file.regionId);
    if (file.ownerId !== principal.id) fail(codes.FORBIDDEN, '无权查看该文件的分享', 403);
    const shares = [];
    const bucket = this.bucket('shares');
    for (const key of Object.keys(bucket)) {
      const share = bucket[key];
      if (share && share.fileId === file.fileId && share.ownerId === file.ownerId) {
        shares.push(shareView(share));
      }
    }
    shares.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { status: 200, body: { shares } };
  }

  revokeShare(ctx) {
    const principal = this.principal(ctx, { write: true });
    this.requireAdapter();
    const shareId = ctx && ctx.params ? ctx.params.shareId : undefined;
    const share = this.shareRecord(shareId);
    if (!share) fail('SHARE_NOT_FOUND', '分享不存在', 404);
    if (share.ownerId !== principal.id) fail(codes.FORBIDDEN, '无权撤销该分享', 403);
    if (share.revokedAt) {
      return { status: 200, body: { share: shareView(share), idempotent: true } };
    }
    share.revokedAt = this.nowIso();
    this.save();
    return { status: 200, body: { share: shareView(share), idempotent: false } };
  }

  // -- 配额与健康 ------------------------------------------------------------

  getQuota(ctx) {
    const principal = this.principal(ctx, { write: false });
    this.requireAdapter();
    return {
      status: 200,
      body: {
        ...this.quotaView(principal.id),
        regions: this.config.regions.slice()
      }
    };
  }

  healthRoute() {
    return {
      status: 200,
      body: {
        ok: true,
        module: MODULE_ID,
        regions: this.config.regions.slice(),
        storage: this.config.dataFile ? 'json-file' : 'memory',
        adapterReady: this.config.storageAdapter === 'json'
      }
    };
  }
}

/** 从请求中取分享令牌：query.token / x-share-token / Authorization: Share <token>。 */
function shareTokenFrom(ctx) {
  const fromQuery = queryValue(ctx, 'token') || queryValue(ctx, 'share');
  if (typeof fromQuery === 'string' && fromQuery.trim()) return fromQuery.trim();
  const fromHeader = headerValue(ctx, 'x-share-token');
  if (typeof fromHeader === 'string' && fromHeader.trim()) return fromHeader.trim();
  const authorization = headerValue(ctx, 'authorization');
  if (typeof authorization === 'string' && /^share\s+/i.test(authorization.trim())) {
    return authorization.trim().replace(/^share\s+/i, '').trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// 统一模块接口
// ---------------------------------------------------------------------------

function requireService() {
  if (!active || !active.legacy) {
    throw new CoreError(codes.MODULE_NOT_READY, 'Disk 模块尚未启动', { status: 503 });
  }
  return active.legacy;
}

function wrap(fn, platformMethod = null) {
  return async function handler(ctx = {}) {
    try {
      const current = requireActive();
      if (current.platform) {
        if (!platformMethod) return { status: 404, body: { code: 'NOT_FOUND', message: '接口不存在' } };
        return await current.platform.handle(platformMethod, ctx);
      }
      if (!current.platform && platformMethod && typeof fn !== 'function') {
        return { status: 404, body: { code: 'NOT_FOUND', message: '接口不存在' } };
      }
      return await fn(requireService(), ctx);
    } catch (err) {
      if (err instanceof CoreError) {
        return { status: err.status, body: { code: err.code, message: err.message } };
      }
      const logger = active && active.logger ? active.logger : loggerOf(null);
      logger.error('[disk] 处理请求失败', err);
      return { status: 500, body: { code: 'INTERNAL_ERROR', message: '内部错误' } };
    }
  };
}

function requireActive() {
  if (!active) {
    throw new CoreError(codes.MODULE_NOT_READY, 'Disk 模块尚未启动', { status: 503 });
  }
  return active;
}

const routes = Object.freeze([
  { method: 'GET', path: `${ROUTE_PREFIX}/info`, handler: wrap(null, 'info') },
  { method: 'GET', path: `${ROUTE_PREFIX}/regions`, handler: wrap(null, 'listRegions') },
  { method: 'GET', path: `${ROUTE_PREFIX}/health`, handler: wrap((service) => service.healthRoute(), 'health') },
  { method: 'GET', path: `${ROUTE_PREFIX}/quota`, handler: wrap((service, ctx) => service.getQuota(ctx), 'getQuota') },

  { method: 'GET', path: `${ROUTE_PREFIX}/files`, handler: wrap((service, ctx) => service.listFiles(ctx), 'listFiles') },
  { method: 'POST', path: `${ROUTE_PREFIX}/uploads/init`, handler: wrap((service, ctx) => service.initUpload(ctx), 'initUpload') },
  {
    method: 'PUT',
    path: `${ROUTE_PREFIX}/uploads/:uploadId/chunks/:index`,
    transport: { kind: 'json', maxBytes: 96 * 1024 * 1024 },
    handler: wrap((service, ctx) => service.putChunk(ctx), 'putChunk')
  },
  {
    method: 'POST',
    path: `${ROUTE_PREFIX}/uploads/:uploadId/chunks/:index`,
    transport: { kind: 'json', maxBytes: 96 * 1024 * 1024 },
    handler: wrap((service, ctx) => service.putChunk(ctx), 'putChunk')
  },
  {
    method: 'PUT',
    path: `${ROUTE_PREFIX}/uploads/:uploadId/chunks/:index/data`,
    transport: { kind: 'upload', maxBytes: 64 * 1024 * 1024 + 1, cancellation: 'propagate' },
    handler: wrap((service, ctx) => service.putChunk(ctx), 'putChunk')
  },
  {
    method: 'POST',
    path: `${ROUTE_PREFIX}/uploads/:uploadId/chunks/:index/data`,
    transport: { kind: 'upload', maxBytes: 64 * 1024 * 1024 + 1, cancellation: 'propagate' },
    handler: wrap((service, ctx) => service.putChunk(ctx), 'putChunk')
  },
  {
    method: 'PUT',
    path: `${ROUTE_PREFIX}/uploads/:uploadId/chunks`,
    transport: { kind: 'json', maxBytes: 96 * 1024 * 1024 },
    handler: wrap((service, ctx) => service.putChunk(ctx), 'putChunk')
  },
  {
    method: 'POST',
    path: `${ROUTE_PREFIX}/uploads/:uploadId/chunks`,
    transport: { kind: 'json', maxBytes: 96 * 1024 * 1024 },
    handler: wrap((service, ctx) => service.putChunk(ctx), 'putChunk')
  },
  {
    method: 'POST',
    path: `${ROUTE_PREFIX}/uploads/:uploadId/complete`,
    handler: wrap((service, ctx) => service.completeUpload(ctx), 'completeUpload')
  },
  {
    method: 'GET',
    path: `${ROUTE_PREFIX}/uploads/:uploadId`,
    handler: wrap((service, ctx) => service.getUpload(ctx), 'getUpload')
  },
  {
    method: 'DELETE',
    path: `${ROUTE_PREFIX}/uploads/:uploadId`,
    handler: wrap((service) => { throw new CoreError(codes.NOT_FOUND, '旧数据面不支持取消上传', { status: 404 }); }, 'abortUpload')
  },

  { method: 'GET', path: `${ROUTE_PREFIX}/files/:fileId`, handler: wrap((service, ctx) => service.getFile(ctx), 'getFile') },
  {
    method: 'GET',
    path: `${ROUTE_PREFIX}/files/:fileId/content`,
    transport: { kind: 'download' },
    handler: wrap((service, ctx) => service.getFileContent(ctx), 'getFileContent')
  },
  {
    method: 'GET',
    path: `${ROUTE_PREFIX}/files/:fileId/download`,
    transport: { kind: 'download' },
    handler: wrap((service, ctx) => service.getFileContent(ctx), 'getFileContent')
  },
  {
    method: 'DELETE',
    path: `${ROUTE_PREFIX}/files/:fileId`,
    handler: wrap((service, ctx) => service.deleteFile(ctx), 'deleteFile')
  },
  {
    method: 'POST',
    path: `${ROUTE_PREFIX}/files/:fileId/delete`,
    handler: wrap((service, ctx) => service.deleteFile(ctx), 'deleteFile')
  },
  {
    method: 'POST',
    path: `${ROUTE_PREFIX}/files/:fileId/restore`,
    handler: wrap((service, ctx) => service.restoreFile(ctx), 'restoreFile')
  },
  {
    method: 'PATCH',
    path: `${ROUTE_PREFIX}/files/:fileId`,
    handler: wrap(null, 'patchFile')
  },

  { method: 'GET', path: `${ROUTE_PREFIX}/folders`, handler: wrap(null, 'listFolders') },
  { method: 'POST', path: `${ROUTE_PREFIX}/folders`, handler: wrap(null, 'createFolder') },
  {
    method: 'PATCH',
    path: `${ROUTE_PREFIX}/folders/:folderId`,
    handler: wrap(null, 'patchFolder')
  },
  {
    method: 'DELETE',
    path: `${ROUTE_PREFIX}/folders/:folderId`,
    handler: wrap(null, 'deleteFolder')
  },
  {
    method: 'POST',
    path: `${ROUTE_PREFIX}/folders/:folderId/restore`,
    handler: wrap(null, 'restoreFolder')
  },

  { method: 'GET', path: `${ROUTE_PREFIX}/sync/state`, handler: wrap(null, 'getSyncState') },
  { method: 'GET', path: `${ROUTE_PREFIX}/sync/changes`, handler: wrap(null, 'getSyncChanges') },
  { method: 'GET', path: `${ROUTE_PREFIX}/sync/tree`, handler: wrap(null, 'getSyncTree') },

  {
    method: 'POST',
    path: `${ROUTE_PREFIX}/devices/pairing-codes`,
    handler: wrap(null, 'createPairingCode')
  },
  { method: 'POST', path: `${ROUTE_PREFIX}/devices/pair`, handler: wrap(null, 'pairDevice') },
  { method: 'GET', path: `${ROUTE_PREFIX}/devices`, handler: wrap(null, 'listDevices') },
  {
    method: 'DELETE',
    path: `${ROUTE_PREFIX}/devices/:deviceId`,
    handler: wrap(null, 'revokeDevice')
  },

  {
    method: 'POST',
    path: `${ROUTE_PREFIX}/files/:fileId/shares`,
    handler: wrap((service, ctx) => service.createShare(ctx), 'createShare')
  },
  {
    method: 'POST',
    path: `${ROUTE_PREFIX}/files/:fileId/share`,
    handler: wrap((service, ctx) => service.createShare(ctx), 'createShare')
  },
  {
    method: 'GET',
    path: `${ROUTE_PREFIX}/files/:fileId/shares`,
    handler: wrap((service, ctx) => service.listShares(ctx), 'listShares')
  },
  { method: 'GET', path: `${ROUTE_PREFIX}/shares/:token`, handler: wrap((service, ctx) => service.getShare(ctx), 'getShare') },
  {
    method: 'GET',
    path: `${ROUTE_PREFIX}/shares/:token/content`,
    transport: { kind: 'download' },
    handler: wrap((service, ctx) => service.getShareContent(ctx), 'getShareContent')
  },
  {
    method: 'DELETE',
    path: `${ROUTE_PREFIX}/shares/:shareId`,
    handler: wrap((service, ctx) => service.revokeShare(ctx), 'revokeShare')
  }
]);

async function start(options = {}) {
  const logger = loggerOf(options && options.logger);
  const clock = options && typeof options.clock === 'function' ? options.clock : null;
  // 先摘掉旧实例：新配置启动失败时不得让上一次的路由继续可调用。
  active = null;
  if (options && options.runtime && options.runtime.db && typeof options.fileAdapter === 'function') {
    const { DiskPlatform } = require('./platform.js');
    const platform = new DiskPlatform({ ...options, logger });
    const result = await platform.start();
    active = { platform, logger };
    logger.info(`[disk] started (storage=mongodb+content-store, region=${REGION_FILES})`);
    return result;
  }
  const next = new DiskService(options ? options.config : undefined, logger, clock);
  active = { legacy: next, logger };
  logger.info(
    `[disk] started (${next.config.dataFile ? `dataFile=${next.config.dataFile}` : 'memory-only'}, `
    + `regions=${next.config.regions.join(',')}, adapter=${next.config.storageAdapter})`
  );
}

async function stop() {
  if (active) {
    if (active.platform) await active.platform.stop();
    active.logger.info('[disk] stopped');
    active = null;
  }
}

async function health() {
  // 生命周期宿主仅在 start 成功后探测；这里保持最小稳定形状。
  return active ? { ok: true } : { ok: false, reason: 'not-started' };
}

module.exports = {
  start,
  stop,
  health,
  routes,
  tools: {}
};
