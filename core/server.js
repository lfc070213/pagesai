'use strict';
// 公共核心 HTTP 入口（B04 / M1a 的最低可运行面）。
// 只依赖 Node 内置模块：core-only 启动不需要模型、邮箱、数据库或任何业务根目录。
//
// 路由：GET /healthz、GET /readyz、GET /api/modules、POST /api/auth/register、POST /api/auth/login、
//       POST /api/auth/logout、GET /api/me、POST /api/auth/verify-email、
//       POST /api/admin/bootstrap、GET /api/admin/users、PATCH /api/admin/users/:id、
//       GET /api/admin/modules、GET /api/admin/modules/:id
//       POST /api/admin/modules/:id/(enable|disable)
// 未安装模块不注册任何业务路由（本文件不 import 任何 modules/ 代码）。

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { CoreError, codes } = require('./errors');
const { loadConfig } = require('./config');
const { IdentityService } = require('./identity/service');
const { InMemoryIdentityStore, SESSION_COOKIE } = require('./identity/store');
const { MongoIdentityStore, IDENTITY_SCHEMA_VERSION } = require('./identity/mongo-store');
const { StorageRegistry } = require('./storage/registry');
const { FileContentStore } = require('./storage/content-store');
const { MongoStorageMetadata } = require('./storage/mongo-metadata');
const { InMemoryStorageMetadata } = require('./storage/memory-metadata');
const { createModuleFileAdapter, createDiskFileAdapter } = require('./storage/module-file-adapter');
const { ModuleHost } = require('./registry/host');
const {
  DEFAULT_JSON_MAX_BYTES,
  dispatchModuleRoute,
  readBoundedBody,
  sendJson: send
} = require('./http-transport');

function mongoUriFromEnvironment(env) {
  if (env.PAGESAI_MONGO_URL) return env.PAGESAI_MONGO_URL;
  if (!env.PAGESAI_MONGO_HOST) return null;
  const credentials = env.PAGESAI_MONGO_USER
    ? `${encodeURIComponent(env.PAGESAI_MONGO_USER)}:${encodeURIComponent(env.PAGESAI_MONGO_PASSWORD || '')}@`
    : '';
  const port = env.PAGESAI_MONGO_PORT || '27017';
  const authSource = env.PAGESAI_MONGO_USER ? `?authSource=${encodeURIComponent(env.PAGESAI_MONGO_AUTH_SOURCE || 'admin')}` : '';
  return `mongodb://${credentials}${env.PAGESAI_MONGO_HOST}:${port}/${authSource}`;
}

function createCore(input = {}) {
  const config = input.config || loadConfig(input);
  const engine = config.database && config.database.engine;
  let store = input.store;
  if (store && engine === 'mongodb' && store instanceof InMemoryIdentityStore) {
    throw new CoreError(codes.CONFIG_INVALID, 'MongoDB 部署不能注入内存身份存储', { status: 500 });
  }
  if (!store) {
    if (engine !== 'mongodb') {
      throw new CoreError(codes.CONFIG_INVALID, '正式启动必须显式选择 mongodb；内存存储只能由测试显式注入', { status: 500 });
    }
    const env = input.env || process.env;
    const uri = (input.mongodb && input.mongodb.uri) || input.mongoUri || mongoUriFromEnvironment(env);
    if (!uri && !(input.mongodb && input.mongodb.client)) {
      throw new CoreError(codes.CONFIG_INVALID, 'MongoDB 启动需要 PAGESAI_MONGO_URL 或 PAGESAI_MONGO_HOST', { status: 500 });
    }
    store = new MongoIdentityStore({
      ...(input.mongodb || {}),
      uri,
      dbName: (input.mongodb && input.mongodb.dbName) || config.database.name,
      clock: input.clock
    });
  }
  const identity = new IdentityService({
    store,
    clock: input.clock,
    mail: input.mail || null,
    snapshotPath: input.identitySnapshotPath || null
  });
  identity.configureRegistration({
    enabled: config.registration.enabled,
    requireEmailVerification: config.registration.requireEmailVerification,
    allowedEmailDomains: config.registration.allowedEmailDomains,
    sessionTtlMs: config.sessionTtlMs
  });
  const storage = new StorageRegistry({
    dataRoot: config.dataRoot,
    configValues: input.configValues || config.storage || {},
    clock: input.clock
  });
  let storageMetadata = input.storageMetadata;
  if (!storageMetadata) {
    if (engine === 'mongodb') {
      const env = input.env || process.env;
      const uri = (input.mongodb && input.mongodb.uri) || input.mongoUri || store.uri || mongoUriFromEnvironment(env);
      const client = (input.mongodb && input.mongodb.client) || store.client || null;
      if (!uri && !client) throw new CoreError(codes.CONFIG_INVALID, 'MongoDB 文件元数据启动需要连接配置', { status: 500 });
      storageMetadata = new MongoStorageMetadata({
        ...(input.mongodb || {}), uri, client,
        dbName: (input.mongodb && input.mongodb.dbName) || config.database.name,
        clock: input.clock
      });
    } else {
      storageMetadata = new InMemoryStorageMetadata({ clock: input.clock });
    }
  }
  const content = input.contentStore || new FileContentStore({ metadata: storageMetadata, clock: input.clock });
  const modules = new ModuleHost({
    modulesRoot: path.join(config.installRoot, 'modules'),
    configProvider: (id) => (config.moduleConfig || {})[id],
    startContext: async () => ({
      fileAdapter,
      runtime: {
        db: storageMetadata.db,
        uri: (input.mongodb && input.mongodb.uri) || input.mongoUri || store.uri || mongoUriFromEnvironment(input.env || process.env),
        dbName: (input.mongodb && input.mongodb.dbName) || config.database.name,
        deploymentId: config.deploymentId,
        initialize: Boolean(config.database && config.database.initialize),
        dataRoot: config.dataRoot
      },
      env: input.env || process.env,
      clock: input.clock
    })
  });
  let initialization = null;
  async function initialize() {
    if (!initialization) {
      initialization = (async () => {
        let identityMigration = null;
        if (typeof store.migrate === 'function') {
          identityMigration = await store.migrate({
            targetVersion: IDENTITY_SCHEMA_VERSION,
            deploymentId: config.deploymentId,
            allowInitialize: Boolean(config.database && config.database.initialize)
          });
        }
        const storageMigration = await storageMetadata.migrate({
          deploymentId: config.deploymentId || 'explicit-in-memory-test',
          allowInitialize: Boolean(config.database && config.database.initialize)
        });
        for (const declaration of config.regions || []) {
          const registered = storage.registerRegion(declaration);
          await storageMetadata.registerRegion({ declaration, rootAbs: registered.physicalRoot });
        }
        const recovery = await content.recover();
        // 身份权威数据在 MongoDB；这里把当前用户导出到文件快照，供离线备份/恢复校验归属。
        const identitySnapshot = await identity.writeSnapshot();
        return { identity: identityMigration, storage: storageMigration, recovery, identitySnapshot };
      })();
    }
    return initialization;
  }
  function fileAdapter({ moduleId, regionId, viaDisk = false }) {
    return viaDisk
      ? createDiskFileAdapter({ regionId, registry: storage, content })
      : createModuleFileAdapter({ moduleId, regionId, registry: storage, content });
  }
  return { config, store, identity, storage, storageMetadata, content, modules, initialize, fileAdapter };
}

function readBody(req) {
  return readBoundedBody(req, { maxBytes: DEFAULT_JSON_MAX_BYTES, json: true });
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  const cookie = String(req.headers.cookie || '');
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

const STATIC_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
});

/** 把 /a/:b/* 形式的路由编译为可匹配片段。 */
function compilePath(pathPattern) {
  const segments = String(pathPattern).split('/').filter(Boolean);
  return { segments };
}

/** 匹配路由；返回 params（含通配 wildcard）或 null。 */
function matchPath(compiled, pathname) {
  const parts = String(pathname).split('/').filter(Boolean);
  const segs = compiled.segments;
  const wildcard = segs.length > 0 && segs[segs.length - 1] === '*';
  const fixed = wildcard ? segs.length - 1 : segs.length;
  if (wildcard ? parts.length < fixed : parts.length !== fixed) return null;
  const params = {};
  for (let i = 0; i < fixed; i++) {
    const seg = segs[i];
    if (seg.startsWith(':')) { params[seg.slice(1)] = decodeURIComponent(parts[i]); continue; }
    if (seg !== parts[i]) return null;
  }
  if (wildcard) params.wildcard = parts.slice(fixed).map(decodeURIComponent).join('/');
  return params;
}

/** 读取后台静态文件，拒绝越界路径。 */
function serveAdminFile(publicDir, pathname) {
  const rel = pathname === '/admin' || pathname === '/admin/' ? 'index.html' : pathname.replace(/^\/admin\/?/, '');
  const filePath = path.resolve(publicDir, rel);
  if (!filePath.startsWith(path.resolve(publicDir) + path.sep) && filePath !== path.resolve(publicDir, 'index.html')) return null;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  return { body: fs.readFileSync(filePath), type: STATIC_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream' };
}

function servePagesConsole(installRoot, pathname) {
  const files = { '/': 'index.html', '/pages': 'index.html', '/pages-console.js': 'console.js', '/pages-console.css': 'console.css' };
  if (!Object.prototype.hasOwnProperty.call(files, pathname)) return null;
  const publicDir = path.join(installRoot, 'modules', 'pages', 'web');
  const filePath = path.join(publicDir, files[pathname]);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  return { body: fs.readFileSync(filePath), type: STATIC_TYPES[path.extname(filePath)] || 'application/octet-stream' };
}

function serveDiskConsole(installRoot, pathname) {
  const files = { '/disk': 'index.html', '/disk/': 'index.html', '/disk-app.js': 'app.js', '/disk-app.css': 'app.css' };
  if (!Object.prototype.hasOwnProperty.call(files, pathname)) return null;
  const publicDir = path.join(installRoot, 'modules', 'disk', 'web');
  const filePath = path.join(publicDir, files[pathname]);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  return { body: fs.readFileSync(filePath), type: STATIC_TYPES[path.extname(filePath)] || 'application/octet-stream' };
}

function serveGlimConsole(installRoot, pathname) {
  const files = { '/glim': 'index.html', '/glim/': 'index.html', '/glim-app.js': 'app.js', '/glim-app.css': 'app.css' };
  if (!Object.prototype.hasOwnProperty.call(files, pathname)) return null;
  const publicDir = path.join(installRoot, 'modules', 'glim', 'web');
  const filePath = path.join(publicDir, files[pathname]);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  return { body: fs.readFileSync(filePath), type: STATIC_TYPES[path.extname(filePath)] || 'application/octet-stream' };
}

function serveMailConsole(installRoot, pathname) {
  const files = { '/mail': 'index.html', '/mail/': 'index.html', '/mail-app.js': 'app.js', '/mail-app.css': 'app.css' };
  if (!Object.prototype.hasOwnProperty.call(files, pathname)) return null;
  const publicDir = path.join(installRoot, 'modules', 'mail', 'web');
  const filePath = path.join(publicDir, files[pathname]);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  return { body: fs.readFileSync(filePath), type: STATIC_TYPES[path.extname(filePath)] || 'application/octet-stream' };
}

function serveSurveyConsole(installRoot, pathname) {
  const files = { '/survey': 'index.html', '/survey/': 'index.html', '/survey-app.js': 'app.js', '/survey-app.css': 'app.css' };
  if (!Object.prototype.hasOwnProperty.call(files, pathname)) return null;
  const publicDir = path.join(installRoot, 'modules', 'survey', 'web');
  const filePath = path.join(publicDir, files[pathname]);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  return { body: fs.readFileSync(filePath), type: STATIC_TYPES[path.extname(filePath)] || 'application/octet-stream' };
}

function servePaperConsole(installRoot, pathname) {
  const files = { '/paper': 'index.html', '/paper/': 'index.html', '/paper-app.js': 'app.js', '/paper-app.css': 'app.css' };
  if (!Object.prototype.hasOwnProperty.call(files, pathname)) return null;
  const publicDir = path.join(installRoot, 'modules', 'paper', 'web');
  const filePath = path.join(publicDir, files[pathname]);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  return { body: fs.readFileSync(filePath), type: STATIC_TYPES[path.extname(filePath)] || 'application/octet-stream' };
}

function createServer(core) {
  const { identity, storage, modules, config } = core;

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const method = req.method || 'GET';
    const p = url.pathname;

    if (method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });
    if (method === 'GET' && p === '/readyz') {
      // core-only 就绪：身份可用即就绪；未安装模块不参与探测
      return send(res, 200, { ok: true, modules: modules.list(), dataRoot: config.dataRoot });
    }
    if (method === 'GET' && p === '/api/modules') {
      return send(res, 200, { modules: modules.list(), installed: config.installedModules.slice() });
    }
    if (method === 'POST' && p === '/api/auth/register') {
      const body = await readBody(req);
      const result = await identity.register(body, { ip: req.socket.remoteAddress });
      return send(res, 201, result);
    }
    if (method === 'POST' && p === '/api/auth/verify-email') {
      const body = await readBody(req);
      return send(res, 200, await identity.verifyEmail(body));
    }
    if (method === 'POST' && p === '/api/auth/login') {
      const body = await readBody(req);
      const result = await identity.login(body);
      const cookie = `${SESSION_COOKIE}=${encodeURIComponent(result.token)}; HttpOnly; SameSite=Lax; Path=/`;
      return send(res, 200, result, { 'set-cookie': cookie });
    }
    if (method === 'POST' && p === '/api/auth/logout') {
      const token = bearerToken(req);
      if (!token) throw new CoreError(codes.SESSION_INVALID, '缺少会话', { status: 401 });
      return send(res, 200, await identity.logout(token));
    }
    if (method === 'GET' && p === '/api/me') {
      const token = bearerToken(req);
      if (!token) throw new CoreError(codes.SESSION_INVALID, '缺少会话', { status: 401 });
      return send(res, 200, { user: await identity.authenticate(token) });
    }
    if (method === 'POST' && p === '/api/admin/bootstrap') {
      const body = await readBody(req);
      if (config.bootstrapToken && body.bootstrapToken !== config.bootstrapToken) {
        throw new CoreError(codes.FORBIDDEN, '引导令牌无效', { status: 403 });
      }
      return send(res, 201, await identity.bootstrapAdmin(body));
    }
    if (method === 'GET' && p === '/api/admin/users') {
      const token = bearerToken(req);
      if (!token) throw new CoreError(codes.SESSION_INVALID, '缺少会话', { status: 401 });
      return send(res, 200, { users: await identity.listUsers(token) });
    }
    const patchUser = /^\/api\/admin\/users\/([^/]+)$/.exec(p);
    if (method === 'PATCH' && patchUser) {
      const token = bearerToken(req);
      if (!token) throw new CoreError(codes.SESSION_INVALID, '缺少会话', { status: 401 });
      const body = await readBody(req);
      if (body.role !== undefined) return send(res, 200, await identity.setRole(token, patchUser[1], body.role));
      if (body.status !== undefined) return send(res, 200, await identity.setStatus(token, patchUser[1], body.status));
      throw new CoreError(codes.INVALID_INPUT, '只支持修改 role 或 status', { status: 400 });
    }
    // 已启用模块的业务路由：未安装/未启用模块不会出现在 modules.allRoutes() 里
    for (const route of modules.allRoutes()) {
      const declared = String(route.method).toUpperCase();
      // HEAD 只放行下载类 GET 路由：sendDownloadResult 会正确返回头并丢弃正文。
      const headOnDownload = method === 'HEAD' && declared === 'GET'
        && route.transport && route.transport.kind === 'download';
      if (declared !== method && !headOnDownload) continue;
      if (!route.__compiled) route.__compiled = compilePath(route.path);
      const params = matchPath(route.__compiled, p);
      if (!params) continue;
      const token2 = bearerToken(req);
      let user = null;
      if (token2) {
        try { user = await identity.authenticate(token2); } catch { user = null; }
      }
      const query = Object.fromEntries(url.searchParams.entries());
      return dispatchModuleRoute(route, { req, res, url, params, query, user, moduleId: route.moduleId });
    }

    // 管理：模块状态与后台贡献（只读；只有 admin）
    if (method === 'GET' && p === '/api/admin/modules') {
      const tokenAdmin = bearerToken(req);
      if (!tokenAdmin) throw new CoreError(codes.SESSION_INVALID, '缺少会话', { status: 401 });
      await identity.requireAdmin(tokenAdmin);
      return send(res, 200, { modules: modules.list(), admin: await modules.adminList() });
    }
    const adminModuleDetail = /^\/api\/admin\/modules\/([^/]+)$/.exec(p);
    if (method === 'GET' && adminModuleDetail) {
      const tokenAdmin = bearerToken(req);
      if (!tokenAdmin) throw new CoreError(codes.SESSION_INVALID, '缺少会话', { status: 401 });
      await identity.requireAdmin(tokenAdmin);
      const id = adminModuleDetail[1];
      const module = modules.describe(id);
      if (!module.installed) {
        throw new CoreError(codes.MODULE_NOT_INSTALLED, `模块 ${id} 未安装`, { status: 404 });
      }
      return send(res, 200, { module, admin: await modules.adminFor(id) });
    }

    // 管理：启用/停用已登记模块（只有 admin，且不提供网页端插件安装）
    const modAdmin = /^\/api\/admin\/modules\/([^/]+)\/(enable|disable)$/.exec(p);
    if (method === 'POST' && modAdmin) {
      const token3 = bearerToken(req);
      if (!token3) throw new CoreError(codes.SESSION_INVALID, '缺少会话', { status: 401 });
      await identity.requireAdmin(token3);
      try {
        const state = modAdmin[2] === 'enable' ? await modules.enable(modAdmin[1]) : await modules.disable(modAdmin[1]);
        return send(res, 200, { module: state });
      } catch (err) {
        if (err instanceof CoreError) return send(res, err.status, { module: modules.describe(modAdmin[1]), error: err.toJSON() });
        throw err;
      }
    }

    // Pages 控制台静态资源不含身份；业务请求只接受核心正式会话。
    if (method === 'GET' && modules.routesFor('pages').length > 0 && ['/', '/pages', '/pages-console.js', '/pages-console.css'].includes(p)) {
      const file = servePagesConsole(config.installRoot, p);
      if (!file) throw new CoreError(codes.NOT_FOUND, 'Pages 控制台资源不存在', { status: 404 });
      res.writeHead(200, { 'content-type': file.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'" });
      res.end(file.body);
      return undefined;
    }

    // Disk 控制台静态资源：与业务 API 同源，但页面本身不含身份或文件内容。
    if (method === 'GET' && modules.routesFor('disk').length > 0 && ['/disk', '/disk/', '/disk-app.js', '/disk-app.css'].includes(p)) {
      const file = serveDiskConsole(config.installRoot, p);
      if (!file) throw new CoreError(codes.NOT_FOUND, 'Disk 控制台资源不存在', { status: 404 });
      res.writeHead(200, { 'content-type': file.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'self'" });
      res.end(file.body);
      return undefined;
    }

    // Glim 控制台静态资源：同源调用 /api/glim，页面本身不含身份或消息内容。
    if (method === 'GET' && modules.routesFor('glim').length > 0 && ['/glim', '/glim/', '/glim-app.js', '/glim-app.css'].includes(p)) {
      const file = serveGlimConsole(config.installRoot, p);
      if (!file) throw new CoreError(codes.NOT_FOUND, 'Glim 控制台资源不存在', { status: 404 });
      res.writeHead(200, { 'content-type': file.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'" });
      res.end(file.body);
      return undefined;
    }

    // Mail 控制台静态资源：同源调用 /api/mail，页面本身不含身份或邮件内容。
    if (method === 'GET' && modules.routesFor('mail').length > 0 && ['/mail', '/mail/', '/mail-app.js', '/mail-app.css'].includes(p)) {
      const file = serveMailConsole(config.installRoot, p);
      if (!file) throw new CoreError(codes.NOT_FOUND, 'Mail 控制台资源不存在', { status: 404 });
      res.writeHead(200, { 'content-type': file.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'" });
      res.end(file.body);
      return undefined;
    }

    // Survey 控制台静态资源：同源调用 /api/survey；公开填写页使用 #fill/<slug>。
    if (method === 'GET' && modules.routesFor('survey').length > 0 && ['/survey', '/survey/', '/survey-app.js', '/survey-app.css'].includes(p)) {
      const file = serveSurveyConsole(config.installRoot, p);
      if (!file) throw new CoreError(codes.NOT_FOUND, 'Survey 控制台资源不存在', { status: 404 });
      res.writeHead(200, { 'content-type': file.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'" });
      res.end(file.body);
      return undefined;
    }

    // Paper 控制台静态资源：同源调用 /api/paper；PDF 原件通过同源 iframe 内嵌。
    if (method === 'GET' && modules.routesFor('paper').length > 0 && ['/paper', '/paper/', '/paper-app.js', '/paper-app.css'].includes(p)) {
      const file = servePaperConsole(config.installRoot, p);
      if (!file) throw new CoreError(codes.NOT_FOUND, 'Paper 控制台资源不存在', { status: 404 });
      res.writeHead(200, { 'content-type': file.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'" });
      res.end(file.body);
      return undefined;
    }

    // 后台静态外壳（可选；未放置 admin/index.html 时返回 404）
    if (method === 'GET' && (p === '/admin' || p.startsWith('/admin/'))) {
      const file = serveAdminFile(path.join(config.installRoot, 'admin'), p);
      if (!file) throw new CoreError(codes.NOT_FOUND, '后台页面不存在', { status: 404 });
      res.writeHead(200, { 'content-type': file.type, 'cache-control': 'no-store' });
      res.end(file.body);
      return undefined;
    }

    void storage;
    throw new CoreError(codes.NOT_FOUND, '接口不存在', { status: 404 });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      // 流式响应一旦写头，只能终止该响应；不能再拼接 JSON 或重复写头。
      if (res.destroyed || res.writableEnded) return undefined;
      if (res.headersSent) {
        res.destroy();
        return undefined;
      }
      if (err instanceof CoreError) return send(res, err.status, err.toJSON());
      return send(res, 500, { code: 'INTERNAL', message: '内部错误', details: null });
    });
  });

  return {
    core,
    server,
    async listen({ port = 0, host = '127.0.0.1' } = {}) {
      if (typeof core.initialize === 'function') {
        try {
          await core.initialize();
        } catch (error) {
          if (core.storageMetadata && typeof core.storageMetadata.close === 'function') await core.storageMetadata.close();
          if (core.store && typeof core.store.close === 'function') await core.store.close();
          throw error;
        }
      }
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      const address = server.address();
      return { port: address.port, host: address.address, url: `http://${address.address}:${address.port}` };
    },
    async close() {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      for (const item of modules.list()) {
        if (item.ready) await modules.disable(item.id);
      }
      if (core.storageMetadata && typeof core.storageMetadata.close === 'function') await core.storageMetadata.close();
      if (core.store && typeof core.store.close === 'function') await core.store.close();
    }
  };
}

module.exports = { createCore, createServer };
