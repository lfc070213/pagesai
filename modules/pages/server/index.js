'use strict';
// Pages 模块（AI 生成网页）公开版最小闭环。
//
// 范围（方案 §7.1 的最小可验收子集）：
//   1. 站点 CRUD（按 ownerId 隔离）；
//   2. 站点文件读写删（虚拟路径，拒绝 `..`、绝对路径与反斜杠；按用户隔离）；
//   3. 发布快照（version + contentHash）、公开只读访问、回滚上一版本；
//   4. 可插拔 AI 修改（config.aiAdapter），未配置时明确 409 pages.ai_not_configured。
//
// 硬约束：
//   - 只使用 Node 内置模块；
//   - 数据走 core/storage/json-store.js（config.dataFile 缺省时纯内存）；
//   - 任何路由错误都以 {code, message} 返回，handler 不向外抛异常；
//   - 公开访问路由不读取 ctx.user，也不在响应里暴露 ownerId；
//   - 未配置 AI 适配器时绝不返回伪造的生成结果。

const crypto = require('node:crypto');
const path = require('node:path');

const { CoreError, codes } = require('../../../core/errors.js');
const { JsonStore } = require('../../../core/storage/json-store.js');

const MODULE_ID = 'pages';
const MODULE_VERSION = '0.1.0';
const DEFAULT_PUBLIC_BASE = '/api/pages/public';
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES_PER_SITE = 200;
const DEFAULT_MAX_SITES_PER_USER = 20;
const DEFAULT_MAX_VERSIONS = 50;
const DEFAULT_AI_TIMEOUT_MS = 60000;

// 只托管文本型站点资源：JSON Store 保存字符串，二进制资源不在本模块闭环内。
const FILE_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
});

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}(?:;\s*charset=[a-z0-9-]{1,32})?$/i;
const PUBLIC_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'";

// 模块运行态。start() 之前为未就绪；stop() 后清空。
const state = {
  ready: false,
  store: null,
  config: null,
  logger: null,
  adapter: null,
  platform: null,
  startedAt: null
};

function noopLogger() {
  return { info() {}, warn() {}, error() {} };
}

function log(level, message) {
  const logger = state.logger;
  if (logger && typeof logger[level] === 'function') logger[level](`[pages] ${message}`);
}

function nowIso() {
  return new Date().toISOString();
}

function positiveInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) return fallback;
  return n;
}

function pickAdapter(config) {
  const raw = config.aiAdapter !== undefined
    ? config.aiAdapter
    : (config.ai && config.ai.adapter !== undefined ? config.ai.adapter : null);
  if (raw === null || raw === undefined) return null;
  const usable = typeof raw === 'function'
    || (typeof raw === 'object' && (typeof raw.generate === 'function' || typeof raw.modify === 'function'));
  if (!usable) {
    throw new CoreError(codes.CONFIG_INVALID, 'config.aiAdapter 必须是函数，或带 generate()/modify() 的对象', { status: 500 });
  }
  return raw;
}

function normalizeConfig(input) {
  const config = input && typeof input === 'object' ? input : {};
  const dataFile = config.dataFile === undefined || config.dataFile === null || config.dataFile === ''
    ? null
    : String(config.dataFile);
  const publicBasePath = typeof config.publicBasePath === 'string' && /^\/[\w./-]*$/.test(config.publicBasePath)
    ? config.publicBasePath.replace(/\/+$/, '')
    : DEFAULT_PUBLIC_BASE;
  return {
    dataFile,
    publicBasePath: publicBasePath || DEFAULT_PUBLIC_BASE,
    maxFileBytes: positiveInt(config.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 1024, 10 * 1024 * 1024),
    maxFilesPerSite: positiveInt(config.maxFilesPerSite, DEFAULT_MAX_FILES_PER_SITE, 1, 5000),
    maxSitesPerUser: positiveInt(config.maxSitesPerUser, DEFAULT_MAX_SITES_PER_USER, 1, 1000),
    maxVersions: positiveInt(config.maxVersions, DEFAULT_MAX_VERSIONS, 1, 200),
    aiTimeoutMs: positiveInt(config.ai && config.ai.timeoutMs, DEFAULT_AI_TIMEOUT_MS, 1000, 600000),
    adapter: pickAdapter(config)
  };
}

/** 启动：装载 JsonStore、修复 slug 索引、注入 AI 适配器。 */
async function start(options = {}) {
  const hasWrapper = options && Object.prototype.hasOwnProperty.call(options, 'config');
  const rawConfig = hasWrapper ? options.config : options;
  const logger = (options && options.logger) || noopLogger();
  if (state.ready) {
    // 已启动时保持幂等：不重复装载、不清空内存数据；换配置必须先 stop()。
    return { ok: true, storage: state.platform ? 'mongodb+content-store' : (state.config.dataFile ? 'file' : 'memory'), alreadyStarted: true };
  }

  if (options.runtime && options.runtime.db && typeof options.fileAdapter === 'function') {
    const { PagesPlatform } = require('./platform.js');
    const platform = new PagesPlatform({ ...options, logger });
    const result = await platform.start();
    state.platform = platform;
    state.config = { dataFile: null };
    state.logger = logger;
    state.startedAt = nowIso();
    state.ready = true;
    return result;
  }

  const config = normalizeConfig(rawConfig || {});
  let store;
  try {
    store = new JsonStore({ filePath: config.dataFile });
  } catch (err) {
    throw new CoreError(codes.CONFIG_INVALID, 'Pages 数据文件不可读或格式非法', { status: 500 });
  }

  state.store = store;
  state.config = config;
  state.logger = logger;
  state.adapter = config.adapter;
  state.startedAt = nowIso();
  try {
    rebuildSlugIndex(store);
  } catch (err) {
    state.store = null;
    state.config = null;
    state.logger = null;
    state.adapter = null;
    state.startedAt = null;
    throw new CoreError(codes.CONFIG_INVALID, 'Pages 数据文件不可写', { status: 500 });
  }
  state.ready = true;
  log('info', `已启动（storage=${config.dataFile ? 'file' : 'memory'}, ai=${config.adapter ? 'configured' : 'not-configured'}）`);
  return { ok: true, storage: config.dataFile ? 'file' : 'memory' };
}

/** 停止：先停止接收新请求（由宿主摘路由），保留数据文件。 */
async function stop() {
  if (!state.ready && !state.store && !state.platform) return { ok: true };
  state.ready = false;
  if (state.platform) {
    await state.platform.stop();
    state.platform = null;
  }
  state.store = null;
  state.config = null;
  state.adapter = null;
  state.logger = null;
  state.startedAt = null;
  return { ok: true };
}

/** 健康：模块可服务即 ok；AI 未配置不影响就绪，但会如实标注。 */
async function health() {
  if (state.ready && state.platform) {
    return { ok: true, module: MODULE_ID, version: '0.2.0', aiConfigured: true, storage: 'mongodb+content-store', startedAt: state.startedAt };
  }
  if (!state.ready || !state.store) return { ok: false, reason: 'stopped' };
  try {
    return {
      ok: true,
      module: MODULE_ID,
      version: MODULE_VERSION,
      aiConfigured: Boolean(state.adapter),
      storage: state.config.dataFile ? 'file' : 'memory',
      sites: state.store.count('sites'),
      startedAt: state.startedAt
    };
  } catch (err) {
    return { ok: false, reason: 'storage-unavailable' };
  }
}

function store() {
  if (!state.ready || !state.store) {
    throw new CoreError(codes.MODULE_NOT_READY, 'Pages 模块尚未启动', { status: 503 });
  }
  return state.store;
}

function rebuildSlugIndex(st) {
  const sites = st.get('sites');
  const slugs = st.get('slugs');
  const seen = new Set();
  for (const site of Object.values(sites)) {
    if (!site || typeof site.slug !== 'string' || typeof site.id !== 'string') continue;
    if (!SLUG_RE.test(site.slug)) continue;
    seen.add(site.slug);
    if (!(site.slug in slugs) || !(slugs[site.slug] in sites)) slugs[site.slug] = site.id;
  }
  for (const [slug, id] of Object.entries(slugs)) {
    if (!(id in sites) || !seen.has(slug)) delete slugs[slug];
  }
  st.save();
}

// ---------------------------------------------------------------------------
// 输入校验
// ---------------------------------------------------------------------------

function requireText(value, field, { min = 1, max = 200 } = {}) {
  if (typeof value !== 'string') {
    throw new CoreError(codes.INVALID_INPUT, `${field} 必须是字符串`, { status: 400 });
  }
  const text = value.trim();
  if (text.length < min) {
    throw new CoreError(codes.INVALID_INPUT, `${field} 不能为空`, { status: 400 });
  }
  if (text.length > max) {
    throw new CoreError(codes.INVALID_INPUT, `${field} 长度不得超过 ${max}`, { status: 400 });
  }
  return text;
}

function optionalDescription(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new CoreError(codes.INVALID_INPUT, 'description 必须是字符串', { status: 400 });
  }
  if (value.length > 500) {
    throw new CoreError(codes.INVALID_INPUT, 'description 长度不得超过 500', { status: 400 });
  }
  return value.trim();
}

function normalizeSlug(value) {
  if (typeof value !== 'string') {
    throw new CoreError(codes.INVALID_INPUT, 'slug 必须是字符串', { status: 400 });
  }
  const slug = value.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    throw new CoreError(codes.INVALID_INPUT, 'slug 只允许小写字母/数字/连字符，长度 2-64 且首尾不能是连字符', { status: 400 });
  }
  return slug;
}

function slugify(name) {
  const base = String(name)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base.length >= 2 ? base : 'site';
}

function pathEscape(message) {
  return new CoreError(codes.PATH_ESCAPE, message, { status: 400 });
}

/**
 * 校验并归一化站点内虚拟文件路径。
 * 返回值同时用作站点内文件索引键；不做任何宿主文件系统解析，因此天然落在站点命名空间内。
 */
function normalizeFilePath(raw) {
  if (typeof raw !== 'string') throw pathEscape('文件路径必须是字符串');
  let value = raw;

  // 防止编码绕过（含双重编码）：只在出现 %XX 时解码，最多两轮。
  for (let i = 0; i < 2 && /%[0-9a-f]{2}/i.test(value); i++) {
    let decoded;
    try {
      decoded = decodeURIComponent(value);
    } catch (err) {
      throw pathEscape('文件路径包含非法转义');
    }
    if (decoded === value) break;
    value = decoded;
  }

  if (value.length === 0) throw pathEscape('文件路径不能为空');
  if (value.length > 300) throw pathEscape('文件路径过长');
  if (/[\u0000-\u001f\u007f]/.test(value)) throw pathEscape('文件路径包含控制字符');
  if (value.includes('\\')) throw pathEscape('文件路径不得包含反斜杠');
  if (value.startsWith('/')) throw pathEscape('不允许绝对路径');
  if (/^[a-z]:/i.test(value)) throw pathEscape('不允许 Windows 盘符路径');

  const segments = value.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw pathEscape('文件路径不得包含空段、`.` 或 `..`');
    }
    if (segment !== segment.trim()) throw pathEscape('路径段不得以空白开头或结尾');
  }

  const ext = path.extname(value).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(FILE_TYPES, ext)) {
    throw new CoreError('pages.unsupported_file_type', `不支持的文件类型：${ext || '（无扩展名）'}`, { status: 400 });
  }
  return value;
}

function defaultContentType(filePath) {
  return FILE_TYPES[path.extname(filePath).toLowerCase()] || 'text/plain; charset=utf-8';
}

function contentTypeFor(filePath, requested) {
  if (requested === undefined || requested === null || requested === '') return defaultContentType(filePath);
  if (typeof requested !== 'string' || requested.length > 120 || /[\r\n]/.test(requested) || !MIME_RE.test(requested)) {
    throw new CoreError(codes.INVALID_INPUT, 'contentType 不是合法的 MIME 类型', { status: 400 });
  }
  return requested;
}

function safeContentType(filePath, value) {
  try {
    return contentTypeFor(filePath, value);
  } catch (err) {
    return defaultContentType(filePath);
  }
}

// ---------------------------------------------------------------------------
// 站点与文件访问
// ---------------------------------------------------------------------------

function userOf(ctx) {
  const user = ctx && ctx.user;
  if (user && typeof user.id === 'string' && user.id.length > 0) return user;
  return null;
}

function requireUser(ctx, { write = false } = {}) {
  const user = userOf(ctx);
  if (user) return user;
  if (write) throw new CoreError(codes.FORBIDDEN, '未认证的写操作被拒绝', { status: 403 });
  throw new CoreError(codes.SESSION_INVALID, '需要登录后访问', { status: 401 });
}

function paramsOf(ctx) {
  const params = ctx && ctx.params;
  return params && typeof params === 'object' ? params : {};
}

function queryOf(ctx) {
  const query = ctx && ctx.query;
  return query && typeof query === 'object' ? query : {};
}

function bodyOf(ctx) {
  const body = ctx && ctx.body;
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

function siteIdOf(params) {
  return requireText(params.siteId, 'siteId', { min: 1, max: 128 });
}

function wildcardPathOf(params) {
  // 兼容不同宿主对通配参数的命名（直接调用 handler 时常见 filePath；公共核心用 wildcard）。
  let raw = params.filePath;
  if (raw === undefined) raw = params.wildcard;
  if (raw === undefined) raw = params['*'];
  if (raw === undefined) raw = params.path;
  return raw;
}

function filePathOf(params, { fallback = null } = {}) {
  const raw = wildcardPathOf(params);
  if (raw === undefined || raw === null || raw === '') {
    if (fallback !== null) return fallback;
    throw pathEscape('缺少文件路径');
  }
  return normalizeFilePath(raw);
}

/** 当前用户拥有的站点；不存在 404，跨用户一律 403。 */
function ownedSite(userId, siteId) {
  const site = store().get('sites')[siteId];
  if (!site) throw new CoreError(codes.NOT_FOUND, '站点不存在', { status: 404 });
  if (site.ownerId !== userId) throw new CoreError(codes.FORBIDDEN, '无权访问其他用户的站点', { status: 403 });
  return site;
}

function siteSummary(site) {
  const files = site.files && typeof site.files === 'object' ? site.files : {};
  const versions = Array.isArray(site.versions) ? site.versions : [];
  const latest = versions.length > 0 ? versions[versions.length - 1].version : null;
  return {
    id: site.id,
    ownerId: site.ownerId,
    name: site.name,
    slug: site.slug,
    description: site.description || '',
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
    fileCount: Object.keys(files).length,
    publishedVersion: Number.isInteger(site.publishedVersion) ? site.publishedVersion : null,
    latestVersion: latest,
    publicPath: Number.isInteger(site.publishedVersion) ? publicPathFor(site) : null
  };
}

function siteDetail(site) {
  const files = site.files && typeof site.files === 'object' ? site.files : {};
  const versions = Array.isArray(site.versions) ? site.versions : [];
  return {
    ...siteSummary(site),
    files: Object.keys(files).sort().map((filePath) => ({
      path: filePath,
      size: files[filePath].size,
      contentType: files[filePath].contentType,
      updatedAt: files[filePath].updatedAt
    })),
    versions: versions.slice().sort((a, b) => b.version - a.version).map((version) => ({
      version: version.version,
      contentHash: version.contentHash,
      fileCount: version.fileCount,
      bytes: version.bytes,
      createdAt: version.createdAt,
      isPublished: version.version === site.publishedVersion
    })),
    aiConfigured: Boolean(state.adapter),
    lastRollback: site.lastRollback || null
  };
}

function publicPathFor(site) {
  return `${state.config.publicBasePath}/${site.slug}/`;
}

function listSitesFor(userId) {
  return store().list('sites')
    .filter((site) => site.ownerId === userId)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map(siteSummary);
}

function uniqueSlug(name) {
  const base = slugify(name);
  for (let i = 0; i < 20; i++) {
    const candidate = `${base.slice(0, 48)}-${crypto.randomBytes(3).toString('hex')}`;
    if (!store().has('slugs', candidate)) return candidate;
  }
  throw new CoreError(codes.CONFLICT, '无法生成唯一 slug，请显式指定', { status: 409 });
}

function createSiteFor(userId, body) {
  const st = store();
  const owned = st.list('sites').filter((site) => site.ownerId === userId).length;
  if (owned >= state.config.maxSitesPerUser) {
    throw new CoreError('pages.site_limit_reached', `站点数量已达上限（${state.config.maxSitesPerUser}）`, { status: 409 });
  }

  const name = requireText(body.name, 'name', { min: 1, max: 80 });
  const description = optionalDescription(body.description) || '';
  const slug = body.slug === undefined || body.slug === null ? uniqueSlug(name) : normalizeSlug(body.slug);
  if (st.has('slugs', slug)) {
    throw new CoreError('pages.slug_taken', 'slug 已被占用', { status: 409 });
  }

  const now = nowIso();
  const site = {
    id: crypto.randomUUID(),
    ownerId: userId,
    name,
    slug,
    description,
    createdAt: now,
    updatedAt: now,
    files: {},
    versions: [],
    nextVersion: 1,
    publishedVersion: null
  };
  st.put('sites', site.id, site);
  st.put('slugs', slug, site.id);
  return siteDetail(site);
}

function getSiteFor(userId, siteId) {
  return siteDetail(ownedSite(userId, siteId));
}

function updateSiteFor(userId, siteId, body) {
  const st = store();
  const site = ownedSite(userId, siteId);
  const patch = { updatedAt: nowIso() };
  let touched = false;

  if (body.name !== undefined) {
    patch.name = requireText(body.name, 'name', { min: 1, max: 80 });
    touched = true;
  }
  if (body.description !== undefined) {
    patch.description = optionalDescription(body.description) || '';
    touched = true;
  }
  if (body.slug !== undefined) {
    const slug = normalizeSlug(body.slug);
    if (slug !== site.slug) {
      const holder = st.get('slugs')[slug];
      if (holder && holder !== site.id) {
        throw new CoreError('pages.slug_taken', 'slug 已被占用', { status: 409 });
      }
      patch.slug = slug;
      touched = true;
    }
  }
  if (!touched) {
    throw new CoreError(codes.INVALID_INPUT, '没有可更新的字段（name/description/slug）', { status: 400 });
  }

  const updated = st.update('sites', site.id, patch);
  if (patch.slug && patch.slug !== site.slug) {
    st.put('slugs', patch.slug, site.id);
    st.remove('slugs', site.slug);
  }
  return siteDetail(updated);
}

function deleteSiteFor(userId, siteId) {
  const st = store();
  const site = ownedSite(userId, siteId);
  st.remove('sites', site.id);
  if (st.get('slugs')[site.slug] === site.id) st.remove('slugs', site.slug);
  for (const run of st.list('aiRuns')) {
    if (run && run.siteId === site.id) st.remove('aiRuns', run.id);
  }
  return { ok: true, id: site.id };
}

function listFilesFor(userId, siteId) {
  const site = ownedSite(userId, siteId);
  const files = site.files && typeof site.files === 'object' ? site.files : {};
  return {
    siteId: site.id,
    files: Object.keys(files).sort().map((filePath) => ({
      path: filePath,
      size: files[filePath].size,
      contentType: files[filePath].contentType,
      updatedAt: files[filePath].updatedAt
    }))
  };
}

function readFileFor(userId, siteId, filePath) {
  const site = ownedSite(userId, siteId);
  const target = normalizeFilePath(filePath);
  const files = site.files && typeof site.files === 'object' ? site.files : {};
  const file = files[target];
  if (!file) throw new CoreError('pages.file_not_found', '文件不存在', { status: 404 });
  return {
    siteId: site.id,
    file: { path: target, content: file.content, contentType: file.contentType, size: file.size, updatedAt: file.updatedAt }
  };
}

function writeFileFor(userId, siteId, filePath, body) {
  const st = store();
  const site = ownedSite(userId, siteId);
  const target = normalizeFilePath(filePath);
  if (typeof body.content !== 'string') {
    throw new CoreError(codes.INVALID_INPUT, 'content 必须是字符串', { status: 400 });
  }
  const content = body.content;
  const size = Buffer.byteLength(content, 'utf8');
  if (size > state.config.maxFileBytes) {
    throw new CoreError('pages.file_too_large', `文件超过上限（${state.config.maxFileBytes} 字节）`, { status: 400 });
  }

  const files = cloneFiles(site.files);
  const created = !files[target];
  if (created && Object.keys(files).length >= state.config.maxFilesPerSite) {
    throw new CoreError('pages.file_limit_reached', `文件数量已达上限（${state.config.maxFilesPerSite}）`, { status: 409 });
  }
  const contentType = contentTypeFor(target, body.contentType);
  const now = nowIso();
  const file = { content, contentType, size, updatedAt: now };
  files[target] = file;
  st.update('sites', site.id, { files, updatedAt: now });
  return { siteId: site.id, created, file: { path: target, ...file } };
}

function deleteFileFor(userId, siteId, filePath) {
  const st = store();
  const site = ownedSite(userId, siteId);
  const target = normalizeFilePath(filePath);
  const files = cloneFiles(site.files);
  if (!files[target]) throw new CoreError('pages.file_not_found', '文件不存在', { status: 404 });
  delete files[target];
  st.update('sites', site.id, { files, updatedAt: nowIso() });
  return { ok: true, siteId: site.id, path: target, fileCount: Object.keys(files).length };
}

// ---------------------------------------------------------------------------
// 发布、版本与公开访问
// ---------------------------------------------------------------------------

function cloneFiles(files) {
  const out = {};
  for (const [filePath, file] of Object.entries(files || {})) {
    out[filePath] = {
      content: file.content,
      contentType: file.contentType,
      size: file.size,
      updatedAt: file.updatedAt
    };
  }
  return out;
}

function totalBytes(files) {
  return Object.values(files).reduce((sum, file) => sum + (Number.isFinite(file.size) ? file.size : 0), 0);
}

/** 稳定内容哈希：按路径排序，带长度与类型分隔，避免拼接歧义。 */
function hashFiles(files) {
  const hash = crypto.createHash('sha256');
  for (const filePath of Object.keys(files).sort()) {
    const file = files[filePath];
    hash.update(filePath);
    hash.update('\u0000');
    hash.update(file.contentType || '');
    hash.update('\u0000');
    hash.update(String(Buffer.byteLength(file.content, 'utf8')));
    hash.update('\u0000');
    hash.update(file.content);
    hash.update('\u0001');
  }
  return hash.digest('hex');
}

function publishFor(userId, siteId) {
  const st = store();
  const site = ownedSite(userId, siteId);
  const files = cloneFiles(site.files);
  const contentHash = hashFiles(files);
  const version = Number.isInteger(site.nextVersion) && site.nextVersion > 0
    ? site.nextVersion
    : (Array.isArray(site.versions) && site.versions.length > 0 ? site.versions[site.versions.length - 1].version + 1 : 1);
  const snapshot = {
    version,
    contentHash,
    createdAt: nowIso(),
    fileCount: Object.keys(files).length,
    bytes: totalBytes(files),
    files
  };
  const versions = (Array.isArray(site.versions) ? site.versions : []).concat(snapshot);
  while (versions.length > state.config.maxVersions) versions.shift();

  const updated = st.update('sites', site.id, {
    versions,
    nextVersion: version + 1,
    publishedVersion: version,
    updatedAt: snapshot.createdAt
  });
  return {
    siteId: site.id,
    version,
    contentHash,
    fileCount: snapshot.fileCount,
    bytes: snapshot.bytes,
    publishedAt: snapshot.createdAt,
    publicPath: publicPathFor(updated)
  };
}

function listVersionsFor(userId, siteId) {
  const site = ownedSite(userId, siteId);
  const versions = Array.isArray(site.versions) ? site.versions : [];
  return {
    siteId: site.id,
    publishedVersion: Number.isInteger(site.publishedVersion) ? site.publishedVersion : null,
    versions: versions.slice().sort((a, b) => b.version - a.version).map((version) => ({
      version: version.version,
      contentHash: version.contentHash,
      fileCount: version.fileCount,
      bytes: version.bytes,
      createdAt: version.createdAt,
      isPublished: version.version === site.publishedVersion
    }))
  };
}

function parseVersionNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CoreError(codes.INVALID_INPUT, 'version 必须是正整数', { status: 400 });
  }
  return value;
}

/**
 * 回滚：把工作文件与公开版本指针同时恢复到目标快照。
 * 不创建新版本，避免把「回滚」伪装成一次新发布；lastRollback 留痕。
 */
function rollbackFor(userId, siteId, body) {
  const st = store();
  const site = ownedSite(userId, siteId);
  const versions = Array.isArray(site.versions) ? site.versions : [];
  if (versions.length === 0) {
    throw new CoreError('pages.no_previous_version', '站点还没有任何发布版本', { status: 409 });
  }

  let target = null;
  if (body.version !== undefined) {
    target = versions.find((version) => version.version === parseVersionNumber(body.version)) || null;
    if (!target) throw new CoreError('pages.version_not_found', '目标版本不存在', { status: 404 });
  } else {
    if (!Number.isInteger(site.publishedVersion)) {
      throw new CoreError('pages.no_previous_version', '站点尚未发布，无可回滚版本', { status: 409 });
    }
    const earlier = versions
      .filter((version) => version.version < site.publishedVersion)
      .sort((a, b) => a.version - b.version);
    if (earlier.length === 0) {
      throw new CoreError('pages.no_previous_version', '当前已是首个发布版本，没有更早版本可回滚', { status: 409 });
    }
    target = earlier[earlier.length - 1];
  }

  const from = Number.isInteger(site.publishedVersion) ? site.publishedVersion : null;
  const files = cloneFiles(target.files);
  const at = nowIso();
  const updated = st.update('sites', site.id, {
    files,
    publishedVersion: target.version,
    updatedAt: at,
    lastRollback: { from, to: target.version, at }
  });
  return {
    siteId: site.id,
    rolledBackTo: target.version,
    from,
    contentHash: target.contentHash,
    restoredFiles: Object.keys(files).length,
    publicPath: publicPathFor(updated)
  };
}

function findSiteBySlug(slug) {
  const st = store();
  const siteId = st.get('slugs')[slug];
  if (siteId && st.has('sites', siteId)) return st.get('sites')[siteId];
  // 索引缺失/损坏时按业务字段兜底修复，不把「索引缺失」当成站点不存在。
  const site = st.list('sites').find((candidate) => candidate && candidate.slug === slug) || null;
  if (site) st.put('slugs', slug, site.id);
  return site;
}

/**
 * 公开只读访问：只读 slug/路径/查询参数，明确不读取 ctx.user，也不返回 ownerId。
 * 默认返回结构化 JSON；?raw=1 返回原始文本，便于 dev.js 直接当作静态站点预览。
 */
function publicReadFor(slug, rawPath, query) {
  const st = store();
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new CoreError('pages.site_not_found', '站点不存在', { status: 404 });
  }
  const site = findSiteBySlug(slug);
  if (!site) throw new CoreError('pages.site_not_found', '站点不存在', { status: 404 });
  if (!Number.isInteger(site.publishedVersion)) {
    throw new CoreError('pages.not_published', '站点尚未发布', { status: 404 });
  }
  const versions = Array.isArray(site.versions) ? site.versions : [];
  const snapshot = versions.find((version) => version.version === site.publishedVersion);
  if (!snapshot || !snapshot.files) {
    throw new CoreError('pages.snapshot_missing', '发布快照缺失，无法提供公开访问', { status: 500 });
  }

  const requested = rawPath === undefined || rawPath === null || rawPath === '' ? 'index.html' : rawPath;
  const target = normalizeFilePath(requested);
  const file = snapshot.files[target];
  if (!file) throw new CoreError('pages.file_not_found', '文件不存在', { status: 404 });

  const contentType = safeContentType(target, file.contentType);
  const raw = Boolean(query && (query.raw === '1' || query.raw === 'true'));
  if (raw) {
    return {
      status: 200,
      body: file.content,
      headers: {
        'content-type': contentType,
        'x-content-type-options': 'nosniff',
        'content-security-policy': PUBLIC_CSP,
        'cache-control': 'no-cache'
      }
    };
  }
  return {
    status: 200,
    body: {
      site: { slug: site.slug, name: site.name },
      path: target,
      content: file.content,
      contentType,
      size: file.size,
      version: snapshot.version,
      contentHash: snapshot.contentHash,
      publishedAt: snapshot.createdAt
    }
  };
}

// ---------------------------------------------------------------------------
// AI 修改（可插拔适配器；未配置时不伪造结果）
// ---------------------------------------------------------------------------

function callAdapter(adapter, payload) {
  if (typeof adapter === 'function') return adapter(payload);
  if (adapter && typeof adapter.generate === 'function') return adapter.generate(payload);
  if (adapter && typeof adapter.modify === 'function') return adapter.modify(payload);
  throw new CoreError('pages.ai_not_configured', 'AI 适配器不可用', { status: 409 });
}

async function invokeAdapter(adapter, payload, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error('AI 适配器调用超时');
      err.code = 'PAGES_AI_TIMEOUT';
      reject(err);
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([Promise.resolve().then(() => callAdapter(adapter, payload)), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 归一化适配器返回值。只接受明确的文件内容，绝不从模型自由文本里猜业务结果。
 * 支持：
 *   { files: { "index.html": "内容" | { content, contentType } }, summary? }
 *   { content: "内容", path?: "index.html", summary? }   // 需有目标路径
 *   直接返回字符串时也必须有目标路径（body.path）。
 */
function normalizeAiResult(result, targetPath) {
  if (typeof result === 'string') {
    if (!targetPath) return null;
    return { files: { [targetPath]: { content: result } }, summary: null };
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;

  let rawFiles = result.files;
  if (!rawFiles && typeof result.content === 'string') {
    const single = result.path || targetPath;
    if (!single) return null;
    rawFiles = { [single]: result.content };
  }
  if (!rawFiles || typeof rawFiles !== 'object' || Array.isArray(rawFiles)) return null;

  const files = {};
  for (const [filePath, value] of Object.entries(rawFiles)) {
    if (typeof value === 'string') {
      files[filePath] = { content: value };
    } else if (value && typeof value === 'object' && typeof value.content === 'string') {
      files[filePath] = { content: value.content, contentType: value.contentType };
    } else {
      return null;
    }
  }
  if (Object.keys(files).length === 0) return null;
  return {
    files,
    summary: typeof result.summary === 'string' ? result.summary.slice(0, 500) : null
  };
}

async function aiModifyFor(userId, siteId, body) {
  const st = store();
  const site = ownedSite(userId, siteId);
  if (!state.adapter) {
    throw new CoreError('pages.ai_not_configured', 'AI 适配器未配置：需要宿主注入 config.aiAdapter 后才能修改站点', { status: 409 });
  }

  const prompt = requireText(body.prompt, 'prompt', { min: 1, max: 4000 });
  const targetPath = body.path === undefined || body.path === null || body.path === ''
    ? null
    : normalizeFilePath(body.path);

  const currentFiles = {};
  for (const [filePath, file] of Object.entries(site.files || {})) currentFiles[filePath] = file.content;

  let raw;
  try {
    raw = await invokeAdapter(state.adapter, {
      prompt,
      targetPath,
      site: { id: site.id, slug: site.slug, name: site.name },
      files: currentFiles,
      user: { id: userId }
    }, state.config.aiTimeoutMs);
  } catch (err) {
    if (err && err.code === 'PAGES_AI_TIMEOUT') {
      throw new CoreError('pages.ai_timeout', 'AI 适配器调用超时', { status: 504 });
    }
    log('warn', 'AI 适配器调用失败');
    throw new CoreError('pages.ai_failed', 'AI 适配器调用失败', { status: 502 });
  }

  const normalized = normalizeAiResult(raw, targetPath);
  if (!normalized) {
    throw new CoreError('pages.ai_invalid_result', 'AI 适配器未返回可识别的文件修改', { status: 502 });
  }

  // 先完整校验，再一次性写入；不能让一半合法、一半非法的结果落盘。
  const pending = {};
  const existing = site.files && typeof site.files === 'object' ? site.files : {};
  const existingPaths = new Set(Object.keys(existing));
  for (const [rawFilePath, item] of Object.entries(normalized.files)) {
    const filePath = normalizeFilePath(rawFilePath);
    const size = Buffer.byteLength(item.content, 'utf8');
    if (size > state.config.maxFileBytes) {
      throw new CoreError('pages.ai_invalid_result', `AI 结果文件超过上限：${filePath}`, { status: 502 });
    }
    const contentType = contentTypeFor(filePath, item.contentType);
    pending[filePath] = { content: item.content, contentType, size };
    if (!existingPaths.has(filePath)) existingPaths.add(filePath);
  }
  if (existingPaths.size > state.config.maxFilesPerSite) {
    throw new CoreError('pages.ai_invalid_result', 'AI 结果会使文件数量超限', { status: 502 });
  }

  const nextFiles = cloneFiles(existing);
  const changed = [];
  for (const [filePath, item] of Object.entries(pending)) {
    const previous = nextFiles[filePath];
    if (previous && previous.content === item.content && previous.contentType === item.contentType) continue;
    nextFiles[filePath] = {
      content: item.content,
      contentType: item.contentType,
      size: item.size,
      updatedAt: nowIso()
    };
    changed.push({ path: filePath, size: item.size, created: !previous });
  }
  if (changed.length === 0) {
    throw new CoreError('pages.ai_invalid_result', 'AI 适配器没有产生实际文件变更', { status: 502 });
  }

  const at = nowIso();
  st.update('sites', site.id, { files: nextFiles, updatedAt: at });
  const runId = crypto.randomUUID();
  st.put('aiRuns', runId, {
    id: runId,
    siteId: site.id,
    ownerId: userId,
    promptPreview: prompt.slice(0, 200),
    changedFiles: changed.map((item) => item.path),
    summary: normalized.summary,
    createdAt: at
  });

  return {
    siteId: site.id,
    summary: normalized.summary,
    changedFiles: changed,
    publishedVersion: Number.isInteger(site.publishedVersion) ? site.publishedVersion : null,
    requiresPublish: true,
    note: 'AI 修改只写入工作文件；公开访问仍使用最近一次发布快照，需显式发布后生效。'
  };
}

// ---------------------------------------------------------------------------
// 路由 handler 包装：统一 {status, body} 与错误映射
// ---------------------------------------------------------------------------

function errorResult(err) {
  if (err instanceof CoreError) {
    const body = { code: err.code, message: err.message };
    if (err.details && err.status < 500) body.details = err.details;
    return { status: err.status, body };
  }
  log('error', `未处理异常：${err && err.name ? err.name : 'Error'}`);
  return { status: 500, body: { code: 'INTERNAL', message: '内部错误' } };
}

function wrap(fn, platformMethod = null) {
  return async function handler(ctx) {
    if (state.platform && platformMethod) return state.platform.handle(platformMethod, ctx);
    if (state.platform) return { status: 404, body: { code: 'NOT_FOUND', message: '接口不存在' } };
    try {
      return await fn(ctx);
    } catch (err) {
      return errorResult(err);
    }
  };
}

const legacyFallbacks = {
  info: async () => ({ status: 200, body: { module: MODULE_ID, version: MODULE_VERSION, ready: state.ready, aiConfigured: Boolean(state.adapter), publicBasePath: state.config ? state.config.publicBasePath : DEFAULT_PUBLIC_BASE, storage: state.config && state.config.dataFile ? 'file' : 'memory' } }),
  listSites: async (ctx) => { const user = requireUser(ctx); return { status: 200, body: { sites: listSitesFor(user.id) } }; },
  createSite: async (ctx) => { const user = requireUser(ctx, { write: true }); return { status: 201, body: { site: createSiteFor(user.id, bodyOf(ctx)) } }; },
  getSite: async (ctx) => { const user = requireUser(ctx); return { status: 200, body: { site: getSiteFor(user.id, siteIdOf(paramsOf(ctx))) } }; },
  updateSite: async (ctx) => { const user = requireUser(ctx, { write: true }); return { status: 200, body: { site: updateSiteFor(user.id, siteIdOf(paramsOf(ctx)), bodyOf(ctx)) } }; },
  deleteSite: async (ctx) => { const user = requireUser(ctx, { write: true }); return { status: 200, body: deleteSiteFor(user.id, siteIdOf(paramsOf(ctx))) }; },
  listFiles: async (ctx) => { const user = requireUser(ctx); return { status: 200, body: listFilesFor(user.id, siteIdOf(paramsOf(ctx))) }; },
  readFile: async (ctx) => { const user = requireUser(ctx); const params = paramsOf(ctx); return { status: 200, body: readFileFor(user.id, siteIdOf(params), filePathOf(params)) }; },
  writeFile: async (ctx) => { const user = requireUser(ctx, { write: true }); const params = paramsOf(ctx); return { status: 200, body: writeFileFor(user.id, siteIdOf(params), filePathOf(params), bodyOf(ctx)) }; },
  deleteFile: async (ctx) => { const user = requireUser(ctx, { write: true }); const params = paramsOf(ctx); return { status: 200, body: deleteFileFor(user.id, siteIdOf(params), filePathOf(params)) }; },
  publish: async (ctx) => { const user = requireUser(ctx, { write: true }); return { status: 201, body: publishFor(user.id, siteIdOf(paramsOf(ctx))) }; },
  listVersions: async (ctx) => { const user = requireUser(ctx); return { status: 200, body: listVersionsFor(user.id, siteIdOf(paramsOf(ctx))) }; },
  rollback: async (ctx) => { const user = requireUser(ctx, { write: true }); const params = paramsOf(ctx); return { status: 200, body: rollbackFor(user.id, siteIdOf(params), bodyOf(ctx)) }; },
  startTask: async (ctx) => { const user = requireUser(ctx, { write: true }); const params = paramsOf(ctx); return { status: 200, body: await aiModifyFor(user.id, siteIdOf(params), bodyOf(ctx)) }; },
  servePublic: async (ctx) => { const params = paramsOf(ctx); return publicReadFor(params.slug, wildcardPathOf(params), queryOf(ctx)); }
};

const modernRoutes = [
  { method: 'GET', path: '/api/pages/info', handler: wrap(legacyFallbacks.info, 'info') },
  { method: 'GET', path: '/api/pages/sites', handler: wrap(legacyFallbacks.listSites, 'listSites') },
  { method: 'POST', path: '/api/pages/sites', handler: wrap(legacyFallbacks.createSite, 'createSite') },
  { method: 'GET', path: '/api/pages/sites/:siteId', handler: wrap(legacyFallbacks.getSite, 'getSite') },
  { method: 'PATCH', path: '/api/pages/sites/:siteId', handler: wrap(legacyFallbacks.updateSite, 'updateSite') },
  { method: 'DELETE', path: '/api/pages/sites/:siteId', handler: wrap(legacyFallbacks.deleteSite, 'deleteSite') },
  { method: 'GET', path: '/api/pages/sites/:siteId/files', handler: wrap(legacyFallbacks.listFiles, 'listFiles') },
  { method: 'GET', path: '/api/pages/sites/:siteId/files/*', handler: wrap(legacyFallbacks.readFile, 'readFile') },
  { method: 'PUT', path: '/api/pages/sites/:siteId/files/*', transport: { kind: 'json', maxBytes: 16 * 1024 * 1024 }, handler: wrap(legacyFallbacks.writeFile, 'writeFile') },
  { method: 'DELETE', path: '/api/pages/sites/:siteId/files/*', handler: wrap(legacyFallbacks.deleteFile, 'deleteFile') },
  { method: 'POST', path: '/api/pages/sites/:siteId/publish', handler: wrap(legacyFallbacks.publish, 'publish') },
  { method: 'GET', path: '/api/pages/sites/:siteId/versions', handler: wrap(legacyFallbacks.listVersions, 'listVersions') },
  { method: 'POST', path: '/api/pages/sites/:siteId/rollback', handler: wrap(legacyFallbacks.rollback, 'rollback') },
  { method: 'POST', path: '/api/pages/sites/:siteId/ai', transport: { kind: 'json', maxBytes: 128 * 1024 }, handler: wrap(legacyFallbacks.startTask, 'startTask') },
  { method: 'GET', path: '/api/pages/public/:slug/*', handler: wrap(legacyFallbacks.servePublic, 'servePublic') },
  { method: 'GET', path: '/api/pages/models', handler: wrap(null, 'listModels') },
  { method: 'GET', path: '/api/pages/admin/models', handler: wrap(null, 'adminListModels') },
  { method: 'PUT', path: '/api/pages/admin/models/:modelId', handler: wrap(null, 'adminPutModel') },
  { method: 'DELETE', path: '/api/pages/admin/models/:modelId', handler: wrap(null, 'adminDeleteModel') },
  { method: 'GET', path: '/api/pages/tasks', handler: wrap(null, 'listTasks') },
  { method: 'GET', path: '/api/pages/tasks/:taskId', handler: wrap(null, 'getTask') },
  { method: 'GET', path: '/api/pages/tasks/:taskId/artifact', handler: wrap(null, 'downloadArtifact') },
  { method: 'POST', path: '/api/pages/tasks/:taskId/cancel', handler: wrap(null, 'cancelTask') },
  { method: 'GET', path: '/api/pages/tasks/:taskId/events', transport: { kind: 'sse', heartbeatMs: 10000, timeoutMs: 3600000 }, handler: wrap(null, 'taskEvents') },
  { method: 'GET', path: '/api/pages/sites/:siteId/materials', handler: wrap(null, 'listMaterials') },
  { method: 'PUT', path: '/api/pages/sites/:siteId/materials/*', transport: { kind: 'upload', maxBytes: 100 * 1024 * 1024, accepts: ['application/octet-stream'], cancellation: 'propagate' }, handler: wrap(null, 'uploadMaterial') },
  { method: 'GET', path: '/api/pages/sites/:siteId/materials/*', handler: wrap(null, 'readMaterial') },
  { method: 'GET', path: '/api/pages/preview/:siteId/:token/*', handler: wrap(null, 'servePreview') },
  { method: 'POST', path: '/api/pages/sites/:siteId/backend', transport: { kind: 'json', maxBytes: 512 * 1024 }, handler: wrap(null, 'deployBackend') },
  { method: 'GET', path: '/api/pages/sites/:siteId/backend', handler: wrap(null, 'getBackend') },
  { method: 'POST', path: '/api/pages/sites/:siteId/backend/stop', handler: wrap(null, 'stopBackend') },
  { method: 'POST', path: '/api/pages/sites/:siteId/backend/start', handler: wrap(null, 'startBackend') },
  { method: 'GET', path: '/api/pages/tenant/:siteId/*', handler: wrap(null, 'proxyBackend') },
  { method: 'POST', path: '/api/pages/tenant/:siteId/*', transport: { kind: 'upload', maxBytes: 1024 * 1024, cancellation: 'propagate' }, handler: wrap(null, 'proxyBackend') },
  { method: 'PUT', path: '/api/pages/tenant/:siteId/*', transport: { kind: 'upload', maxBytes: 1024 * 1024, cancellation: 'propagate' }, handler: wrap(null, 'proxyBackend') },
  { method: 'PATCH', path: '/api/pages/tenant/:siteId/*', transport: { kind: 'upload', maxBytes: 1024 * 1024, cancellation: 'propagate' }, handler: wrap(null, 'proxyBackend') },
  { method: 'DELETE', path: '/api/pages/tenant/:siteId/*', transport: { kind: 'upload', maxBytes: 1024 * 1024, cancellation: 'propagate' }, handler: wrap(null, 'proxyBackend') }
];

const routes = [
  ...modernRoutes,
  {
    // 公开模块信息：不涉及业务数据，供未登录的控制台探测模块能力。
    method: 'GET',
    path: '/api/pages/info',
    handler: wrap(async () => ({
      status: 200,
      body: {
        module: MODULE_ID,
        version: MODULE_VERSION,
        ready: state.ready,
        aiConfigured: Boolean(state.adapter),
        publicBasePath: state.config ? state.config.publicBasePath : DEFAULT_PUBLIC_BASE,
        storage: state.config && state.config.dataFile ? 'file' : 'memory'
      }
    }))
  },
  {
    method: 'GET',
    path: '/api/pages/sites',
    handler: wrap(async (ctx) => {
      const user = requireUser(ctx);
      return { status: 200, body: { sites: listSitesFor(user.id) } };
    })
  },
  {
    method: 'POST',
    path: '/api/pages/sites',
    handler: wrap(async (ctx) => {
      const user = requireUser(ctx, { write: true });
      return { status: 201, body: { site: createSiteFor(user.id, bodyOf(ctx)) } };
    })
  },
  {
    method: 'GET',
    path: '/api/pages/sites/:siteId',
    handler: wrap(async (ctx) => {
      const user = requireUser(ctx);
      return { status: 200, body: { site: getSiteFor(user.id, siteIdOf(paramsOf(ctx))) } };
    })
  },
  {
    method: 'PATCH',
    path: '/api/pages/sites/:siteId',
    handler: wrap(async (ctx) => {
      const user = requireUser(ctx, { write: true });
      return { status: 200, body: { site: updateSiteFor(user.id, siteIdOf(paramsOf(ctx)), bodyOf(ctx)) } };
    })
  },
  {
    method: 'DELETE',
    path: '/api/pages/sites/:siteId',
    handler: wrap(async (ctx) => {
      const user = requireUser(ctx, { write: true });
      return { status: 200, body: deleteSiteFor(user.id, siteIdOf(paramsOf(ctx))) };
    })
  },
  {
    method: 'GET',
    path: '/api/pages/sites/:siteId/files',
    handler: wrap(async (ctx) => {
      const user = requireUser(ctx);
      return { status: 200, body: listFilesFor(user.id, siteIdOf(paramsOf(ctx))) };
    })
  },
  {
    method: 'GET',
    path: '/api/pages/sites/:siteId/files/*',
    handler: wrap(async (ctx) => {
      const user = requireUser(ctx);
      const params = paramsOf(ctx);
      return { status: 200, body: readFileFor(user.id, siteIdOf(params), filePathOf(params)) };
    })
  },
  {
    method: 'PUT',
    path: '/api/pages/sites/:siteId/files/*',
    handler: wrap(async (ctx) => {
      const user = requireUser(ctx, { write: true });
      const params = paramsOf(ctx);
      return { status: 200, body: writeFileFor(user.id, siteIdOf(params), filePathOf(params), bodyOf(ctx)) };
    })
  },
  {
    method: 'DELETE',
    path: '/api/pages/sites/:siteId/files/*',
    handler: wrap(async (ctx) => {
      const user = requireUser(ctx, { write: true });
      const params = paramsOf(ctx);
      return { status: 200, body: deleteFileFor(user.id, siteIdOf(params), filePathOf(params)) };
    })
  },
  {
    method: 'POST',
    path: '/api/pages/sites/:siteId/publish',
    handler: wrap(async (ctx) => {
      const user = requireUser(ctx, { write: true });
      return { status: 201, body: publishFor(user.id, siteIdOf(paramsOf(ctx))) };
    })
  },
  {
    method: 'GET',
    path: '/api/pages/sites/:siteId/versions',
    handler: wrap(async (ctx) => {
      const user = requireUser(ctx);
      return { status: 200, body: listVersionsFor(user.id, siteIdOf(paramsOf(ctx))) };
    })
  },
  {
    method: 'POST',
    path: '/api/pages/sites/:siteId/rollback',
    handler: wrap(async (ctx) => {
      const user = requireUser(ctx, { write: true });
      const params = paramsOf(ctx);
      return { status: 200, body: rollbackFor(user.id, siteIdOf(params), bodyOf(ctx)) };
    })
  },
  {
    method: 'POST',
    path: '/api/pages/sites/:siteId/ai',
    handler: wrap(async (ctx) => {
      const user = requireUser(ctx, { write: true });
      const params = paramsOf(ctx);
      return { status: 200, body: await aiModifyFor(user.id, siteIdOf(params), bodyOf(ctx)) };
    })
  },
  {
    // 公开只读访问：不调用 requireUser，也不读取 ctx.user。
    method: 'GET',
    path: '/api/pages/public/:slug/*',
    handler: wrap(async (ctx) => {
      const params = paramsOf(ctx);
      return publicReadFor(params.slug, wildcardPathOf(params), queryOf(ctx));
    })
  }
];

// ---------------------------------------------------------------------------
// 对 Glim 开放的工具（与 manifest.capabilities.tools 一一对应）
// ---------------------------------------------------------------------------

/** 工具只信任调用方传入的已认证上下文，绝不接受模型参数里的 userId。 */
function toolUserId(context) {
  if (context && context.user && typeof context.user.id === 'string' && context.user.id.length > 0) {
    return context.user.id;
  }
  if (context && typeof context.userId === 'string' && context.userId.length > 0) {
    return context.userId;
  }
  throw new CoreError(codes.FORBIDDEN, '工具调用缺少可信用户上下文', { status: 403 });
}

const tools = {
  async pages_list_sites(input = {}, context = {}) {
    const userId = toolUserId(context);
    return { sites: listSitesFor(userId) };
  },

  async pages_read_site(input = {}, context = {}) {
    const userId = toolUserId(context);
    const siteId = requireText(input.siteId, 'siteId', { min: 1, max: 128 });
    return { site: getSiteFor(userId, siteId) };
  },

  async pages_create_site(input = {}, context = {}) {
    const userId = toolUserId(context);
    return { site: createSiteFor(userId, { name: input.name, slug: input.slug, description: input.description }) };
  },

  async pages_read_file(input = {}, context = {}) {
    const userId = toolUserId(context);
    const siteId = requireText(input.siteId, 'siteId', { min: 1, max: 128 });
    return readFileFor(userId, siteId, input.path);
  },

  async pages_write_file(input = {}, context = {}) {
    const userId = toolUserId(context);
    const siteId = requireText(input.siteId, 'siteId', { min: 1, max: 128 });
    return writeFileFor(userId, siteId, input.path, {
      content: input.content,
      contentType: input.contentType
    });
  },

  async pages_delete_file(input = {}, context = {}) {
    const userId = toolUserId(context);
    const siteId = requireText(input.siteId, 'siteId', { min: 1, max: 128 });
    return deleteFileFor(userId, siteId, input.path);
  },

  async pages_publish_site(input = {}, context = {}) {
    const userId = toolUserId(context);
    const siteId = requireText(input.siteId, 'siteId', { min: 1, max: 128 });
    return publishFor(userId, siteId);
  },

  async pages_ai_modify(input = {}, context = {}) {
    const userId = toolUserId(context);
    const siteId = requireText(input.siteId, 'siteId', { min: 1, max: 128 });
    return aiModifyFor(userId, siteId, { prompt: input.prompt, path: input.path });
  }
};

module.exports = { start, stop, health, routes, tools };
