'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { CoreError, codes } = require('../../../core/errors.js');
const { killIfMatches } = require('./process-utils.js');

// 租户后端与管理面同源托管：强制沙箱 CSP，禁止其读取管理会话/存储。
// 生产部署仍建议为租户后端使用独立域名（见 modules/pages/README.md）。
const TENANT_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-connection']);
const DROP_REQUEST_HEADERS = new Set([
  'host', 'cookie', 'authorization', 'content-length', 'transfer-encoding',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'x-client-ip', 'client-ip',
  'forwarded', 'via', 'proxy-authorization', 'expect'
]);

function safeError(error) {
  return String(error && error.message || 'BACKEND_FAILED').replace(/(mongodb(?:\+srv)?:\/\/)[^\s]+/gi, '$1[redacted]').slice(0, 200);
}

async function allocatePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** 只接受 runner 报告的、且与预分配端口一致的回环端口。 */
function validateListeningMessage(message, expectedPort) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  if (message.type !== 'listening') return null;
  const port = message.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  if (Number.isInteger(expectedPort) && port !== expectedPort) return null;
  return port;
}

/** 请求头白名单式清洗：不把管理面凭据、转发链和租户通道头交给租户进程。 */
function sanitizeRequestHeaders(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = String(name).toLowerCase();
    if (DROP_REQUEST_HEADERS.has(lower)) continue;
    if (lower.startsWith('x-pages') || lower.startsWith('x-pagesai') || lower.startsWith('proxy-')) continue;
    out[lower] = value;
  }
  return out;
}

/** 响应头清洗：丢弃 Set-Cookie（防同源 Cookie 遮蔽管理会话），HTML 追加沙箱 CSP。 */
function sanitizeResponseHeaders(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = String(name).toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'set-cookie') continue;
    out[lower] = value;
  }
  if (/text\/html/i.test(String(out['content-type'] || ''))) {
    const existing = out['content-security-policy'];
    out['content-security-policy'] = existing
      ? [...(Array.isArray(existing) ? existing : [existing]), TENANT_CSP]
      : TENANT_CSP;
    out['x-frame-options'] = 'DENY';
  }
  out['x-content-type-options'] = 'nosniff';
  out['referrer-policy'] = 'no-referrer';
  out['cross-origin-opener-policy'] = 'same-origin';
  return out;
}

class BackendManager {
  constructor({ repository, files, config, logger }) {
    this.repository = repository;
    this.files = files;
    this.config = config;
    this.logger = logger;
    this.processes = new Map();
    this.starting = new Map();
  }

  actor(ownerId) { return { userId: ownerId, service: 'pages-backend' }; }

  async deploy({ site, source }) {
    if (typeof source !== 'string' || !source.trim()) throw new CoreError(codes.INVALID_INPUT, '后端入口源码不能为空', { status: 400 });
    const buffer = Buffer.from(source);
    if (buffer.length > this.config.backendSourceBytes) throw new CoreError(codes.INVALID_INPUT, '后端入口源码超过限制', { status: 413 });
    const previous = await this.repository.getBackend(site.id);
    if (previous) await this.stop(site.id, { preserveStatus: true });
    const now = this.repository.now();
    const fileId = previous ? previous.fileId : crypto.randomUUID();
    const revision = previous && previous.file ? previous.file.revision : null;
    const operationId = `backend-deploy-${site.id}-${crypto.randomUUID()}`;
    const file = await this.files.put({
      actor: this.actor(site.ownerId), ownerId: site.ownerId,
      path: `backends/${site.id}/server.js`, fileId, operationId,
      size: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      baseRevision: revision, stream: require('node:stream').Readable.from(buffer),
      metadata: { kind: 'tenant-backend-source', siteId: site.id }, quotaBytes: this.config.backendSourceBytes
    });
    const backend = {
      siteId: site.id, ownerId: site.ownerId, fileId,
      file: { fileId, revision: file.revision },
      databaseName: this.databaseName(site.id), status: 'deploying', desiredStatus: 'running',
      port: null, pid: null, version: previous ? previous.version + 1 : 1,
      appSecret: previous ? previous.appSecret : crypto.randomBytes(32).toString('hex'),
      backendSecret: previous ? previous.backendSecret : crypto.randomBytes(32).toString('hex'),
      createdAt: previous ? previous.createdAt : now, updatedAt: now, lastError: null
    };
    await this.repository.putBackend(backend);
    await this.start(site.id);
    return this.repository.getBackend(site.id);
  }

  databaseName(siteId) {
    const suffix = crypto.createHash('sha256').update(`${this.config.databaseName}:${siteId}`).digest('hex').slice(0, 24);
    return `${this.config.databaseName}_tenant_${suffix}`.slice(0, 63);
  }

  /**
   * 租户数据库连接串。默认绝不下发主库凭据：只有显式配置 tenantMongoUri
   * （只授予租户库权限的专用账号）时才带凭据，否则使用无凭据 URL。
   */
  tenantDatabaseUrl(databaseName) {
    const restricted = this.config.tenantMongoUri;
    const url = new URL(restricted || this.config.mongodbUri);
    if (!restricted) { url.username = ''; url.password = ''; }
    url.pathname = `/${databaseName}`;
    return url.toString();
  }

  async materialize(backend) {
    const root = path.join(this.config.backendRuntimeRoot, backend.siteId);
    const data = path.join(root, 'data');
    const uploads = path.join(root, 'uploads');
    await fs.promises.mkdir(data, { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(uploads, { recursive: true, mode: 0o700 });
    const target = path.join(root, 'server.js');
    const temporary = path.join(root, `.server-${process.pid}-${crypto.randomBytes(4).toString('hex')}.js`);
    const result = await this.files.openRead({ actor: this.actor(backend.ownerId), ownerId: backend.ownerId, fileId: backend.fileId, revision: backend.file.revision });
    try {
      await pipeline(result.stream, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      await fs.promises.rename(temporary, target);
    } finally {
      if (typeof result.close === 'function') await result.close();
      await fs.promises.unlink(temporary).catch(() => {});
    }
    return { root, data, uploads, target };
  }

  withRoute(backend) {
    return backend ? { ...backend, routePath: `/api/pages/tenant/${backend.siteId}/` } : backend;
  }

  async start(siteId) {
    if (this.starting.has(siteId)) return this.starting.get(siteId);
    const pending = this.startInternal(siteId).finally(() => this.starting.delete(siteId));
    this.starting.set(siteId, pending);
    return pending;
  }

  async startInternal(siteId) {
    const backend = await this.repository.getBackend(siteId);
    if (!backend) throw new CoreError(codes.NOT_FOUND, '后端尚未部署', { status: 404 });
    const existing = this.processes.get(siteId);
    if (existing && !existing.exited) return this.withRoute(existing.backend);
    const paths = await this.materialize(backend);
    const port = await allocatePort();
    const child = fork(path.join(__dirname, '..', 'worker', 'backend-runner.js'), [paths.target], {
      cwd: paths.root,
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin', HOME: paths.root, TMPDIR: paths.root,
        PORT: String(port), DATABASE_URL: this.tenantDatabaseUrl(backend.databaseName),
        PAGES_DATA_DIR: paths.data, PAGES_UPLOADS_DIR: paths.uploads,
        APP_JWT_SECRET: backend.appSecret, PAGES_BACKEND_SECRET: backend.backendSecret,
        NODE_NO_WARNINGS: '1'
      },
      execArgv: [`--max-old-space-size=${this.config.backendMemoryMB}`], silent: true,
      ...(this.config.workerUid === null ? {} : { uid: this.config.workerUid, gid: this.config.workerGid })
    });
    const record = { child, backend, port, logs: '', stopping: false, exited: false, resolveStart: null, listening: false };
    this.processes.set(siteId, record);
    // 监听器必须在任何 await 之前安装：租户进程可能立刻退出。
    child.stdout.on('data', (chunk) => { record.logs = (record.logs + chunk.toString()).slice(-16384); });
    child.stderr.on('data', (chunk) => { record.logs = (record.logs + chunk.toString()).slice(-16384); });
    const started = new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), this.config.backendStartTimeoutMs);
      timer.unref();
      record.resolveStart = (outcome) => { clearTimeout(timer); resolve(outcome); };
    });
    child.on('message', (message) => {
      const accepted = validateListeningMessage(message, port);
      if (accepted === null) {
        if (message && typeof message === 'object' && message.type === 'listening') {
          this.logger.warn(`[pages] 忽略租户后端上报的非预期端口（site=${siteId}）`);
        }
        return;
      }
      record.listening = true;
      if (record.resolveStart) record.resolveStart({ ok: true });
    });
    child.on('error', (error) => {
      record.spawnError = error;
      if (record.resolveStart) record.resolveStart({ ok: false, reason: 'spawn' });
    });
    child.on('exit', (code, signal) => {
      if (record.exited) return;
      record.exited = true;
      if (record.resolveStart) record.resolveStart({ ok: false, reason: 'exit' });
      if (this.processes.get(siteId) === record) this.processes.delete(siteId);
      if (record.stopping) return;
      this.repository.getBackend(siteId).then((current) => {
        if (!current || current.desiredStatus !== 'running') return null;
        return this.repository.putBackend({ ...current, status: 'failed', port: null, pid: null, lastError: `后端进程退出（code=${code}, signal=${signal || 'none'}）` });
      }).catch(() => {});
    });
    await this.repository.putBackend({ ...backend, status: 'starting', desiredStatus: 'running', pid: child.pid, port: null, lastError: null });
    const outcome = await started;
    if (!outcome.ok || record.exited || !record.listening) {
      await this.stop(siteId, { failed: true });
      throw new CoreError('pages.backend_start_failed', '后端未在限定时间内监听端口；已停止进程并保留源码与数据', { status: 502 });
    }
    const current = await this.repository.getBackend(siteId);
    if (!current) throw new CoreError(codes.NOT_FOUND, '后端记录丢失', { status: 500 });
    const running = {
      ...current, status: 'running', desiredStatus: 'running', port: record.port,
      pid: child.pid, updatedAt: this.repository.now(), lastError: null
    };
    await this.repository.putBackend(running);
    record.backend = running;
    return this.withRoute(running);
  }

  async stop(siteId, { preserveStatus = false, failed = false } = {}) {
    const backend = await this.repository.getBackend(siteId);
    if (!backend) throw new CoreError(codes.NOT_FOUND, '后端尚未部署', { status: 404 });
    const record = this.processes.get(siteId);
    if (record) {
      record.stopping = true;
      if (record.resolveStart) record.resolveStart({ ok: false, reason: 'stopped' });
      if (this.processes.get(siteId) === record) this.processes.delete(siteId);
      if (record.child.exitCode === null && record.child.signalCode === null) {
        record.child.kill('SIGTERM');
        await Promise.race([
          new Promise((resolve) => record.child.once('exit', resolve)),
          new Promise((resolve) => { const timer = setTimeout(resolve, 1000); timer.unref(); })
        ]);
        if (record.child.exitCode === null) record.child.kill('SIGKILL');
      }
    } else if (Number.isInteger(backend.pid)) {
      // 进程表里没有记录但元数据仍有 pid（例如宿主重启后）：按命令行标记清理遗留进程。
      const cleaned = await killIfMatches(backend.pid, ['backend-runner.js']).catch(() => ({ killed: false }));
      if (cleaned.killed) this.logger.warn(`[pages] 已清理遗留租户后端（site=${siteId}, pid=${backend.pid}）`);
    }
    const current = await this.repository.getBackend(siteId);
    if (!current) return null;
    await this.repository.putBackend({
      ...current,
      status: failed ? 'failed' : (preserveStatus ? current.status : 'stopped'),
      desiredStatus: preserveStatus ? current.desiredStatus : 'stopped',
      port: null, pid: null, updatedAt: this.repository.now(),
      lastError: failed ? '后端启动或运行失败' : null
    });
    return this.repository.getBackend(siteId);
  }

  async resume() {
    const backends = await this.repository.listBackends();
    for (const backend of backends) {
      if (backend.desiredStatus !== 'running') continue;
      if (Number.isInteger(backend.pid)) {
        const cleaned = await killIfMatches(backend.pid, ['backend-runner.js']).catch(() => ({ killed: false }));
        if (cleaned.killed) this.logger.warn(`[pages] 恢复前已清理遗留租户后端（site=${backend.siteId}, pid=${backend.pid}）`);
      }
      // 先归零旧进程信息，避免同一后端被并发启动两次或复用旧端口。
      await this.repository.putBackend({ ...backend, status: 'stopped', pid: null, port: null });
      try { await this.start(backend.siteId); }
      catch (error) { this.logger.error(`[pages] 后端恢复失败 ${backend.siteId}: ${safeError(error)}`); }
    }
  }

  async stopAll() {
    await Promise.all([...this.processes.keys()].map((siteId) => this.stop(siteId, { preserveStatus: true }).catch(() => {})));
  }

  async proxy(ctx, siteId) {
    const backend = await this.repository.getBackend(siteId);
    const record = this.processes.get(siteId);
    if (!backend || backend.status !== 'running' || !record || record.exited || !Number.isInteger(record.port)) {
      throw new CoreError('pages.backend_unavailable', '租户后端未运行；源码和数据仍保留', { status: 503 });
    }
    const prefix = `/api/pages/tenant/${siteId}`;
    const targetPath = ctx.req.url.slice(prefix.length) || '/';
    if (!targetPath.startsWith('/') || targetPath.includes('\\')) throw new CoreError(codes.PATH_ESCAPE, '租户路径非法', { status: 400 });
    const headers = sanitizeRequestHeaders(ctx.req.headers);
    headers['x-pages-tenant-id'] = siteId;
    headers['x-forwarded-host'] = 'tenant.invalid';
    let timedOut = false;
    const proxy = http.request({ hostname: '127.0.0.1', port: record.port, path: targetPath, method: ctx.req.method, headers }, (response) => {
      ctx.res.writeHead(response.statusCode, sanitizeResponseHeaders(response.headers));
      response.pipe(ctx.res);
    });
    proxy.setTimeout(this.config.backendProxyTimeoutMs, () => { timedOut = true; proxy.destroy(new Error('TENANT_TIMEOUT')); });
    proxy.on('error', () => {
      if (!ctx.res.headersSent) ctx.res.writeHead(timedOut ? 504 : 502);
      ctx.res.end();
    });
    if (typeof ctx.res.on === 'function') {
      ctx.res.on('close', () => { if (!ctx.res.writableEnded) proxy.destroy(); });
    }
    const requestBody = ctx.stream || ctx.req;
    requestBody.on('error', () => proxy.destroy());
    requestBody.pipe(proxy);
    return { handled: true };
  }
}

module.exports = {
  BackendManager, TENANT_CSP,
  validateListeningMessage, sanitizeRequestHeaders, sanitizeResponseHeaders, allocatePort
};
