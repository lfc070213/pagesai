'use strict';
// C07 真实文件系统 ContentStore。
// 上传块、装配临时文件与已提交版本都是二进制文件；JSON/Mongo 仅保存偏移、哈希和引用。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { CoreError, codes } = require('../errors');

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const HEX_SHA256 = /^[0-9a-f]{64}$/;

function invalid(message) { return new CoreError(codes.INVALID_INPUT, message, { status: 400 }); }
function conflict(message, details = null) { return new CoreError(codes.CONFLICT, message, { status: 409, details }); }
function uploadState(message, status = 409) { return new CoreError(codes.UPLOAD_STATE, message, { status }); }
function safeId(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw invalid(`${name} 格式非法`);
  return value;
}
function segment(value) { return encodeURIComponent(String(value || '_global')); }
function now(clock) { return new Date(clock()).toISOString(); }

function normalizeSha(value, size) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).replace(/^sha256:/, '').toLowerCase();
  if (!HEX_SHA256.test(normalized)) throw invalid('sha256 必须是 64 位小写十六进制');
  if (size === 0 && normalized !== EMPTY_SHA256) throw invalid('零字节文件 SHA-256 不匹配');
  return normalized;
}

function mapFsError(error) {
  if (error instanceof CoreError) return error;
  if (error && error.code === 'ENOSPC') {
    return new CoreError(codes.DISK_FULL, '文件系统空间不足', { status: 507, details: { retryable: true } });
  }
  if (error && error.name === 'AbortError') return new CoreError(codes.UPLOAD_CANCELLED, '上传已取消', { status: 400 });
  return error;
}

async function unlinkQuiet(file) {
  try { await fs.promises.unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function fileHash(file, { signal } = {}) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(file, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) });
  for await (const chunk of stream) {
    if (signal && signal.aborted) throw signal.reason || new Error('aborted');
    hash.update(chunk);
  }
  return hash.digest('hex');
}

class FileContentStore {
  constructor({ metadata, clock = () => Date.now(), maxChunkBytes = 1024 * 1024 * 1024 } = {}) {
    if (!metadata) throw new CoreError(codes.CONFIG_INVALID, 'FileContentStore 需要异步元数据适配器', { status: 500 });
    this.metadata = metadata;
    this.clock = clock;
    this.maxChunkBytes = maxChunkBytes;
  }

  async root(regionId) {
    const region = await this.metadata.getRegion(regionId);
    if (!region) throw new CoreError(codes.REGION_UNKNOWN, `区域 ${regionId} 未登记`, { status: 404 });
    if (!path.isAbsolute(region.rootAbs)) throw new CoreError(codes.CONFIG_INVALID, '区域物理根必须是绝对路径', { status: 500 });
    await fs.promises.mkdir(region.rootAbs, { recursive: true, mode: 0o750 });
    const stat = await fs.promises.lstat(region.rootAbs);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoreError(codes.PATH_ESCAPE, '区域物理根不能是符号链接或普通文件', { status: 400 });
    return fs.promises.realpath(region.rootAbs);
  }

  inside(rootAbs, relative) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\0')) {
      throw new CoreError(codes.PATH_ESCAPE, '内容引用不是安全的相对路径', { status: 500 });
    }
    const absolute = path.resolve(rootAbs, relative);
    const rel = path.relative(rootAbs, absolute);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new CoreError(codes.PATH_ESCAPE, '内容引用越出物理根', { status: 500 });
    }
    return absolute;
  }

  async uploadPaths(regionId, uploadId) {
    safeId(uploadId, 'uploadId');
    const rootAbs = await this.root(regionId);
    const relative = path.join('.pagesai-uploads', uploadId);
    const absolute = this.inside(rootAbs, relative);
    await fs.promises.mkdir(absolute, { recursive: true, mode: 0o700 });
    const stat = await fs.promises.lstat(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoreError(codes.PATH_ESCAPE, '上传目录不能是符号链接', { status: 400 });
    return { rootAbs, relative, absolute };
  }

  contentRelative(upload, revision) {
    return path.join(
      segment(upload.ownerId), '.pagesai-content', segment(upload.fileId),
      `r${revision}-${upload.sha256}`
    );
  }

  async beginUpload(input) {
    const { regionId, fileId, operationId, size, actor } = input || {};
    safeId(fileId, 'fileId');
    safeId(operationId, 'operationId');
    if (typeof regionId !== 'string' || !regionId) throw invalid('regionId 不能为空');
    if (!Number.isSafeInteger(size) || size < 0) throw invalid('size 必须是非负安全整数');
    if (!actor || typeof actor !== 'object') throw invalid('actor 不能为空');
    const sha256 = normalizeSha(input.sha256, size) || (size === 0 ? EMPTY_SHA256 : null);
    if (size > 0 && !sha256) throw invalid('非空上传必须预先声明 sha256');
    const uploadId = safeId(input.uploadId || crypto.randomUUID(), 'uploadId');
    const upload = await this.metadata.beginUpload({
      ...input, uploadId, operationId, regionId, fileId, size, sha256,
      ownerId: input.ownerId || actor.userId || null
    });
    await this.uploadPaths(regionId, upload.uploadId);
    return upload;
  }

  async requireUpload(uploadId) {
    const upload = await this.metadata.getUpload(uploadId);
    if (!upload) throw uploadState('上传不存在', 404);
    return upload;
  }

  async fail(upload, error, { cancelled = false } = {}) {
    const mapped = mapFsError(error);
    try {
      await this.metadata.failUpload(upload.uploadId, {
        status: cancelled ? 'cancelled' : 'failed',
        code: mapped.code || 'UPLOAD_FAILED',
        message: mapped instanceof CoreError ? mapped.message : '文件系统写入失败'
      });
    } catch (stateFailure) {
      if (stateFailure.code !== codes.UPLOAD_STATE) throw stateFailure;
    }
    return mapped;
  }

  async writeChunk(uploadId, offset, readable, { signal } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw invalid('分块 offset 非法');
    if (!readable || typeof readable[Symbol.asyncIterator] !== 'function') throw invalid('分块必须是可读流');
    const upload = await this.requireUpload(uploadId);
    if (upload.status !== 'uploading') throw uploadState(`上传状态 ${upload.status} 不接受分块`);
    if (offset !== upload.nextOffset) throw conflict('分块偏移不匹配', { expectedOffset: upload.nextOffset, receivedOffset: offset });
    const paths = await this.uploadPaths(upload.regionId, uploadId);
    const finalPart = path.join(paths.absolute, `${offset}.part`);
    const temporary = path.join(paths.absolute, `.part-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    let handle = null;
    let renamed = false;
    try {
      handle = await fs.promises.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      for await (const chunk of readable) {
        if (signal && signal.aborted) throw signal.reason || new CoreError(codes.UPLOAD_CANCELLED, '上传已取消', { status: 400 });
        if (!Buffer.isBuffer(chunk)) throw invalid('上传流必须产生 Buffer');
        size += chunk.length;
        if (size > this.maxChunkBytes || offset + size > upload.size) throw invalid('分块超过声明上限或文件总大小');
        hash.update(chunk);
        await handle.write(chunk);
      }
      if (size === 0) throw invalid('非空文件不能写入零长度分块');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.promises.rename(temporary, finalPart);
      renamed = true;
      const recorded = await this.metadata.recordChunk(uploadId, { offset, size, sha256: hash.digest('hex') });
      return { uploadId, offset, size, nextOffset: recorded.nextOffset, status: recorded.status };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (!renamed) await unlinkQuiet(temporary).catch(() => {});
      const cancelled = Boolean((signal && signal.aborted) || (error && error.code === codes.UPLOAD_CANCELLED));
      throw await this.fail(upload, error, { cancelled });
    }
  }

  partPath(paths, offset) { return path.join(paths.absolute, `${offset}.part`); }

  async assemble(upload, { signal } = {}) {
    const paths = await this.uploadPaths(upload.regionId, upload.uploadId);
    const ready = path.join(paths.absolute, 'ready');
    try {
      const readyStat = await fs.promises.stat(ready);
      if (readyStat.size === upload.size && (!upload.sha256 || await fileHash(ready, { signal }) === upload.sha256)) return { paths, ready };
    } catch (error) { if (error.code !== 'ENOENT') { /* 重新装配损坏的 ready */ } }
    const assembly = path.join(paths.absolute, `.assembly-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    const hash = crypto.createHash('sha256');
    let total = 0;
    let output = null;
    try {
      output = await fs.promises.open(assembly, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      for (const chunk of upload.chunks) {
        const chunkHash = crypto.createHash('sha256');
        const input = fs.createReadStream(this.partPath(paths, chunk.offset), { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) });
        let readBytes = 0;
        for await (const buffer of input) {
          if (signal && signal.aborted) throw signal.reason || new CoreError(codes.UPLOAD_CANCELLED, '提交已取消', { status: 400 });
          readBytes += buffer.length;
          total += buffer.length;
          if (readBytes > chunk.size || total > upload.size) throw new CoreError(codes.HASH_MISMATCH, '分块实际长度与检查点不符', { status: 409 });
          chunkHash.update(buffer);
          hash.update(buffer);
          await output.write(buffer);
        }
        if (readBytes !== chunk.size || chunkHash.digest('hex') !== chunk.sha256) {
          throw new CoreError(codes.HASH_MISMATCH, '分块 SHA-256 与检查点不符', { status: 409 });
        }
      }
      if (total !== upload.size || hash.digest('hex') !== upload.sha256) {
        throw new CoreError(codes.HASH_MISMATCH, '完整内容大小或 SHA-256 与声明不符', { status: 409 });
      }
      await output.sync();
      await output.close();
      output = null;
      await fs.promises.rename(assembly, ready);
      return { paths, ready };
    } catch (error) {
      if (output) await output.close().catch(() => {});
      await unlinkQuiet(assembly).catch(() => {});
      throw error;
    }
  }

  async commitUpload({ uploadId, baseRevision = null, metadata = {}, path: logicalPath = null, signal } = {}) {
    let upload = await this.requireUpload(uploadId);
    if (upload.status === 'committed') return { ...upload.result, idempotent: true };
    if (upload.status === 'failed' || upload.status === 'cancelled') {
      throw uploadState(`上传已${upload.status === 'cancelled' ? '取消' : '失败'}：${upload.error ? upload.error.code : upload.status}`);
    }
    if (baseRevision !== null && (!Number.isSafeInteger(baseRevision) || baseRevision < 0)) throw invalid('baseRevision 非法');
    try {
      if (upload.status === 'uploading') {
        if (upload.nextOffset !== upload.size) throw uploadState('上传分块不完整');
        await this.assemble(upload, { signal });
        upload = await this.metadata.markCommitting(uploadId, { baseRevision, metadata, path: logicalPath || upload.path });
      }
      if (upload.status !== 'committing') throw uploadState(`上传状态 ${upload.status} 不能提交`);
      const { paths, ready } = await this.assemble(upload, { signal });
      const relative = this.contentRelative(upload, upload.targetRevision);
      const finalPath = this.inside(paths.rootAbs, relative);
      await fs.promises.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o750 });
      try {
        await fs.promises.rename(ready, finalPath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          const exists = await fs.promises.stat(finalPath).catch(() => null);
          if (!exists) throw error;
        }
      }
      const finalStat = await fs.promises.stat(finalPath);
      if (finalStat.size !== upload.size || await fileHash(finalPath, { signal }) !== upload.sha256) {
        throw new CoreError(codes.HASH_MISMATCH, '提交后的文件校验失败', { status: 500 });
      }
      return await this.metadata.completeCommit(uploadId, relative);
    } catch (error) {
      if (upload.status === 'uploading') {
        const cancelled = Boolean(signal && signal.aborted);
        throw await this.fail(upload, error, { cancelled });
      }
      // committing 状态必须留给 recover 完成，不能失败化或生成墓碑。
      throw mapFsError(error);
    }
  }

  async abortUpload(uploadId) {
    const upload = await this.requireUpload(uploadId);
    if (upload.status === 'committed') return { ...upload.result, idempotent: true };
    if (upload.status === 'committing') throw uploadState('内容已进入提交阶段，不能取消；请重试提交或等待恢复');
    const result = await this.metadata.failUpload(uploadId, { status: 'cancelled', code: codes.UPLOAD_CANCELLED, message: '上传已取消' });
    const paths = await this.uploadPaths(upload.regionId, uploadId);
    await fs.promises.rm(paths.absolute, { recursive: true, force: true });
    return { uploadId, status: result.status, cancelledAt: now(this.clock) };
  }

  async openRead({ regionId, fileId, revision = null, range = null, signal } = {}) {
    safeId(fileId, 'fileId');
    const file = await this.metadata.getFile(regionId, fileId, revision);
    if (!file || file.tombstone) throw new CoreError(codes.NOT_FOUND, '文件或指定修订不存在', { status: 404 });
    if (signal && signal.aborted) throw signal.reason || invalid('读取已取消');
    const rootAbs = await this.root(regionId);
    const absolute = this.inside(rootAbs, file.contentPath);
    const handle = await fs.promises.open(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== file.size) {
      await handle.close();
      throw new CoreError(codes.CONFLICT, '物理文件大小与元数据不一致', { status: 409 });
    }
    let start = 0;
    let end = file.size - 1;
    if (range) {
      ({ start, end } = range);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= file.size) {
        await handle.close();
        throw invalid('读取 Range 不可满足');
      }
    }
    let closed = false;
    const closeHandle = async () => {
      if (closed) return;
      closed = true;
      await handle.close().catch(() => {});
    };
    // 不用 FileHandle.createReadStream：Range/客户端中断由生成器 finally 保证关闭句柄。
    const stream = Readable.from((async function* () {
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = start;
        while (position <= end) {
          if (signal && signal.aborted) throw signal.reason || invalid('读取已取消');
          const wanted = Math.min(buffer.length, end - position + 1);
          const { bytesRead } = await handle.read(buffer, 0, wanted, position);
          if (bytesRead === 0) throw new CoreError(codes.CONFLICT, '物理文件提前结束', { status: 409 });
          position += bytesRead;
          yield Buffer.from(buffer.subarray(0, bytesRead));
        }
      } finally { await closeHandle(); }
    })());
    return {
      stream,
      close: closeHandle,
      size: file.size,
      etag: `"sha256-${file.contentHash}"`,
      contentType: file.metadata && file.metadata.contentType || 'application/octet-stream',
      revision: file.revision,
      contentHash: file.contentHash,
      path: file.path
    };
  }

  async deleteFile(input) {
    safeId(input.fileId, 'fileId');
    safeId(input.operationId, 'operationId');
    // 只有这个显式入口可以产生 tombstone；读取、对账与恢复失败不会调用它。
    return this.metadata.commitDelete(input);
  }

  async recover({ signal } = {}) {
    const pending = await this.metadata.pendingUploads();
    const recovered = [];
    const resumable = [];
    const failed = [];
    for (const upload of pending) {
      if (signal && signal.aborted) throw signal.reason;
      if (upload.status === 'uploading') {
        resumable.push({ uploadId: upload.uploadId, nextOffset: upload.nextOffset, size: upload.size });
        continue;
      }
      try {
        const result = await this.commitUpload({ uploadId: upload.uploadId, signal });
        recovered.push({ uploadId: upload.uploadId, revision: result.revision });
      } catch (error) {
        failed.push({ uploadId: upload.uploadId, code: error.code || 'RECOVERY_FAILED', message: error.message });
      }
    }
    return { recovered, resumable, failed };
  }

  async reconcile({ regionId, cursor = null, deep = false, signal } = {}) {
    const files = await this.metadata.listFiles(regionId);
    const rootAbs = await this.root(regionId);
    const missing = [];
    const mismatched = [];
    let checked = 0;
    for (const file of files) {
      if (file.tombstone) continue;
      if (signal && signal.aborted) throw signal.reason;
      checked += 1;
      try {
        const absolute = this.inside(rootAbs, file.contentPath);
        const stat = await fs.promises.stat(absolute);
        if (stat.size !== file.size || (deep && await fileHash(absolute, { signal }) !== file.contentHash)) {
          mismatched.push({ fileId: file.fileId, revision: file.revision });
        }
      } catch (error) {
        if (error.code === 'ENOENT') missing.push({ fileId: file.fileId, revision: file.revision });
        else throw error;
      }
    }
    const changes = await this.metadata.changesSince({ regionId, cursor });
    // 缺失/损坏只进入诊断，绝不在这里生成 delete/tombstone。
    return { ...changes, checked, missing, mismatched };
  }
}

module.exports = { FileContentStore, EMPTY_SHA256, normalizeSha, fileHash, mapFsError };
