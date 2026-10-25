'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { CoreError, codes } = require('../../../core/errors.js');
const { PagesRepository } = require('./repository.js');
const { TaskManager, TERMINAL } = require('./task-manager.js');
const { BackendManager } = require('./backend-manager.js');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.pdf': 'application/pdf', '.zip': 'application/zip'
});
const PREVIEW_CSP = "sandbox allow-scripts; default-src 'self' data: blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'";
const PUBLIC_CSP = "sandbox allow-scripts; default-src 'self' data: blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'";

function error(code, message, status = 400, details = null) { return new CoreError(code, message, { status, details }); }
function text(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim()) throw error(codes.INVALID_INPUT, `${name} 不能为空`);
  const result = value.trim();
  if (result.length > max) throw error(codes.INVALID_INPUT, `${name} 超过 ${max} 字符`);
  return result;
}
function normalizePath(raw, fallback = null) {
  if ((raw === undefined || raw === null || raw === '') && fallback) return fallback;
  if (typeof raw !== 'string') throw error(codes.PATH_ESCAPE, '文件路径必须是字符串');
  let value = raw;
  try {
    for (let i = 0; i < 2 && /%[0-9a-f]{2}/i.test(value); i++) value = decodeURIComponent(value);
  } catch { throw error(codes.PATH_ESCAPE, '文件路径包含非法转义'); }
  if (!value || value.length > 300 || /[\u0000-\u001f\u007f\\]/.test(value) || value.startsWith('/') || /^[a-z]:/i.test(value)) {
    throw error(codes.PATH_ESCAPE, '文件路径越界或包含非法字符');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part !== part.trim())) throw error(codes.PATH_ESCAPE, '文件路径包含非法路径段');
  if (!Object.prototype.hasOwnProperty.call(MIME, path.posix.extname(value).toLowerCase())) throw error('pages.unsupported_file_type', '不支持的文件类型');
  return value;
}
function contentType(filePath, requested = null) {
  if (requested && /^[a-z0-9][\w!#$&^_.+-]*\/[a-z0-9][\w!#$&^_.+-]*(?:;\s*charset=[\w-]+)?$/i.test(requested) && !/[\r\n]/.test(requested)) return requested;
  return MIME[path.posix.extname(filePath).toLowerCase()];
}
function slugify(name) {
  const base = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${base.length >= 2 ? base : 'site'}-${crypto.randomBytes(3).toString('hex')}`;
}
function actor(userId) { return { userId, service: 'pages' }; }
function publicModel(model) {
  return { id: model.id, kind: model.kind, baseUrl: model.baseUrl || null, model: model.model || null, keyRef: model.keyRef || null, enabled: model.enabled !== false, sort: model.sort || 0, testOnly: model.kind === 'deterministic-test' };
}
function safeTask(task) {
  if (!task) return null;
  const { files, materials, events, ...record } = task;
  return { ...record, materials: (materials || []).map(({ content, text, ...item }) => item) };
}
function safeBackend(backend) {
  if (!backend) return null;
  const { appSecret, backendSecret, ...safe } = backend;
  return { ...safe, routePath: `/api/pages/tenant/${backend.siteId}/` };
}

class PagesPlatform {
  constructor(options) {
    this.options = options;
    this.runtime = options.runtime;
    this.config = this.normalizeConfig(options.config || {});
    this.logger = options.logger || console;
    this.files = {
      sites: options.fileAdapter({ moduleId: 'pages', regionId: 'pages.sites' }),
      materials: options.fileAdapter({ moduleId: 'pages', regionId: 'pages.materials' }),
      artifacts: options.fileAdapter({ moduleId: 'pages', regionId: 'pages.ai-workspace' }),
      backends: options.fileAdapter({ moduleId: 'pages', regionId: 'pages.backends' })
    };
    this.repository = new PagesRepository({
      db: this.runtime.db, deploymentId: this.runtime.deploymentId,
      allowInitialize: this.config.initialize, clock: options.clock
    });
  }

  normalizeConfig(config) {
    const dataRoot = this.options.runtime.dataRoot;
    return {
      publicBasePath: config.publicBasePath || '/api/pages/public',
      maxFileBytes: config.maxFileBytes || 10 * 1024 * 1024,
      maxFilesPerSite: config.maxFilesPerSite || 200,
      maxSitesPerUser: config.maxSitesPerUser || 20,
      maxVersions: config.maxVersions || 50,
      maxMaterialBytes: config.maxMaterialBytes || 100 * 1024 * 1024,
      maxMaterials: config.maxMaterials || 20,
      taskTimeoutMs: config.taskTimeoutMs || 120000,
      taskTtlMs: config.taskTtlMs || 30 * 24 * 3600 * 1000,
      maxConcurrentTasks: config.maxConcurrentTasks || 2,
      workerMemoryMB: config.workerMemoryMB || 96,
      backendMemoryMB: config.backendMemoryMB || 96,
      backendSourceBytes: config.backendSourceBytes || 256 * 1024,
      backendStartTimeoutMs: config.backendStartTimeoutMs || 5000,
      backendProxyTimeoutMs: config.backendProxyTimeoutMs || 30000,
      tenantMongoUri: (() => {
        const reference = typeof config.tenantMongoKeyRef === 'string' ? config.tenantMongoKeyRef : '';
        if (/^env:[A-Z][A-Z0-9_]*$/.test(reference)) return this.options.env[reference.slice(4)] || null;
        return typeof config.tenantMongoUrl === 'string' && config.tenantMongoUrl ? config.tenantMongoUrl : null;
      })(),
      workerUid: Number.isInteger(config.workerUid) ? config.workerUid : null,
      workerGid: Number.isInteger(config.workerGid) ? config.workerGid : null,
      taskRuntimeRoot: config.taskRuntimeRoot || path.join(dataRoot, 'pages-task-runtime'),
      backendRuntimeRoot: config.backendRuntimeRoot || path.join(dataRoot, 'pages-backend-runtime'),
      initialize: Boolean(this.options.runtime.initialize),
      databaseName: this.runtime.db.databaseName,
      mongodbUri: this.runtime.uri,
      allowTestModel: config.allowTestModel === true && this.options.env.PAGESAI_ALLOW_TEST_MODEL === '1',
      models: Array.isArray(config.models) ? config.models : []
    };
  }

  async start() {
    await fs.promises.mkdir(this.config.taskRuntimeRoot, { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(this.config.backendRuntimeRoot, { recursive: true, mode: 0o700 });
    await this.repository.migrate();
    for (const candidate of this.config.models) {
      const model = this.validateModel(candidate);
      if (!await this.repository.getModel(model.id)) await this.repository.putModel({ ...model, createdAt: this.repository.now(), updatedAt: this.repository.now() });
    }
    this.tasks = new TaskManager({
      repository: this.repository, config: this.config,
      resolveSecret: (reference) => this.resolveSecret(reference),
      onResult: (task, result) => this.commitTaskResult(task, result), logger: this.logger
    });
    this.backends = new BackendManager({ repository: this.repository, files: this.files.backends, config: this.config, logger: this.logger });
    await this.tasks.recover();
    await this.backends.resume();
    return { ok: true, storage: 'mongodb+content-store', testModelEnabled: this.config.allowTestModel };
  }

  async stop() {
    if (this.tasks) await this.tasks.stop();
    if (this.backends) await this.backends.stopAll();
  }

  async resolveSecret(reference) {
    if (typeof reference !== 'string' || !/^env:[A-Z][A-Z0-9_]*$/.test(reference)) throw error(codes.CONFIG_INVALID, 'key reference 仅支持 env:NAME', 500);
    const value = this.options.env[reference.slice(4)];
    if (!value) throw error('pages.model_key_missing', '模型密钥引用未配置', 503);
    return value;
  }

  validateModel(input) {
    const id = text(input.id, 'model id', 64).toLowerCase();
    if (!MODEL_ID_RE.test(id)) throw error(codes.INVALID_INPUT, 'model id 格式非法');
    if (!['openai-compatible', 'deterministic-test'].includes(input.kind)) throw error(codes.INVALID_INPUT, '模型类型不受支持');
    if (input.kind === 'deterministic-test') {
      if (!this.config.allowTestModel) throw error('pages.test_model_disabled', '确定性本地模型仅能在显式测试模式启用', 403);
      return { id, kind: input.kind, enabled: input.enabled !== false, sort: Number.isInteger(input.sort) ? input.sort : 0, baseUrl: null, model: 'deterministic-local-v1', keyRef: null };
    }
    let baseUrl;
    try {
      const url = new URL(text(input.baseUrl, 'baseUrl', 2048));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('invalid');
      baseUrl = url.toString().replace(/\/+$/, '');
    } catch { throw error(codes.INVALID_INPUT, 'baseUrl 必须是无凭据的 HTTP(S) 地址'); }
    const keyRef = text(input.keyRef, 'keyRef', 130);
    if (!/^env:[A-Z][A-Z0-9_]*$/.test(keyRef)) throw error(codes.INVALID_INPUT, 'keyRef 仅支持 env:NAME');
    return {
      id, kind: input.kind, baseUrl, model: text(input.model, 'model', 128),
      keyRef, enabled: input.enabled !== false,
      sort: Number.isInteger(input.sort) ? input.sort : 0
    };
  }

  user(ctx, write = false) {
    if (ctx.user && ctx.user.id) return ctx.user;
    throw error(write ? codes.FORBIDDEN : codes.SESSION_INVALID, write ? '未认证的写操作被拒绝' : '需要登录后访问', write ? 403 : 401);
  }
  admin(ctx) {
    const user = this.user(ctx, true);
    if (user.role !== 'admin') throw error(codes.FORBIDDEN, '需要管理员权限', 403);
    return user;
  }
  siteId(ctx) { return text(ctx.params.siteId, 'siteId', 128); }
  wildcard(ctx) { return ctx.params.filePath ?? ctx.params.wildcard ?? ctx.params.path ?? ''; }
  body(ctx) { return ctx.body && typeof ctx.body === 'object' ? ctx.body : {}; }
  async owned(ctx, write = false) {
    const user = this.user(ctx, write);
    const site = await this.repository.getSite(this.siteId(ctx));
    if (!site) throw error(codes.NOT_FOUND, '站点不存在', 404);
    if (site.ownerId !== user.id) throw error(codes.FORBIDDEN, '无权访问其他用户站点', 403);
    return { user, site };
  }

  summary(site) {
    return {
      id: site.id, ownerId: site.ownerId, name: site.name, slug: site.slug, description: site.description || '',
      createdAt: site.createdAt, updatedAt: site.updatedAt, fileCount: Object.keys(site.files || {}).length,
      publishedVersion: site.publishedVersion || null, latestVersion: site.nextVersion - 1,
      publicPath: site.publishedVersion ? `${this.config.publicBasePath}/${site.slug}/` : null,
      previewPath: `/api/pages/preview/${site.id}/${site.previewToken}/`
    };
  }
  detail(site) {
    return {
      ...this.summary(site), files: Object.entries(site.files || {}).sort(([a], [b]) => a.localeCompare(b)).map(([filePath, ref]) => ({ path: filePath, ...ref })),
      versions: (site.versions || []).slice().reverse().map(({ files, ...version }) => ({ ...version, isPublished: version.version === site.publishedVersion })),
      materials: Object.entries(site.materials || {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, ref]) => ({ name, ...ref })),
      aiConfigured: true, lastRollback: site.lastRollback || null
    };
  }

  async listSites(ctx) { const user = this.user(ctx); return { body: { sites: (await this.repository.listSites(user.id)).map((site) => this.summary(site)) } }; }
  async createSite(ctx) {
    const user = this.user(ctx, true);
    if ((await this.repository.listSites(user.id)).length >= this.config.maxSitesPerUser) throw error('pages.site_limit_reached', '站点数量已达上限', 409);
    const body = this.body(ctx);
    const name = text(body.name, 'name', 80);
    const slug = body.slug ? String(body.slug).toLowerCase() : slugify(name);
    if (!SLUG_RE.test(slug)) throw error(codes.INVALID_INPUT, 'slug 格式非法');
    const now = this.repository.now();
    const site = {
      id: crypto.randomUUID(), ownerId: user.id, name, slug, description: String(body.description || '').slice(0, 500),
      files: {}, fileHeads: {}, materials: {}, versions: [], nextVersion: 1, publishedVersion: null,
      revision: 0, previewToken: crypto.randomBytes(32).toString('base64url'), createdAt: now, updatedAt: now
    };
    await this.repository.insertSite(site);
    return { status: 201, body: { site: this.detail(site) } };
  }
  async getSite(ctx) { const { site } = await this.owned(ctx); return { body: { site: this.detail(site) } }; }
  async updateSite(ctx) {
    const { site } = await this.owned(ctx, true); const body = this.body(ctx);
    const updated = await this.repository.mutateSite(site.id, async (current) => {
      if (body.name !== undefined) current.name = text(body.name, 'name', 80);
      if (body.description !== undefined) current.description = String(body.description).slice(0, 500);
      if (body.slug !== undefined) {
        const slug = String(body.slug).toLowerCase(); if (!SLUG_RE.test(slug)) throw error(codes.INVALID_INPUT, 'slug 格式非法');
        const holder = await this.repository.getSiteBySlug(slug); if (holder && holder.id !== current.id) throw error('pages.slug_taken', 'slug 已被占用', 409);
        current.slug = slug;
      }
      return current;
    });
    return { body: { site: this.detail(updated) } };
  }
  async deleteSite(ctx) {
    const { site } = await this.owned(ctx, true);
    const backend = await this.repository.getBackend(site.id);
    if (backend) throw error('pages.backend_still_present', '站点仍有关联后端；为避免静默删除数据，当前拒绝删除站点', 409);
    await this.repository.deleteSite(site.id);
    return { body: { ok: true, id: site.id, note: '仅删除站点元数据；统一文件区域中的修订保留用于对账，未静默删除内容。' } };
  }

  refFor(filePath, fileId, result) {
    return { fileId, revision: result.revision, size: result.size, contentHash: result.contentHash, contentType: contentType(filePath, result.contentType) };
  }
  async putBuffer(adapter, ownerId, logicalPath, fileId, baseRevision, buffer, metadata, quotaBytes, signal) {
    const operationId = `pages-${crypto.randomUUID()}`;
    return adapter.put({
      actor: actor(ownerId), ownerId, path: logicalPath, fileId, operationId,
      size: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), baseRevision,
      stream: Readable.from(buffer), metadata, quotaBytes, signal
    });
  }
  async readRef(adapter, ownerId, ref, { asText = false, maxBytes = this.config.maxFileBytes } = {}) {
    const result = await adapter.openRead({ actor: actor(ownerId), ownerId, fileId: ref.fileId, revision: ref.revision });
    if (!asText) return result;
    try {
      if (result.size > maxBytes) throw error('pages.file_too_large', '文件过大，不能以文本读取', 413);
      const chunks = []; for await (const chunk of result.stream) chunks.push(chunk);
      return Buffer.concat(chunks).toString('utf8');
    } finally { if (typeof result.close === 'function') await result.close(); }
  }
  async listFiles(ctx) { const { site } = await this.owned(ctx); return { body: { siteId: site.id, files: this.detail(site).files } }; }
  async readFile(ctx) {
    const { site } = await this.owned(ctx); const filePath = normalizePath(this.wildcard(ctx));
    const ref = site.files[filePath]; if (!ref) throw error('pages.file_not_found', '文件不存在', 404);
    const content = await this.readRef(this.files.sites, site.ownerId, ref, { asText: true });
    return { body: { siteId: site.id, file: { path: filePath, ...ref, content } } };
  }
  async writeFile(ctx) {
    const { site } = await this.owned(ctx, true); const filePath = normalizePath(this.wildcard(ctx)); const body = this.body(ctx);
    if (typeof body.content !== 'string') throw error(codes.INVALID_INPUT, 'content 必须是字符串');
    const buffer = Buffer.from(body.content); if (buffer.length > this.config.maxFileBytes) throw error('pages.file_too_large', '文件超过上限', 413);
    // 站点文件表是嵌入式结构：在站点写锁内重新读取，避免并发保存互相覆盖。
    const saved = await this.repository.mutateSite(site.id, async (current) => {
      const previous = current.files[filePath];
      current.fileHeads = current.fileHeads || {};
      const head = current.fileHeads[filePath] || previous;
      if (!previous && Object.keys(current.files).length >= this.config.maxFilesPerSite) throw error('pages.file_limit_reached', '文件数量已达上限', 409);
      const fileId = head ? head.fileId : crypto.randomUUID();
      const result = await this.putBuffer(this.files.sites, current.ownerId, `sites/${current.id}/work/${filePath}`, fileId, head ? head.revision : null, buffer, { contentType: contentType(filePath, body.contentType), siteId: current.id, kind: 'site-work' }, null, ctx.signal);
      current.files[filePath] = this.refFor(filePath, fileId, result);
      current.fileHeads[filePath] = current.files[filePath];
      return { siteId: current.id, created: !previous, file: { path: filePath, ...current.files[filePath], content: body.content } };
    });
    return { body: saved };
  }
  async deleteFile(ctx) {
    const { site } = await this.owned(ctx, true); const filePath = normalizePath(this.wildcard(ctx));
    if (!site.files[filePath]) throw error('pages.file_not_found', '文件不存在', 404);
    const saved = await this.repository.mutateSite(site.id, async (current) => {
      const ref = current.files[filePath];
      if (!ref) throw error('pages.file_not_found', '文件不存在', 404);
      current.fileHeads = current.fileHeads || {};
      const head = current.fileHeads[filePath] || ref;
      const deleted = await this.files.sites.deleteFile({ actor: actor(current.ownerId), ownerId: current.ownerId, fileId: ref.fileId, operationId: `pages-delete-${crypto.randomUUID()}`, baseRevision: head.revision });
      current.fileHeads[filePath] = { fileId: ref.fileId, revision: deleted.revision };
      delete current.files[filePath];
      return { ok: true, siteId: current.id, path: filePath };
    });
    return { body: saved };
  }

  async uploadMaterial(ctx) {
    const { site } = await this.owned(ctx, true); const name = normalizePath(this.wildcard(ctx));
    const size = Number(ctx.req.headers['x-file-size']); const sha256 = String(ctx.req.headers['x-file-sha256'] || '').toLowerCase();
    if (!Number.isSafeInteger(size) || size < 0 || size > this.config.maxMaterialBytes || !/^[a-f0-9]{64}$/.test(sha256)) throw error(codes.INVALID_INPUT, '上传需要有效 x-file-size 与 x-file-sha256');
    if (!site.materials[name] && Object.keys(site.materials).length >= this.config.maxMaterials) throw error('pages.material_limit', '材料数量已达上限', 409);
    const saved = await this.repository.mutateSite(site.id, async (current) => {
      const previous = current.materials[name];
      if (!previous && Object.keys(current.materials).length >= this.config.maxMaterials) throw error('pages.material_limit', '材料数量已达上限', 409);
      const fileId = previous ? previous.fileId : crypto.randomUUID();
      const upload = await this.files.materials.beginUpload({ actor: actor(current.ownerId), ownerId: current.ownerId, path: `sites/${current.id}/materials/${name}`, fileId, operationId: `material-${crypto.randomUUID()}`, size, sha256, quotaBytes: this.config.maxMaterialBytes * this.config.maxMaterials });
      if (size > 0) await this.files.materials.writeChunk(upload.uploadId, 0, ctx.stream, { actor: actor(current.ownerId), signal: ctx.signal });
      const result = await this.files.materials.commitUpload({ actor: actor(current.ownerId), uploadId: upload.uploadId, baseRevision: previous ? previous.revision : null, metadata: { contentType: contentType(name, ctx.req.headers['content-type']), siteId: current.id, kind: 'task-material' }, signal: ctx.signal });
      current.materials[name] = this.refFor(name, fileId, result);
      return { material: { name, ...current.materials[name] } };
    }, { attempts: 1 });
    return { status: 201, body: saved };
  }
  async listMaterials(ctx) { const { site } = await this.owned(ctx); return { body: { materials: this.detail(site).materials } }; }
  async readMaterial(ctx) {
    const { site } = await this.owned(ctx); const name = normalizePath(this.wildcard(ctx)); const ref = site.materials[name];
    if (!ref) throw error(codes.NOT_FOUND, '材料不存在', 404);
    return this.sendRef(ctx, this.files.materials, site.ownerId, ref, true);
  }

  async validateReferences(site) {
    const htmlPaths = Object.keys(site.files).filter((filePath) => /\.html?$/.test(filePath));
    for (const filePath of htmlPaths) {
      const html = await this.readRef(this.files.sites, site.ownerId, site.files[filePath], { asText: true });
      for (const match of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
        const reference = match[1].trim();
        if (/^(?:https?:|data:|blob:|mailto:|tel:|#)/i.test(reference)) continue;
        if (/^javascript:/i.test(reference)) throw error('pages.unsafe_reference', '页面包含 javascript: 引用');
        const clean = reference.split(/[?#]/)[0]; if (!clean) continue;
        const resolved = clean.startsWith('/') ? clean.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(filePath), clean));
        if (resolved === 'index.html' || site.files[resolved]) continue;
        throw error('pages.broken_reference', `页面引用不存在：${filePath} -> ${reference}`);
      }
    }
  }
  async publish(ctx) {
    const { site } = await this.owned(ctx, true);
    const response = await this.repository.mutateSite(site.id, async (current) => {
      if (!current.files['index.html']) throw error('pages.index_required', '发布需要 index.html');
      await this.validateReferences(current);
      const files = structuredClone(current.files); const contentHash = crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(files).sort()))).digest('hex');
      const version = { version: current.nextVersion, contentHash, createdAt: this.repository.now(), fileCount: Object.keys(files).length, bytes: Object.values(files).reduce((sum, ref) => sum + ref.size, 0), files };
      current.versions = [...current.versions, version].slice(-this.config.maxVersions); current.nextVersion += 1; current.publishedVersion = version.version; current.updatedAt = version.createdAt;
      return { siteId: current.id, version: version.version, contentHash, fileCount: version.fileCount, bytes: version.bytes, publishedAt: version.createdAt, publicPath: this.summary(current).publicPath };
    });
    return { status: 201, body: response };
  }
  async listVersions(ctx) { const { site } = await this.owned(ctx); return { body: { siteId: site.id, publishedVersion: site.publishedVersion || null, versions: this.detail(site).versions } }; }
  async rollback(ctx) {
    const { site } = await this.owned(ctx, true); const requested = this.body(ctx).version;
    const response = await this.repository.mutateSite(site.id, async (current) => {
      const version = requested === undefined ? current.versions.filter((item) => item.version < current.publishedVersion).at(-1) : current.versions.find((item) => item.version === requested);
      if (!version) throw error('pages.version_not_found', '目标版本不存在', requested === undefined ? 409 : 404);
      const from = current.publishedVersion;
      current.fileHeads = current.fileHeads || {};
      const restored = {};
      for (const [filePath, ref] of Object.entries(version.files)) {
        const head = current.fileHeads[filePath] || current.files[filePath];
        if (head && head.fileId === ref.fileId && head.revision === ref.revision && head.contentHash === ref.contentHash) {
          restored[filePath] = structuredClone(ref);
          continue;
        }
        const source = await this.readRef(this.files.sites, current.ownerId, ref);
        let buffer;
        try {
          const chunks = []; for await (const chunk of source.stream) chunks.push(chunk);
          buffer = Buffer.concat(chunks);
          if (buffer.length > this.config.maxFileBytes) throw error('pages.file_too_large', '版本文件超过恢复上限', 413);
        } finally { if (typeof source.close === 'function') await source.close(); }
        const written = await this.putBuffer(this.files.sites, current.ownerId, `sites/${current.id}/work/${filePath}`, ref.fileId, head ? head.revision : null, buffer, { contentType: ref.contentType, siteId: current.id, kind: 'site-work', restoredFrom: version.version }, null, ctx.signal);
        restored[filePath] = this.refFor(filePath, ref.fileId, written);
        current.fileHeads[filePath] = restored[filePath];
      }
      current.files = restored; current.publishedVersion = version.version;
      current.updatedAt = this.repository.now(); current.lastRollback = { from, to: version.version, at: current.updatedAt };
      return { siteId: current.id, rolledBackTo: version.version, from, contentHash: version.contentHash, restoredFiles: Object.keys(current.files).length, publicPath: this.summary(current).publicPath };
    });
    return { body: response };
  }

  async servePublic(ctx) {
    const slug = ctx.params.slug; const site = await this.repository.getSiteBySlug(slug);
    if (!site || !site.publishedVersion) throw error('pages.not_published', '站点尚未发布', 404);
    const version = site.versions.find((item) => item.version === site.publishedVersion);
    if (!version) throw error('pages.snapshot_missing', '发布快照缺失', 500);
    let filePath = this.wildcard(ctx) || 'index.html'; if (filePath.endsWith('/')) filePath += 'index.html';
    filePath = normalizePath(filePath); const ref = version.files[filePath]; if (!ref) throw error('pages.file_not_found', '文件不存在', 404);
    return this.sendRef(ctx, this.files.sites, site.ownerId, ref, false, PUBLIC_CSP);
  }
  async servePreview(ctx) {
    const site = await this.repository.getSite(ctx.params.siteId);
    if (!site || typeof ctx.params.token !== 'string' || ctx.params.token.length !== site.previewToken.length || !crypto.timingSafeEqual(Buffer.from(ctx.params.token), Buffer.from(site.previewToken))) throw error(codes.NOT_FOUND, '预览不存在', 404);
    let filePath = this.wildcard(ctx) || 'index.html'; if (filePath.endsWith('/')) filePath += 'index.html';
    filePath = normalizePath(filePath); const ref = site.files[filePath]; if (!ref) throw error('pages.file_not_found', '预览文件不存在', 404);
    return this.sendRef(ctx, this.files.sites, site.ownerId, ref, false, PREVIEW_CSP);
  }
  async sendRef(ctx, adapter, ownerId, ref, attachment = false, csp = PREVIEW_CSP) {
    const result = await this.readRef(adapter, ownerId, ref);
    const headers = {
      'content-type': result.contentType || ref.contentType || 'application/octet-stream',
      'content-length': result.size, etag: result.etag, 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': csp
    };
    if (attachment) headers['content-disposition'] = 'attachment';
    ctx.res.writeHead(200, headers);
    try { if (ctx.req.method === 'HEAD') ctx.res.end(); else await pipeline(result.stream, ctx.res, { signal: ctx.signal }); }
    finally { if (typeof result.close === 'function') await result.close(); }
    return { handled: true };
  }

  async startTask(ctx) {
    const { site } = await this.owned(ctx, true); const body = this.body(ctx); const prompt = text(body.prompt, 'prompt', 12000);
    const models = await this.repository.listModels({ enabledOnly: true }); const model = models.find((item) => item.id === body.modelId) || models[0];
    if (!model) throw error('pages.ai_not_configured', '管理员尚未配置启用模型', 409);
    if (model.kind === 'deterministic-test' && !this.config.allowTestModel) throw error('pages.test_model_disabled', '测试模型未启用', 403);
    const files = {}; const materialInputs = [];
    try {
      for (const [filePath, ref] of Object.entries(site.files)) {
        if (/\.(?:html?|css|m?js|json|md|txt|xml|svg|webmanifest)$/i.test(filePath) && ref.size <= 2 * 1024 * 1024) files[filePath] = await this.readRef(this.files.sites, site.ownerId, ref, { asText: true, maxBytes: 2 * 1024 * 1024 });
      }
      const selected = Array.isArray(body.materials) ? body.materials : Object.keys(site.materials);
      for (const name of selected.slice(0, this.config.maxMaterials)) {
        const ref = site.materials[name]; if (!ref) throw error(codes.INVALID_INPUT, `材料不存在：${name}`);
        const item = { name, ...ref };
        if (ref.size <= 1024 * 1024 && /\.(?:txt|md|json|html?|css|m?js|xml|svg)$/i.test(name)) item.text = await this.readRef(this.files.materials, site.ownerId, ref, { asText: true, maxBytes: 1024 * 1024 });
        materialInputs.push(item);
      }
    } catch (cause) { if (cause instanceof CoreError) throw cause; throw error('pages.material_read_failed', '材料读取失败，任务未创建', 409); }
    const task = await this.tasks.create({ ownerId: site.ownerId, siteId: site.id, siteName: site.name, prompt, targetPath: body.path ? normalizePath(body.path) : null, model, files, materials: materialInputs });
    return { status: 202, body: { task: safeTask(task), note: model.kind === 'deterministic-test' ? '当前使用明确仅测试的本地确定性模型，不是外部模型验收。' : '任务已持久排队；浏览器断开不会取消 worker。' } };
  }
  async commitTaskResult(task, result) {
    const entries = Object.entries(result.files || {}); if (!entries.length || entries.length > 50) throw error('pages.ai_invalid_result', '模型结果文件为空或过多', 502);
    const pending = [];
    for (const [rawPath, value] of entries) {
      const filePath = normalizePath(rawPath);
      const content = typeof value === 'string' ? value : value && value.content;
      if (typeof content !== 'string') throw error('pages.ai_invalid_result', '模型结果文件内容必须是字符串', 502);
      const buffer = Buffer.from(content); if (buffer.length > this.config.maxFileBytes) throw error('pages.ai_invalid_result', '模型结果文件超过上限', 502);
      pending.push({ filePath, buffer, contentTypeHint: typeof value === 'object' && value ? value.contentType : null });
    }
    const artifactBuffer = Buffer.from(JSON.stringify({ taskId: task.id, model: task.model.id, summary: result.summary || null, usage: result.usage || null, files: pending.map(({ filePath, buffer }) => ({ path: filePath, size: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') })) }, null, 2));
    const artifact = await this.putBuffer(this.files.artifacts, task.ownerId, `tasks/${task.id}/result.json`, crypto.randomUUID(), null, artifactBuffer, { contentType: 'application/json', kind: 'task-artifact', taskId: task.id }, 1024 * 1024);
    // 在站点写锁内基于最新文档提交，避免覆盖任务运行期间用户的手工编辑。
    const changedFiles = await this.repository.mutateSite(task.siteId, async (site) => {
      if (site.ownerId !== task.ownerId) throw error(codes.FORBIDDEN, '任务站点归属已变化', 403);
      site.files = site.files || {}; site.fileHeads = site.fileHeads || {};
      if (new Set([...Object.keys(site.files), ...pending.map((item) => item.filePath)]).size > this.config.maxFilesPerSite) throw error('pages.ai_invalid_result', '模型结果使文件数量超限', 502);
      const changed = [];
      for (const item of pending) {
        const previous = site.files[item.filePath];
        const head = site.fileHeads[item.filePath] || previous;
        const fileId = head ? head.fileId : crypto.randomUUID();
        const written = await this.putBuffer(this.files.sites, task.ownerId, `sites/${site.id}/work/${item.filePath}`, fileId, head ? head.revision : null, item.buffer, { contentType: contentType(item.filePath, item.contentTypeHint), siteId: site.id, kind: 'site-work', taskId: task.id }, null);
        site.files[item.filePath] = this.refFor(item.filePath, fileId, written);
        site.fileHeads[item.filePath] = site.files[item.filePath];
        changed.push({ path: item.filePath, size: item.buffer.length, created: !previous });
      }
      return changed;
    }, { attempts: 1 });
    return { summary: result.summary || null, changedFiles, requiresPublish: true, artifact: { fileId: artifact.fileId, revision: artifact.revision, size: artifact.size }, testModel: task.model.kind === 'deterministic-test' };
  }
  async listTasks(ctx) { const user = this.user(ctx); return { body: { tasks: (await this.repository.listTasks(user.id, ctx.query.siteId || null)).map(safeTask) } }; }
  async getTask(ctx) {
    const user = this.user(ctx); const task = await this.repository.getTask(text(ctx.params.taskId, 'taskId', 128));
    if (!task) throw error(codes.NOT_FOUND, '任务不存在', 404); if (task.ownerId !== user.id) throw error(codes.FORBIDDEN, '不能访问其他用户任务', 403);
    return { body: { task: safeTask(task) } };
  }
  async downloadArtifact(ctx) {
    const user = this.user(ctx); const task = await this.repository.getTask(text(ctx.params.taskId, 'taskId', 128));
    if (!task) throw error(codes.NOT_FOUND, '任务不存在', 404);
    if (task.ownerId !== user.id) throw error(codes.FORBIDDEN, '不能访问其他用户任务产物', 403);
    const ref = task.result && task.result.artifact;
    if (!ref) throw error(codes.NOT_FOUND, '任务产物不存在', 404);
    return this.sendRef(ctx, this.files.artifacts, user.id, ref, true);
  }
  async cancelTask(ctx) {
    const user = this.user(ctx, true); const task = await this.repository.getTask(text(ctx.params.taskId, 'taskId', 128));
    if (!task) throw error(codes.NOT_FOUND, '任务不存在', 404); if (task.ownerId !== user.id) throw error(codes.FORBIDDEN, '不能停止其他用户任务', 403);
    return { body: { task: safeTask(await this.tasks.cancel(task.id)) } };
  }
  async *taskEvents(ctx) {
    const user = this.user(ctx); const taskId = text(ctx.params.taskId, 'taskId', 128); const task = await this.repository.getTask(taskId);
    if (!task) throw error(codes.NOT_FOUND, '任务不存在', 404); if (task.ownerId !== user.id) throw error(codes.FORBIDDEN, '不能访问其他用户任务', 403);
    let cursor = Number(ctx.req.headers['last-event-id'] || ctx.query.after || 0);
    while (true) {
      const current = await this.repository.getTask(taskId); const events = current.events || [];
      while (cursor < events.length) { const event = events[cursor]; cursor += 1; yield { id: String(cursor), event: event.event, data: { ...event, taskId, status: current.status } }; }
      if (TERMINAL.has(current.status)) { yield { id: String(++cursor), event: 'end', data: { taskId, status: current.status, error: current.error || null } }; return; }
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (ctx.signal.aborted) return;
    }
  }

  async listModels(ctx) { this.user(ctx); return { body: { models: (await this.repository.listModels({ enabledOnly: true })).map(publicModel), testMode: this.config.allowTestModel } }; }
  async adminListModels(ctx) { this.admin(ctx); return { body: { models: (await this.repository.listModels()).map(publicModel), testMode: this.config.allowTestModel } }; }
  async adminPutModel(ctx) {
    this.admin(ctx); const id = text(ctx.params.modelId, 'modelId', 64).toLowerCase();
    const model = this.validateModel({ ...this.body(ctx), id }); const previous = await this.repository.getModel(id);
    const saved = { ...model, createdAt: previous ? previous.createdAt : this.repository.now(), updatedAt: this.repository.now() };
    await this.repository.putModel(saved); return { body: { model: publicModel(saved) } };
  }
  async adminDeleteModel(ctx) { this.admin(ctx); const deleted = await this.repository.deleteModel(text(ctx.params.modelId, 'modelId', 64)); if (!deleted) throw error(codes.NOT_FOUND, '模型不存在', 404); return { body: { ok: true } }; }

  async deployBackend(ctx) { const { site } = await this.owned(ctx, true); const backend = await this.backends.deploy({ site, source: this.body(ctx).source }); return { status: 201, body: { backend: safeBackend(backend) } }; }
  async getBackend(ctx) { const { site } = await this.owned(ctx); return { body: { backend: safeBackend(await this.repository.getBackend(site.id)) } }; }
  async stopBackend(ctx) { const { site } = await this.owned(ctx, true); return { body: { backend: safeBackend(await this.backends.stop(site.id)) } }; }
  async startBackend(ctx) { const { site } = await this.owned(ctx, true); return { body: { backend: safeBackend(await this.backends.start(site.id)) } }; }
  async proxyBackend(ctx) { return this.backends.proxy(ctx, text(ctx.params.siteId, 'siteId', 128)); }

  async info() { return { body: { module: 'pages', version: '0.2.0', ready: true, aiConfigured: (await this.repository.listModels({ enabledOnly: true })).length > 0, publicBasePath: this.config.publicBasePath, storage: 'mongodb+content-store', testModelEnabled: this.config.allowTestModel } }; }

  async handle(method, ctx) {
    try {
      if (!this[method] || method === 'handle' || method.startsWith('_')) throw error(codes.NOT_FOUND, '接口不存在', 404);
      return await this[method](ctx);
    } catch (cause) {
      if (cause instanceof CoreError) return { status: cause.status, body: { code: cause.code, message: cause.message, ...(cause.details && cause.status < 500 ? { details: cause.details } : {}) } };
      this.logger.error(`[pages] ${method} 失败：${cause && cause.message ? cause.message : 'unknown'}`);
      return { status: 500, body: { code: 'INTERNAL', message: '内部错误' } };
    }
  }
}

module.exports = { PagesPlatform, normalizePath, contentType, publicModel, safeTask };
