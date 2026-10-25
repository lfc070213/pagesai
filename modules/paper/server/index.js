'use strict';
// Paper 模块入口（统一模块接口）。
//
// module.exports = { start, stop, health, routes, tools }
//  - start({config, logger})：按配置装配 JsonStore 与适配器；
//  - stop()：先停止新任务，运行中的翻译在下一批之前收敛为 interrupted（可恢复）；
//  - health()：启动且未停止时 ok=true；
//  - routes：{method, path, handler}，全部以 /api/paper/ 开头；
//  - tools：对 Glim 开放的能力实现（与 manifest.capabilities.tools 同名）。

const { CoreError, codes } = require('../../../core/errors.js');
const { PaperService } = require('./service.js');

let service = null;
let logger = null;

function safeLogger(input) {
  if (!input || typeof input !== 'object') return null;
  return {
    info: typeof input.info === 'function' ? input.info.bind(input) : () => {},
    warn: typeof input.warn === 'function' ? input.warn.bind(input) : () => {},
    error: typeof input.error === 'function' ? input.error.bind(input) : () => {}
  };
}

function requireService() {
  if (!service) {
    throw new CoreError(codes.MODULE_NOT_READY, 'Paper 模块尚未启动', { status: 503 });
  }
  return service;
}

function errorResponse(err) {
  const isCore = err instanceof CoreError || (err && err.name === 'CoreError' && typeof err.code === 'string');
  if (isCore) {
    const body = { code: err.code, message: err.message };
    if (err.details !== undefined && err.details !== null) body.details = err.details;
    return { status: Number.isInteger(err.status) ? err.status : 400, body };
  }
  if (logger) logger.error(`[paper] 未处理错误：${err && err.stack ? err.stack : String(err)}`);
  return { status: 500, body: { code: 'INTERNAL', message: '内部错误' } };
}

function wrap(handler) {
  return async function paperRoute(ctx) {
    try {
      return await handler(requireService(), ctx || {});
    } catch (err) {
      return errorResponse(err);
    }
  };
}

function bodyOf(ctx) {
  const body = ctx && ctx.body;
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

function urlOf(ctx) {
  if (ctx && ctx.url instanceof URL) return ctx.url;
  if (ctx && typeof ctx.url === 'string') {
    try {
      return new URL(ctx.url, 'http://localhost');
    } catch {
      return null;
    }
  }
  return null;
}

function queryOf(ctx) {
  if (ctx && ctx.query && typeof ctx.query === 'object') return ctx.query;
  const url = urlOf(ctx);
  return url ? Object.fromEntries(url.searchParams.entries()) : {};
}

/** 路由参数优先取宿主注入的 ctx.params；直接调用时从 ctx.url 回推（方便测试与 dev 服务器）。 */
function pathParam(ctx, name, routePath) {
  if (ctx && ctx.params && ctx.params[name] !== undefined && ctx.params[name] !== null) {
    return String(ctx.params[name]);
  }
  const url = urlOf(ctx);
  if (!url) return undefined;
  const pattern = '^' + routePath
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z0-9_]+)/g, '([^/]+)') + '$';
  const match = new RegExp(pattern).exec(url.pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

const ROUTES = {
  upload: '/api/paper/docs',
  rawUpload: '/api/paper/docs/upload',
  list: '/api/paper/docs',
  doc: '/api/paper/docs/:id',
  file: '/api/paper/docs/:id/file',
  translate: '/api/paper/docs/:id/translate',
  translateStop: '/api/paper/docs/:id/translate/stop',
  ask: '/api/paper/docs/:id/ask'
};

const MAX_JSON_UPLOAD_BYTES = 48 * 1024 * 1024;
const MAX_RAW_UPLOAD_BYTES = 128 * 1024 * 1024;

/** 收集原始上传流；超过硬上限立即 413，不把整文件无限留在内存。 */
async function readUploadStream(stream, maxBytes) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new CoreError(codes.INVALID_INPUT, '缺少上传内容', { status: 400 });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) throw new CoreError(codes.INVALID_INPUT, '请求体过大', { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

const routes = [
  {
    method: 'POST',
    path: ROUTES.upload,
    transport: { kind: 'json', maxBytes: MAX_JSON_UPLOAD_BYTES },
    handler: wrap(async (svc, ctx) => {
      const body = bodyOf(ctx);
      const result = await svc.uploadDoc({
        user: ctx.user,
        filename: body.filename,
        contentBase64: body.contentBase64
      });
      return { status: 201, body: result };
    })
  },
  {
    // 大文件原始上传：?filename=...，请求体为文件字节；不经过 Base64 与 JSON。
    method: 'POST',
    path: ROUTES.rawUpload,
    transport: { kind: 'upload', maxBytes: MAX_RAW_UPLOAD_BYTES },
    handler: wrap(async (svc, ctx) => {
      const query = queryOf(ctx);
      const buffer = await readUploadStream(ctx.stream, MAX_RAW_UPLOAD_BYTES);
      const result = await svc.uploadBuffer({
        user: ctx.user,
        filename: query.filename,
        buffer
      });
      return { status: 201, body: result };
    })
  },
  {
    method: 'GET',
    path: ROUTES.list,
    handler: wrap(async (svc, ctx) => ({ status: 200, body: svc.listDocs({ user: ctx.user }) }))
  },
  {
    method: 'GET',
    path: ROUTES.doc,
    handler: wrap(async (svc, ctx) => ({
      status: 200,
      body: svc.getDoc({ user: ctx.user, docId: pathParam(ctx, 'id', ROUTES.doc) })
    }))
  },
  {
    // 原件下载：支持 Range/HEAD；未落盘 PDF 返回 409，不伪造文件。
    method: 'GET',
    path: ROUTES.file,
    transport: { kind: 'download' },
    handler: wrap(async (svc, ctx) => svc.getRawFile({
      user: ctx.user,
      docId: pathParam(ctx, 'id', ROUTES.file),
      inline: ['1', 'true', 'yes'].includes(String(queryOf(ctx).inline || '').toLowerCase())
    }))
  },
  {
    method: 'DELETE',
    path: ROUTES.doc,
    handler: wrap(async (svc, ctx) => ({
      status: 200,
      body: svc.deleteDoc({ user: ctx.user, docId: pathParam(ctx, 'id', ROUTES.doc) })
    }))
  },
  {
    method: 'POST',
    path: ROUTES.translate,
    handler: wrap(async (svc, ctx) => {
      const body = bodyOf(ctx);
      const result = await svc.translateDoc({
        user: ctx.user,
        docId: pathParam(ctx, 'id', ROUTES.translate),
        targetLang: body.targetLang,
        restart: body.restart === true
      });
      return { status: 200, body: result };
    })
  },
  {
    // 主动停止：只对本人、正在运行的任务生效；已完成的翻译保留，可继续。
    method: 'POST',
    path: ROUTES.translateStop,
    handler: wrap(async (svc, ctx) => {
      const body = bodyOf(ctx);
      const result = svc.stopTranslation({
        user: ctx.user,
        docId: pathParam(ctx, 'id', ROUTES.translateStop),
        targetLang: body.targetLang
      });
      return { status: 200, body: result };
    })
  },
  {
    method: 'GET',
    path: ROUTES.translate,
    handler: wrap(async (svc, ctx) => {
      const query = queryOf(ctx);
      const result = svc.getTranslation({
        user: ctx.user,
        docId: pathParam(ctx, 'id', ROUTES.translate),
        targetLang: query.targetLang,
        includeText: query.include
      });
      return { status: 200, body: result };
    })
  },
  {
    method: 'POST',
    path: ROUTES.ask,
    handler: wrap(async (svc, ctx) => {
      const body = bodyOf(ctx);
      const result = await svc.askDoc({
        user: ctx.user,
        docId: pathParam(ctx, 'id', ROUTES.ask),
        question: body.question,
        topK: body.topK
      });
      return { status: 200, body: result };
    })
  }
];

async function start({ config, logger: inputLogger } = {}) {
  if (service) await stop();
  logger = safeLogger(inputLogger);
  const instance = new PaperService({ config: config || {}, logger: logger || undefined });
  await instance.init();
  service = instance;
}

async function stop() {
  if (!service) return;
  const instance = service;
  service = null;
  await instance.close();
}

async function health() {
  if (!service) return { ok: false, reason: 'not-started' };
  return service.health();
}

// 对 Glim 开放的能力实现。未启动时抛 MODULE_NOT_READY，由调用方映射为失败，
// 不返回任何模拟数据。
const tools = {
  paper_list_docs: async (args = {}) => requireService().listDocs({ user: args.user }),
  paper_read_doc: async (args = {}) => requireService().getDoc({ user: args.user, docId: args.docId || args.id }),
  paper_upload_doc: async (args = {}) => requireService().uploadDoc({
    user: args.user,
    filename: args.filename,
    contentBase64: args.contentBase64
  }),
  paper_translate_doc: async (args = {}) => requireService().translateDoc({
    user: args.user,
    docId: args.docId || args.id,
    targetLang: args.targetLang,
    restart: args.restart === true
  }),
  paper_ask_doc: async (args = {}) => requireService().askDoc({
    user: args.user,
    docId: args.docId || args.id,
    question: args.question,
    topK: args.topK
  }),
  paper_delete_doc: async (args = {}) => requireService().deleteDoc({
    user: args.user,
    docId: args.docId || args.id
  })
};

module.exports = { start, stop, health, routes, tools };
