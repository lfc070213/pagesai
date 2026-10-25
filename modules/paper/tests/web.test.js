'use strict';
// 大文件原始上传、原件下载与用户停止翻译（C28 网页依赖的服务端能力）。

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');

const { paper, startPaper, buildPdf } = require('./helpers.js');
const DEFAULT_USER = { id: 'user-a', username: 'user-a', role: 'user' };

function routeOf(method, routePath) {
  const route = paper.routes.find((item) => item.method === method && item.path === routePath);
  if (!route) throw new Error(`找不到路由 ${method} ${routePath}`);
  return route;
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('原始上传流与原件下载：不经 Base64，正文提取与文件字节一致', async () => {
  const ctx = await startPaper();
  try {
    const text = 'Raw upload first sentence. Second sentence here.';
    const uploadRoute = routeOf('POST', '/api/paper/docs/upload');
    const uploaded = await uploadRoute.handler({
      user: DEFAULT_USER,
      query: { filename: 'raw.txt' },
      stream: Readable.from(Buffer.from(text, 'utf8'))
    });
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.body.doc.filename, 'raw.txt');
    assert.equal(uploaded.body.doc.fileAvailable, true);
    assert.equal(uploaded.body.doc.segmentCount >= 2, true);

    const fileRoute = routeOf('GET', '/api/paper/docs/:id/file');
    const file = await fileRoute.handler({ user: DEFAULT_USER, params: { id: uploaded.body.doc.id } });
    assert.equal(file.size, Buffer.byteLength(text));
    assert.match(file.contentType, /text\/plain/);
    assert.match(file.contentDisposition, /attachment/);
    assert.equal((await collect(file.stream)).toString('utf8'), text);
  } finally {
    await ctx.close();
  }
});

test('PDF 原件落盘可下载；未配置 uploadsDir 时明确 409 而非伪造文件', async () => {
  const ctx = await startPaper();
  try {
    const pdf = buildPdf('PDF raw download check.');
    const upload = await paper.routes.find((item) => item.method === 'POST' && item.path === '/api/paper/docs')
      .handler({
        user: DEFAULT_USER,
        body: { filename: 'raw.pdf', contentBase64: pdf.toString('base64') }
      });
    assert.equal(upload.status, 201);
    const file = await routeOf('GET', '/api/paper/docs/:id/file').handler({
      user: DEFAULT_USER,
      params: { id: upload.body.doc.id }
    });
    assert.equal(file.size, pdf.length);
    assert.equal(file.contentType, 'application/pdf');
    assert.deepEqual(await collect(file.stream), pdf);
  } finally {
    await ctx.close();
  }

  const memoryDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pagesai-paper-mem-'));
  try {
    await paper.start({ config: {}, logger: { info() {}, warn() {}, error() {} } });
    const pdf = buildPdf('Memory only PDF.');
    const upload = await routeOf('POST', '/api/paper/docs').handler({
      user: DEFAULT_USER,
      body: { filename: 'memory.pdf', contentBase64: pdf.toString('base64') }
    });
    assert.equal(upload.status, 201);
    assert.equal(upload.body.doc.fileAvailable, false);
    const file = await routeOf('GET', '/api/paper/docs/:id/file').handler({
      user: DEFAULT_USER,
      params: { id: upload.body.doc.id }
    });
    assert.equal(file.status, 409);
    assert.equal(file.body.code, 'paper.file_not_available');
  } finally {
    await paper.stop();
    fs.rmSync(memoryDir, { recursive: true, force: true });
  }
});

test('停止翻译：任务收敛为 stopped，已完成译文保留，再发起可继续', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const adapter = async ({ segments }) => {
    calls += 1;
    if (calls > 1) await gate;
    return segments.map((segment) => `译：${segment.text}`);
  };
  const ctx = await startPaper({ config: { translateAdapter: adapter, translateBatchSize: 1 } });
  try {
    const text = 'One sentence. Two sentence. Three sentence. Four sentence.';
    const uploaded = await routeOf('POST', '/api/paper/docs').handler({
      user: DEFAULT_USER,
      body: { filename: 'stop.txt', contentBase64: Buffer.from(text).toString('base64') }
    });
    const docId = uploaded.body.doc.id;
    const translateRoute = routeOf('POST', '/api/paper/docs/:id/translate');
    const running = translateRoute.handler({ user: DEFAULT_USER, params: { id: docId }, body: {} });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const stopped = await routeOf('POST', '/api/paper/docs/:id/translate/stop')
      .handler({ user: DEFAULT_USER, params: { id: docId }, body: {} });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.stopped, true);
    assert.equal(stopped.body.job.status, 'stopped');

    release();
    const first = await running;
    assert.equal(first.body.stopped, true);
    assert.equal(first.body.job.status, 'stopped');
    assert.equal(first.body.job.done >= 1, true);

    const state = await routeOf('GET', '/api/paper/docs/:id/translate')
      .handler({ user: DEFAULT_USER, params: { id: docId }, query: { include: 'text' } });
    assert.equal(state.body.job.status, 'stopped');
    assert.equal(Object.keys(state.body.translations).length >= 1, true);

    const resumed = await translateRoute.handler({ user: DEFAULT_USER, params: { id: docId }, body: {} });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.job.status, 'done');
    assert.equal(resumed.body.job.progress, 1);
  } finally {
    release();
    await ctx.close();
  }
});
