'use strict';
// Disk 模块测试辅助：直接调用导出的 route.handler，不启动 HTTP。
// ctx 形状与契约一致：{ req, res, url, params, query, body, user }。

const assert = require('node:assert/strict');
const disk = require('../server/index.js');

const USER_A = Object.freeze({ id: 'user-a', username: 'alice' });
const USER_B = Object.freeze({ id: 'user-b', username: 'bob' });
const QUIET = Object.freeze({ info() {}, warn() {}, error() {} });

const ROUTES = Object.freeze({
  init: ['POST', '/api/disk/uploads/init'],
  chunk: ['PUT', '/api/disk/uploads/:uploadId/chunks/:index'],
  complete: ['POST', '/api/disk/uploads/:uploadId/complete'],
  upload: ['GET', '/api/disk/uploads/:uploadId'],
  list: ['GET', '/api/disk/files'],
  file: ['GET', '/api/disk/files/:fileId'],
  content: ['GET', '/api/disk/files/:fileId/content'],
  remove: ['DELETE', '/api/disk/files/:fileId'],
  restore: ['POST', '/api/disk/files/:fileId/restore'],
  createShare: ['POST', '/api/disk/files/:fileId/shares'],
  listShares: ['GET', '/api/disk/files/:fileId/shares'],
  share: ['GET', '/api/disk/shares/:token'],
  shareContent: ['GET', '/api/disk/shares/:token/content'],
  revokeShare: ['DELETE', '/api/disk/shares/:shareId'],
  quota: ['GET', '/api/disk/quota'],
  health: ['GET', '/api/disk/health']
});

let operationCounter = 0;
function nextOperationId(prefix = 'op') {
  operationCounter += 1;
  return `${prefix}-${Date.now()}-${operationCounter}-0123456789`;
}

function base64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

async function boot(config = {}, options = {}) {
  await disk.start({ config, logger: QUIET, ...options });
}

async function shutdown() {
  await disk.stop();
}

function findRoute(method, pattern) {
  return disk.routes.find((route) => route.method === method && route.path === pattern);
}

async function call(method, pattern, options = {}) {
  const route = findRoute(method, pattern);
  if (!route) throw new Error(`未找到路由 ${method} ${pattern}`);
  const { params = {}, query = {}, body = {}, user = null, headers = {} } = options;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) search.set(key, String(value));
  }
  const suffix = search.toString() ? `?${search.toString()}` : '';
  const url = new URL(`http://127.0.0.1${pattern}${suffix}`);
  const ctx = { req: { headers }, res: {}, url, params, query, body, user };
  return route.handler(ctx);
}

/** 快捷调用：按 ROUTES 表中的别名发起请求。 */
async function api(name, options = {}) {
  const entry = ROUTES[name];
  if (!entry) throw new Error(`未知路由别名 ${name}`);
  return call(entry[0], entry[1], options);
}

function expectError(response, status, code) {
  assert.equal(response.status, status, `期望 HTTP ${status}，实际 ${response.status}: ${JSON.stringify(response.body)}`);
  assert.equal(response.body && response.body.code, code, JSON.stringify(response.body));
  assert.equal(typeof (response.body && response.body.message), 'string', '错误响应必须包含 message');
}

/** 上传分块并提交；返回 { init, uploadId, chunks, complete }。 */
async function uploadFile(user, options = {}) {
  const {
    name = 'hello.txt',
    mimeType = 'text/plain',
    chunks = ['hello ', 'world'],
    totalChunks,
    size,
    fileId,
    baseRevision,
    operationId
  } = options;
  const init = await api('init', {
    user,
    body: {
      name,
      mimeType,
      totalChunks: totalChunks === undefined ? chunks.length : totalChunks,
      size,
      fileId,
      baseRevision
    }
  });
  assert.equal(init.status, 201, JSON.stringify(init.body));
  const uploadId = init.body.uploadId;
  const uploaded = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = await api('chunk', {
      user,
      params: { uploadId, index: String(index) },
      body: { data: base64(chunks[index]) }
    });
    assert.equal(chunk.status, 200, JSON.stringify(chunk.body));
    uploaded.push(chunk.body);
  }
  const complete = await api('complete', {
    user,
    params: { uploadId },
    body: { operationId: operationId || nextOperationId('complete') }
  });
  return { init, uploadId, chunks: uploaded, complete };
}

/** 上传并断言提交成功，返回文件元数据。 */
async function createFile(user, options = {}) {
  const result = await uploadFile(user, options);
  assert.equal(result.complete.status, 201, JSON.stringify(result.complete.body));
  return result.complete.body.file;
}

module.exports = {
  assert,
  disk,
  USER_A,
  USER_B,
  QUIET,
  ROUTES,
  api,
  base64,
  boot,
  call,
  createFile,
  expectError,
  findRoute,
  nextOperationId,
  shutdown,
  uploadFile
};
