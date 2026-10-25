'use strict';
// Paper 服务层：上传 / 读取 / 列表 / 删除 / 翻译 / 问答。
//
// 边界：
//  - 只依赖 Node 内置模块与 core 的两个公共能力（CoreError、JsonStore）；
//  - 所有写操作先过身份与所有权检查；跨用户访问返回 403；
//  - 能力未配置返回 409 + paper.* code，宁可失败也不伪造译文/答案；
//  - 数据落 JsonStore：config.dataFile 未给时纯内存。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const { CoreError, codes } = require('../../../core/errors.js');
const { JsonStore } = require('../../../core/storage/json-store.js');
const { PAPER_CODES } = require('./codes.js');
const { extractPdf, extractText } = require('./extract.js');
const { flattenSegments, segmentBlocks, splitParagraphs } = require('./segment.js');
const {
  normalizeAnswer,
  normalizeSearchSids,
  normalizeTranslations,
  resolveAdapter
} = require('./adapters.js');

const DOCS = 'docs';
const JOBS = 'jobs';
const TRANSLATIONS = 'translations';

const DEFAULT_MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const DEFAULT_TARGET_LANG = 'zh';
const DEFAULT_QA_TOP_K = 6;
const DEFAULT_BATCH_SIZE = 20;
const MAX_TARGET_LANG_LENGTH = 32;
const MAX_QUESTION_CHARS = 2000;
const MAX_CONTEXT_CHARS = 8000;

const TEXT_EXTENSIONS = new Set(['.txt', '.text', '.md', '.markdown']);
const TARGET_LANG_RE = /^[A-Za-z-]{2,32}$/;

function noopLogger() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop };
}

function safeLogger(logger) {
  if (!logger || typeof logger !== 'object') return noopLogger();
  return {
    info: typeof logger.info === 'function' ? logger.info.bind(logger) : () => {},
    warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : () => {},
    error: typeof logger.error === 'function' ? logger.error.bind(logger) : () => {}
  };
}

function requireUser(user) {
  const raw = user && (user.id || user.userId || user.username);
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new CoreError(codes.FORBIDDEN, '需要登录后才能访问论文模块', { status: 403 });
  }
  return String(raw);
}

function humanBytes(value) {
  return `${value} 字节`;
}

function safeError(err) {
  const message = err && typeof err.message === 'string' && err.message.trim()
    ? err.message.trim()
    : '未知错误';
  return message.replace(/\s+/g, ' ').slice(0, 300);
}

function intInRange(value, fallback, min, max, field) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new CoreError(codes.CONFIG_INVALID, `${field} 必须是 ${min}..${max} 的整数`, { status: 500 });
  }
  return number;
}

function normalizeConfig(input) {
  const config = input && typeof input === 'object' ? input : {};
  const dataFileRaw = config.dataFile;
  if (dataFileRaw !== undefined && dataFileRaw !== null && typeof dataFileRaw !== 'string') {
    throw new CoreError(codes.CONFIG_INVALID, 'config.dataFile 必须是字符串或 null', { status: 500 });
  }
  const dataFile = typeof dataFileRaw === 'string' && dataFileRaw.trim() ? path.resolve(dataFileRaw.trim()) : null;

  let uploadsDir = null;
  if (config.uploadsDir !== undefined && config.uploadsDir !== null) {
    if (typeof config.uploadsDir !== 'string' || !config.uploadsDir.trim()) {
      throw new CoreError(codes.CONFIG_INVALID, 'config.uploadsDir 必须是非空字符串', { status: 500 });
    }
    uploadsDir = path.resolve(config.uploadsDir.trim());
  } else if (dataFile) {
    uploadsDir = path.join(path.dirname(dataFile), 'uploads');
  }

  let defaultTargetLang = DEFAULT_TARGET_LANG;
  if (config.defaultTargetLang !== undefined) {
    if (typeof config.defaultTargetLang !== 'string' || !TARGET_LANG_RE.test(config.defaultTargetLang)) {
      throw new CoreError(codes.CONFIG_INVALID, 'config.defaultTargetLang 不是合法语言代码', { status: 500 });
    }
    defaultTargetLang = config.defaultTargetLang;
  }

  return {
    dataFile,
    uploadsDir,
    maxUploadBytes: intInRange(config.maxUploadBytes, DEFAULT_MAX_UPLOAD_BYTES, 1024, 128 * 1024 * 1024, 'config.maxUploadBytes'),
    defaultTargetLang,
    qaTopK: intInRange(config.qaTopK, DEFAULT_QA_TOP_K, 1, 20, 'config.qaTopK'),
    translateBatchSize: intInRange(config.translateBatchSize, DEFAULT_BATCH_SIZE, 1, 50, 'config.translateBatchSize'),
    translateAdapter: config.translateAdapter || null,
    qaAdapter: config.qaAdapter || null,
    searchAdapter: config.searchAdapter || null
  };
}

function sanitizeFilename(filename) {
  const raw = String(filename === undefined || filename === null ? '' : filename)
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!raw || raw === '.' || raw === '..') {
    throw new CoreError(codes.INVALID_INPUT, 'filename 不能为空或非法', { status: 400 });
  }
  return raw.slice(0, 255);
}

function decodeBase64(input, maxBytes) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new CoreError(codes.INVALID_INPUT, '缺少 contentBase64（Base64 编码的文件内容）', { status: 400 });
  }
  let text = input.trim();
  const dataUri = /^data:[^,]*;base64,/i.exec(text);
  if (dataUri) text = text.slice(dataUri[0].length);
  text = text.replace(/\s+/g, '');
  if (!text) throw new CoreError(codes.INVALID_INPUT, 'contentBase64 不能为空', { status: 400 });
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new CoreError(codes.INVALID_INPUT, 'contentBase64 不是合法 Base64', { status: 400 });
  }
  const buffer = Buffer.from(text, 'base64');
  if (!buffer.length) throw new CoreError(codes.INVALID_INPUT, '文件内容为空', { status: 400 });
  if (buffer.length > maxBytes) {
    throw new CoreError(codes.INVALID_INPUT, `文件超过上限 ${humanBytes(maxBytes)}`, { status: 413 });
  }
  return buffer;
}

function detectKind(filename, buffer) {
  const ext = path.extname(filename).toLowerCase();
  const magic = buffer.slice(0, 1024).toString('latin1');
  const isPdf = magic.indexOf('%PDF-') !== -1;
  if (isPdf) return 'pdf';
  if (ext === '.pdf') {
    throw new CoreError(PAPER_CODES.UNSUPPORTED_FILE, '扩展名是 .pdf，但文件内容不是合法 PDF', { status: 400 });
  }
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (!buffer.includes(0)) return 'text';
  throw new CoreError(PAPER_CODES.UNSUPPORTED_FILE, '只支持 PDF 与 UTF-8 纯文本（.txt/.md）', { status: 400 });
}

function blocksFromPages(pages) {
  const blocks = [];
  for (const page of pages) {
    const pageNumber = Number(page && page.page) > 0 ? Number(page.page) : 1;
    for (const paragraph of splitParagraphs(page && page.text)) blocks.push({ page: pageNumber, text: paragraph });
  }
  return blocks;
}

function ownerKey(ownerId) {
  const key = String(ownerId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return key || 'user';
}

function jobKey(docId, targetLang) {
  return `${docId}::${targetLang}`;
}

function publicDoc(doc, { full = false } = {}) {
  const base = {
    id: doc.id,
    filename: doc.filename,
    title: doc.title,
    kind: doc.kind,
    mime: doc.mime,
    status: doc.status,
    sizeBytes: doc.sizeBytes,
    contentHash: doc.contentHash,
    pageCount: doc.pageCount,
    blockCount: (doc.blocks || []).length,
    segmentCount: doc.segmentCount,
    charCount: doc.charCount,
    fileAvailable: Boolean(doc.storedRel) || doc.kind === 'text',
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  };
  if (full) {
    base.blocks = (doc.blocks || []).map((block) => ({
      index: block.index,
      page: block.page,
      text: block.text,
      segments: (block.segments || []).map((segment) => ({ sid: segment.sid, text: segment.text }))
    }));
  }
  return base;
}

function publicJob(job) {
  const total = Number(job.total) || 0;
  const done = Number(job.done) || 0;
  const ratio = total > 0 ? done / total : 0;
  return {
    docId: job.docId,
    targetLang: job.targetLang,
    status: job.status,
    total,
    done,
    failed: Number(job.failed) || 0,
    pending: Math.max(0, total - done),
    progress: Number(ratio.toFixed(4)),
    percent: Number((ratio * 100).toFixed(2)),
    completed: job.status === 'done',
    error: job.error || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    completedAt: job.completedAt || null
  };
}

function tokenizeQuestion(question) {
  const tokens = new Set();
  const lower = String(question || '').toLowerCase();
  for (const match of lower.matchAll(/[a-z0-9]{2,}/g)) tokens.add(match[0]);
  for (const match of String(question || '').matchAll(/[\u4e00-\u9fff]/g)) tokens.add(match[0]);
  return [...tokens];
}

function localRank(question, segments, limit) {
  const tokens = tokenizeQuestion(question);
  const lowerQuestion = String(question || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const scored = segments.map((segment) => {
    const text = segment.text.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      let from = 0;
      let hits = 0;
      while (hits < 3) {
        const at = text.indexOf(token, from);
        if (at === -1) break;
        hits += 1;
        from = at + token.length;
      }
      score += hits;
    }
    if (lowerQuestion.length >= 4 && text.includes(lowerQuestion)) score += 5;
    return { segment, score };
  });
  scored.sort((a, b) => (b.score - a.score)
    || (a.segment.blockIndex - b.segment.blockIndex)
    || (a.segment.sentenceIndex - b.segment.sentenceIndex));
  const selected = scored.slice(0, limit).map((item) => item.segment);
  selected.sort((a, b) => (a.blockIndex - b.blockIndex) || (a.sentenceIndex - b.sentenceIndex));
  return { segments: selected, matched: scored.some((item) => item.score > 0) };
}

function limitContext(segments, maxChars) {
  const out = [];
  let chars = 0;
  for (const segment of segments) {
    if (out.length > 0 && chars + segment.text.length > maxChars) break;
    out.push(segment);
    chars += segment.text.length;
  }
  return out.length ? out : segments.slice(0, 1);
}

// 引用可以是 sid 字符串、扁平句子下标（数字），或 { sid } / { blockIndex, sentenceIndex } / { index }。
// 任何无法映射到真实句子的引用一律丢弃，由调用方计入 citationsIgnored。
function resolveCitation(item, index, allSegments) {
  if (typeof item === 'string') return index.get(item) || null;
  if (Number.isInteger(item)) return allSegments[item] || null;
  if (!item || typeof item !== 'object') return null;
  if (typeof item.sid === 'string') return index.get(item.sid) || null;
  if (Number.isInteger(item.blockIndex) && Number.isInteger(item.sentenceIndex)) {
    return index.get(`${item.blockIndex}:${item.sentenceIndex}`) || null;
  }
  if (Number.isInteger(item.index)) return allSegments[item.index] || null;
  if (Number.isInteger(item.i)) return allSegments[item.i] || null;
  return null;
}

function batchPending(pending, maxItems, maxChars) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const item of pending) {
    if (current.length && (current.length >= maxItems || chars + item.text.length > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += item.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

class PaperService {
  constructor({ config, logger } = {}) {
    this.config = normalizeConfig(config);
    this.logger = safeLogger(logger);
    this.store = new JsonStore({ filePath: this.config.dataFile });
    this.active = new Set();
    this.canceled = new Set();
    this.started = false;
    this.stopping = false;
  }

  async init() {
    if (this.config.uploadsDir) {
      fs.mkdirSync(this.config.uploadsDir, { recursive: true, mode: 0o700 });
    }
    this.started = true;
    this.stopping = false;
    this.logger.info(`[paper] ready (docs=${this.store.count(DOCS)}, uploads=${this.config.uploadsDir ? 'disk' : 'memory'})`);
  }

  async close() {
    this.stopping = true;
    // 先停止新任务，再给运行中的翻译一个收敛窗口：翻译循环在下一批之前看到
    // stopping 会把任务落盘为 interrupted（已完成批次保留），下次可恢复。
    const deadline = Date.now() + 10000;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    this.started = false;
  }

  health() {
    return {
      ok: this.started && !this.stopping,
      reason: this.started && !this.stopping ? null : 'not-started',
      docs: this.store.count(DOCS),
      storage: this.config.dataFile ? 'json-file' : 'memory',
      uploads: this.config.uploadsDir ? 'disk' : 'memory'
    };
  }

  // -------------------------------------------------------------------------
  // 文档
  // -------------------------------------------------------------------------

  ownedDoc(ownerId, docId) {
    if (typeof docId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(docId)) {
      throw new CoreError(codes.NOT_FOUND, '论文不存在', { status: 404 });
    }
    const doc = this.store.get(DOCS)[docId];
    if (!doc) throw new CoreError(codes.NOT_FOUND, '论文不存在', { status: 404 });
    if (doc.ownerId !== ownerId) {
      throw new CoreError(codes.FORBIDDEN, '无权访问其他用户的论文', { status: 403 });
    }
    return doc;
  }

  async uploadDoc({ user, filename, contentBase64 } = {}) {
    const cleanName = sanitizeFilename(filename);
    const buffer = decodeBase64(contentBase64, this.config.maxUploadBytes);
    return this.uploadBuffer({ user, filename: cleanName, buffer });
  }

  /** 原始字节上传（公共 upload transport 与 JSON Base64 共用）。 */
  async uploadBuffer({ user, filename, buffer } = {}) {
    const ownerId = requireUser(user);
    const cleanName = sanitizeFilename(filename);
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new CoreError(codes.INVALID_INPUT, '文件内容为空', { status: 400 });
    }
    if (buffer.length > this.config.maxUploadBytes) {
      throw new CoreError(codes.INVALID_INPUT, `文件超过上限 ${humanBytes(this.config.maxUploadBytes)}`, { status: 413 });
    }
    const kind = detectKind(cleanName, buffer);

    let pages;
    try {
      pages = kind === 'pdf' ? extractPdf(buffer) : extractText(buffer);
    } catch (err) {
      throw new CoreError(PAPER_CODES.EXTRACT_FAILED, `正文提取失败：${safeError(err)}`, {
        status: 422,
        details: { filename: cleanName, kind }
      });
    }

    const blocks = blocksFromPages(pages);
    const segmented = segmentBlocks(blocks);
    if (!segmented.length) {
      throw new CoreError(PAPER_CODES.EXTRACT_FAILED, '正文提取失败：没有可用的文本内容', {
        status: 422,
        details: { filename: cleanName, kind }
      });
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const segments = flattenSegments(segmented);
    const charCount = segmented.reduce((sum, block) => sum + block.text.length, 0);
    const pageCount = Math.max(...segmented.map((block) => block.page), 1);
    const ext = kind === 'pdf' ? '.pdf' : (path.extname(cleanName).toLowerCase() || '.txt');
    let storedRel = null;

    if (this.config.uploadsDir) {
      storedRel = path.posix.join(ownerKey(ownerId), `${id}${ext}`);
      const absolute = this.resolveStored(storedRel);
      fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
      fs.writeFileSync(absolute, buffer, { mode: 0o600 });
    }

    const doc = {
      id,
      ownerId,
      filename: cleanName,
      title: cleanName.replace(/\.[^.]+$/, '').slice(0, 300) || cleanName,
      kind,
      mime: kind === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8',
      status: 'ready',
      sizeBytes: buffer.length,
      contentHash: crypto.createHash('sha256').update(buffer).digest('hex'),
      storedRel,
      pageCount,
      blocks: segmented,
      segmentCount: segments.length,
      charCount,
      createdAt: now,
      updatedAt: now
    };

    try {
      this.store.put(DOCS, id, doc);
    } catch (err) {
      if (storedRel) this.removeStored(storedRel);
      throw err;
    }

    this.logger.info(`[paper] upload ${id} owner=${ownerId} kind=${kind} segments=${doc.segmentCount}`);
    return { doc: publicDoc(doc) };
  }

  listDocs({ user } = {}) {
    const ownerId = requireUser(user);
    const docs = Object.values(this.store.get(DOCS))
      .filter((doc) => doc.ownerId === ownerId)
      .sort((a, b) => (b.createdAt - a.createdAt) || String(a.id).localeCompare(String(b.id)));
    return { docs: docs.map((doc) => publicDoc(doc)) };
  }

  getDoc({ user, docId } = {}) {
    const ownerId = requireUser(user);
    const doc = this.ownedDoc(ownerId, docId);
    const job = this.latestJob(doc.id);
    return {
      doc: publicDoc(doc, { full: true }),
      translation: job ? publicJob(this.effectiveJob(job)) : this.idleJob(doc, null)
    };
  }

  /** 原件下载：落盘原件直接流式返回；纯文本未落盘时由已提取正文重建。inline=1 供同源阅读器内嵌。 */
  getRawFile({ user, docId, inline } = {}) {
    const ownerId = requireUser(user);
    const doc = this.ownedDoc(ownerId, docId);
    const disposition = `${inline === true ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(doc.filename)}`;
    const base = {
      contentType: doc.mime || 'application/octet-stream',
      contentDisposition: disposition
    };
    if (doc.storedRel) {
      const absolute = this.resolveStored(doc.storedRel);
      let stat;
      try {
        stat = fs.statSync(absolute);
      } catch {
        throw new CoreError(PAPER_CODES.FILE_NOT_AVAILABLE, '原件文件不存在', { status: 404 });
      }
      if (!stat.isFile()) throw new CoreError(PAPER_CODES.FILE_NOT_AVAILABLE, '原件不是普通文件', { status: 404 });
      return { stream: fs.createReadStream(absolute), size: stat.size, ...base };
    }
    if (doc.kind === 'text') {
      const buffer = Buffer.from((doc.blocks || []).map((block) => block.text).join('\n\n'), 'utf8');
      return {
        stream: Readable.from(buffer),
        size: buffer.length,
        contentType: 'text/plain; charset=utf-8',
        contentDisposition: disposition
      };
    }
    throw new CoreError(
      PAPER_CODES.FILE_NOT_AVAILABLE,
      '原件未保存（未配置 uploadsDir），无法下载 PDF 原件',
      { status: 409 }
    );
  }

  /**
   * 进程重启后，持久化的 running 任务没有对应的内存活动标记。
   * 不能继续对外显示「正在翻译」，应如实呈现为可恢复的 interrupted。
   */
  effectiveJob(job) {
    if (job && job.status === 'running' && !this.active.has(jobKey(job.docId, job.targetLang))) {
      return {
        ...job,
        status: 'interrupted',
        error: job.error || '任务已中断（进程重启或服务停止），再次发起翻译可恢复'
      };
    }
    return job;
  }

  deleteDoc({ user, docId } = {}) {
    const ownerId = requireUser(user);
    const doc = this.ownedDoc(ownerId, docId);
    if (doc.storedRel) this.removeStored(doc.storedRel);

    for (const collection of [JOBS, TRANSLATIONS]) {
      const bucket = this.store.get(collection);
      for (const key of Object.keys(bucket)) {
        if (key.startsWith(`${doc.id}::`)) this.store.remove(collection, key);
      }
    }
    this.store.remove(DOCS, doc.id);
    this.logger.info(`[paper] delete ${doc.id} owner=${ownerId}`);
    return { deleted: true, id: doc.id };
  }

  resolveStored(rel) {
    const absolute = path.resolve(this.config.uploadsDir || '', rel);
    const root = path.resolve(this.config.uploadsDir || '');
    if (!root || (absolute !== root && !absolute.startsWith(root + path.sep))) {
      throw new CoreError(codes.PATH_ESCAPE, '上传文件路径越界', { status: 500 });
    }
    return absolute;
  }

  removeStored(rel) {
    if (!this.config.uploadsDir) return;
    try {
      fs.unlinkSync(this.resolveStored(rel));
    } catch (err) {
      if (err && err.code !== 'ENOENT') this.logger.warn(`[paper] 删除原件失败：${safeError(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // 翻译
  // -------------------------------------------------------------------------

  normalizeTargetLang(value) {
    if (value === undefined || value === null || value === '') return this.config.defaultTargetLang;
    const lang = String(value).trim();
    if (!TARGET_LANG_RE.test(lang) || lang.length > MAX_TARGET_LANG_LENGTH) {
      throw new CoreError(codes.INVALID_INPUT, 'targetLang 不是合法语言代码', { status: 400 });
    }
    return lang;
  }

  idleJob(doc, targetLang) {
    return {
      docId: doc.id,
      targetLang: targetLang || this.config.defaultTargetLang,
      status: 'idle',
      total: doc.segmentCount,
      done: 0,
      failed: 0,
      pending: doc.segmentCount,
      progress: 0,
      percent: 0,
      completed: false,
      error: null,
      startedAt: null,
      updatedAt: doc.updatedAt,
      completedAt: null
    };
  }

  latestJob(docId, targetLang) {
    const jobs = this.store.get(JOBS);
    if (targetLang) return jobs[jobKey(docId, targetLang)] || null;
    let latest = null;
    for (const job of Object.values(jobs)) {
      if (job.docId !== docId) continue;
      if (!latest || (job.updatedAt || 0) > (latest.updatedAt || 0)) latest = job;
    }
    return latest;
  }

  getTranslation({ user, docId, targetLang, includeText } = {}) {
    const ownerId = requireUser(user);
    const doc = this.ownedDoc(ownerId, docId);
    const lang = targetLang ? this.normalizeTargetLang(targetLang) : null;
    const job = this.latestJob(doc.id, lang);
    if (!job) return { job: this.idleJob(doc, lang), translations: null };

    const body = { job: publicJob(this.effectiveJob(job)), translations: null };
    if (includeText === true || includeText === '1' || includeText === 'text') {
      const record = this.store.get(TRANSLATIONS)[jobKey(doc.id, job.targetLang)];
      body.translations = record ? { ...record.bySid } : {};
    }
    return body;
  }

  async translateDoc({ user, docId, targetLang, restart } = {}) {
    const ownerId = requireUser(user);
    const doc = this.ownedDoc(ownerId, docId);
    if (doc.status !== 'ready' || !doc.segmentCount) {
      throw new CoreError(PAPER_CODES.NOT_READY, '论文正文尚未就绪，无法翻译', { status: 409 });
    }

    const lang = this.normalizeTargetLang(targetLang);
    const key = jobKey(doc.id, lang);
    if (this.active.has(key)) {
      throw new CoreError(PAPER_CODES.TRANSLATE_IN_PROGRESS, '该论文的翻译任务正在进行中', {
        status: 409,
        details: { docId: doc.id, targetLang: lang }
      });
    }
    if (restart === true) {
      this.store.remove(TRANSLATIONS, key);
      this.store.remove(JOBS, key);
    }

    const rows = flattenSegments(doc.blocks);
    let record = this.store.get(TRANSLATIONS)[key];
    if (!record) {
      record = { docId: doc.id, targetLang: lang, bySid: {}, updatedAt: Date.now() };
      this.store.put(TRANSLATIONS, key, record);
    }
    const bySid = record.bySid || {};
    const pending = rows.filter((row) => !Object.prototype.hasOwnProperty.call(bySid, row.sid));

    if (!pending.length) {
      const doneJob = this.writeJob(key, doc, lang, {
        status: 'done',
        total: rows.length,
        done: rows.length,
        failed: 0,
        error: null,
        completedAt: Date.now()
      });
      return { job: publicJob(doneJob), progress: 1 };
    }

    const adapter = resolveAdapter(this.config.translateAdapter, 'translate');
    if (!adapter) {
      throw new CoreError(
        PAPER_CODES.TRANSLATE_NOT_CONFIGURED,
        '未配置翻译适配器（config.translateAdapter），无法翻译',
        { status: 409, details: { configKey: 'translateAdapter' } }
      );
    }

    const startedAt = Date.now();
    this.writeJob(key, doc, lang, {
      status: 'running',
      total: rows.length,
      done: rows.length - pending.length,
      failed: 0,
      error: null,
      startedAt,
      completedAt: null
    });
    this.active.add(key);

    try {
      const batches = batchPending(pending, this.config.translateBatchSize, MAX_CONTEXT_CHARS);
      let done = rows.length - pending.length;
      for (const batch of batches) {
        if (this.stopping) throw new Error('模块正在停止，翻译已中断');
        if (this.canceled.has(key)) throw new Error('翻译已停止');
        const contextBlock = doc.blocks[batch[0].blockIndex];
        const raw = await adapter.translate({
          segments: batch.map((row) => ({ sid: row.sid, text: row.text })),
          targetLang: lang,
          context: contextBlock ? String(contextBlock.text).slice(0, 2000) : '',
          doc: { id: doc.id, filename: doc.filename, title: doc.title, status: doc.status }
        });
        const translations = normalizeTranslations(raw, batch);
        translations.forEach((text, index) => { bySid[batch[index].sid] = text; });
        record.bySid = bySid;
        record.updatedAt = Date.now();
        this.store.update(TRANSLATIONS, key, { bySid, updatedAt: record.updatedAt });
        done += batch.length;
        this.writeJob(key, doc, lang, {
          status: 'running',
          total: rows.length,
          done,
          failed: 0,
          error: null,
          updatedAt: Date.now()
        });
      }

      const finished = this.writeJob(key, doc, lang, {
        status: 'done',
        total: rows.length,
        done: rows.length,
        failed: 0,
        error: null,
        completedAt: Date.now()
      });
      this.logger.info(`[paper] translate ${doc.id} ${lang} done (${rows.length} 句)`);
      return { job: publicJob(finished), progress: 1 };
    } catch (err) {
      const doneNow = rows.filter((row) => Object.prototype.hasOwnProperty.call(bySid, row.sid)).length;
      if (this.canceled.has(key)) {
        this.canceled.delete(key);
        const stopped = this.writeJob(key, doc, lang, {
          status: 'stopped',
          total: rows.length,
          done: doneNow,
          failed: 0,
          error: '已停止，可继续翻译',
          updatedAt: Date.now()
        });
        this.logger.info(`[paper] translate ${doc.id} ${lang} stopped by user`);
        return { job: publicJob(stopped), stopped: true };
      }
      const message = safeError(err);
      const interrupted = this.writeJob(key, doc, lang, {
        status: 'interrupted',
        total: rows.length,
        done: doneNow,
        failed: rows.length - doneNow,
        error: message,
        updatedAt: Date.now()
      });
      this.logger.warn(`[paper] translate ${doc.id} ${lang} interrupted: ${message}`);
      throw new CoreError(PAPER_CODES.TRANSLATE_FAILED, `翻译中断：${message}`, {
        status: 502,
        details: { job: publicJob(interrupted) }
      });
    } finally {
      this.active.delete(key);
    }
  }

  /** 用户主动停止：标记后由翻译循环在当前批次结束时收敛为 stopped，可继续。 */
  stopTranslation({ user, docId, targetLang } = {}) {
    const ownerId = requireUser(user);
    const doc = this.ownedDoc(ownerId, docId);
    const lang = this.normalizeTargetLang(targetLang);
    const key = jobKey(doc.id, lang);
    if (!this.active.has(key)) {
      const existing = this.latestJob(doc.id, lang);
      return {
        job: existing ? publicJob(this.effectiveJob(existing)) : this.idleJob(doc, lang),
        stopped: false
      };
    }
    this.canceled.add(key);
    const current = this.store.get(JOBS)[key] || this.idleJob(doc, lang);
    const stopped = this.writeJob(key, doc, lang, {
      status: 'stopped',
      done: Number(current.done) || 0,
      failed: 0,
      error: '已停止，可继续翻译',
      updatedAt: Date.now()
    });
    this.logger.info(`[paper] translate ${doc.id} ${lang} stop requested`);
    return { job: publicJob(stopped), stopped: true };
  }

  writeJob(key, doc, targetLang, patch) {
    const now = Date.now();
    const existing = this.store.get(JOBS)[key];
    const merged = {
      key,
      docId: doc.id,
      ownerId: doc.ownerId,
      targetLang,
      status: 'idle',
      total: doc.segmentCount,
      done: 0,
      failed: 0,
      error: null,
      startedAt: null,
      completedAt: null,
      ...(existing || {}),
      ...patch,
      updatedAt: patch.updatedAt || now
    };
    if (existing) this.store.update(JOBS, key, merged);
    else this.store.put(JOBS, key, merged);
    return merged;
  }

  // -------------------------------------------------------------------------
  // 问答
  // -------------------------------------------------------------------------

  async askDoc({ user, docId, question, topK } = {}) {
    const ownerId = requireUser(user);
    const doc = this.ownedDoc(ownerId, docId);
    const text = String(question === undefined || question === null ? '' : question).trim();
    if (!text) throw new CoreError(codes.INVALID_INPUT, 'question 不能为空', { status: 400 });
    if (text.length > MAX_QUESTION_CHARS) {
      throw new CoreError(codes.INVALID_INPUT, `question 不得超过 ${MAX_QUESTION_CHARS} 字`, { status: 400 });
    }
    if (doc.status !== 'ready' || !doc.segmentCount) {
      throw new CoreError(PAPER_CODES.NOT_READY, '论文正文尚未就绪，无法问答', { status: 409 });
    }

    let limit = this.config.qaTopK;
    if (topK !== undefined && topK !== null && topK !== '') {
      const number = Number(topK);
      if (!Number.isSafeInteger(number) || number < 1 || number > 20) {
        throw new CoreError(codes.INVALID_INPUT, 'topK 必须是 1..20 的整数', { status: 400 });
      }
      limit = number;
    }

    const adapter = resolveAdapter(this.config.qaAdapter, 'ask');
    if (!adapter) {
      throw new CoreError(PAPER_CODES.QA_NOT_CONFIGURED, '未配置问答适配器（config.qaAdapter），无法问答', {
        status: 409,
        details: { configKey: 'qaAdapter' }
      });
    }
    const allSegments = flattenSegments(doc.blocks);
    const index = new Map(allSegments.map((segment) => [segment.sid, segment]));
    const docBrief = { id: doc.id, filename: doc.filename, title: doc.title, kind: doc.kind, pageCount: doc.pageCount };

    let selected = null;
    let degraded = null;
    let source = 'local';

    const search = resolveAdapter(this.config.searchAdapter, 'search');
    if (search) {
      try {
        const raw = await search.search({
          question: text,
          topK: limit,
          segments: allSegments.map((segment) => ({
            sid: segment.sid, text: segment.text, page: segment.page, blockIndex: segment.blockIndex
          })),
          doc: docBrief
        });
        const sids = normalizeSearchSids(raw);
        const picked = [];
        const seen = new Set();
        for (const sid of sids) {
          const hit = index.get(sid);
          if (!hit || seen.has(sid)) continue;
          seen.add(sid);
          picked.push(hit);
          if (picked.length >= limit) break;
        }
        if (picked.length) {
          selected = picked;
          source = 'adapter';
        } else {
          degraded = { code: 'paper.search_empty', message: '检索适配器未返回可用句子，已降级为本地关键词检索' };
        }
      } catch (err) {
        degraded = { code: 'paper.search_failed', message: `检索适配器不可用（${safeError(err)}），已降级为本地关键词检索` };
      }
    } else {
      degraded = { code: 'paper.search_unavailable', message: '未配置检索适配器（config.searchAdapter），已降级为本地关键词检索' };
    }

    if (!selected) {
      const local = localRank(text, allSegments, limit);
      selected = local.segments;
      if (!local.matched && !degraded) {
        degraded = { code: 'paper.search_no_match', message: '未命中关键词，已返回正文前若干句作为上下文' };
      }
    }

    const context = limitContext(selected, MAX_CONTEXT_CHARS);
    let rawAnswer;
    try {
      rawAnswer = await adapter.ask({
        question: text,
        segments: context.map((segment) => ({
          sid: segment.sid, text: segment.text, page: segment.page, blockIndex: segment.blockIndex
        })),
        doc: docBrief
      });
    } catch (err) {
      throw new CoreError(PAPER_CODES.QA_FAILED, `问答失败：${safeError(err)}`, { status: 502 });
    }

    let normalized;
    try {
      normalized = normalizeAnswer(rawAnswer);
    } catch (err) {
      throw new CoreError(PAPER_CODES.QA_FAILED, `问答适配器返回不可用：${safeError(err)}`, { status: 502 });
    }

    const citations = [];
    const seenCitation = new Set();
    let ignoredCitations = 0;
    for (const item of normalized.citations) {
      const hit = resolveCitation(item, index, allSegments);
      if (!hit) { ignoredCitations += 1; continue; }
      if (seenCitation.has(hit.sid)) continue;
      seenCitation.add(hit.sid);
      citations.push({
        sid: hit.sid,
        blockIndex: hit.blockIndex,
        sentenceIndex: hit.sentenceIndex,
        page: hit.page,
        text: hit.text
      });
    }

    return {
      docId: doc.id,
      answer: normalized.answer,
      citations,
      retrieved: context.map((segment) => segment.sid),
      search: { source, configured: Boolean(search) },
      degraded,
      citationsIgnored: ignoredCitations
    };
  }
}

module.exports = {
  PaperService,
  publicDoc,
  publicJob,
  normalizeConfig,
  requireUser
};
