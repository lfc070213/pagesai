'use strict';
// 上传、读取、列表、删除与所有权隔离。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildPdf,
  countFiles,
  startPaper,
  uploadBuffer,
  uploadText
} = require('./helpers.js');

test('上传纯文本：201、按句切分并持久化，重启后仍可读取', async () => {
  const ctx = await startPaper();
  try {
    const text = 'First sentence. Second sentence. 第三句中文。';
    const created = await uploadText(ctx.call, text);
    assert.equal(created.status, 201);
    const doc = created.body.doc;
    assert.equal(doc.status, 'ready');
    assert.equal(doc.kind, 'text');
    assert.equal(doc.segmentCount, 3);
    assert.equal(doc.blockCount, 1);

    const id = doc.id;
    const read = await ctx.call('GET', '/api/paper/docs/:id', { path: `/api/paper/docs/${id}` });
    assert.equal(read.status, 200);
    assert.equal(read.body.doc.blocks[0].segments.length, 3);
    assert.deepEqual(read.body.doc.blocks[0].segments.map((item) => item.sid), ['0:0', '0:1', '0:2']);
    assert.equal(read.body.translation.status, 'idle');

    // 句子切分已写入 JsonStore 数据文件
    const persisted = JSON.parse(fs.readFileSync(ctx.config.dataFile, 'utf8'));
    assert.ok(persisted.docs[id]);
    assert.equal(persisted.docs[id].blocks[0].segments[1].text, 'Second sentence.');
    // 原件落在 uploads 目录
    assert.equal(countFiles(ctx.config.uploadsDir), 1);

    // 重启（重新加载同一数据文件）后仍能读到
    await ctx.restart();
    const again = await ctx.call('GET', '/api/paper/docs/:id', { path: `/api/paper/docs/${id}` });
    assert.equal(again.status, 200);
    assert.equal(again.body.doc.segmentCount, 3);
  } finally {
    await ctx.close();
  }
});

test('上传简单 PDF：文本层提取成功并切分', async () => {
  const ctx = await startPaper();
  try {
    const pdf = buildPdf(['Deep learning is useful. It works well in practice.']);
    const created = await uploadBuffer(ctx.call, pdf, 'paper.pdf');
    assert.equal(created.status, 201);
    assert.equal(created.body.doc.kind, 'pdf');
    assert.equal(created.body.doc.pageCount, 1);
    assert.equal(created.body.doc.segmentCount, 2);

    const id = created.body.doc.id;
    const read = await ctx.call('GET', '/api/paper/docs/:id', { path: `/api/paper/docs/${id}` });
    assert.equal(read.status, 200);
    assert.match(read.body.doc.blocks[0].text, /Deep learning/);
  } finally {
    await ctx.close();
  }
});

test('PDF 提取失败返回 422 paper.extract_failed，且不落库、不保存原件', async () => {
  const ctx = await startPaper();
  try {
    const pdf = buildPdf('0 0 100 100 re f', { wrapText: false }); // 只有图形，没有文本层
    const created = await uploadBuffer(ctx.call, pdf, 'scanned.pdf');
    assert.equal(created.status, 422);
    assert.equal(created.body.code, 'paper.extract_failed');
    assert.ok(created.body.message);

    const list = await ctx.call('GET', '/api/paper/docs');
    assert.equal(list.status, 200);
    assert.equal(list.body.docs.length, 0);
    assert.equal(countFiles(ctx.config.uploadsDir), 0);
  } finally {
    await ctx.close();
  }
});

test('非法上传输入被拒绝：文件名、Base64、类型与大小', async () => {
  const ctx = await startPaper();
  try {
    const noName = await ctx.call('POST', '/api/paper/docs', {
      body: { filename: '', contentBase64: Buffer.from('x').toString('base64') }
    });
    assert.equal(noName.status, 400);
    assert.equal(noName.body.code, 'INVALID_INPUT');

    const badBase64 = await ctx.call('POST', '/api/paper/docs', {
      body: { filename: 'a.txt', contentBase64: 'not base64!!' }
    });
    assert.equal(badBase64.status, 400);
    assert.equal(badBase64.body.code, 'INVALID_INPUT');

    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]);
    const png = await uploadBuffer(ctx.call, binary, 'image.png');
    assert.equal(png.status, 400);
    assert.equal(png.body.code, 'paper.unsupported_file');

    const fakePdf = await uploadBuffer(ctx.call, Buffer.from('plain text'), 'fake.pdf');
    assert.equal(fakePdf.status, 400);
    assert.equal(fakePdf.body.code, 'paper.unsupported_file');

    // 路径穿越文件名只保留 basename，不越出 uploads 目录
    const traversal = await uploadText(ctx.call, 'Safe sentence.', { filename: '../../evil.txt' });
    assert.equal(traversal.status, 201);
    assert.equal(traversal.body.doc.filename, 'evil.txt');
  } finally {
    await ctx.close();
  }
});

test('超过 maxUploadBytes 返回 413', async () => {
  const ctx = await startPaper({ config: { maxUploadBytes: 1024 } });
  try {
    const big = 'A'.repeat(4096);
    const created = await uploadText(ctx.call, big);
    assert.equal(created.status, 413);
    assert.equal(created.body.code, 'INVALID_INPUT');
  } finally {
    await ctx.close();
  }
});

test('未登录的读写操作均返回 403 FORBIDDEN', async () => {
  const ctx = await startPaper();
  try {
    const created = await uploadText(ctx.call, 'Owned sentence.');
    const id = created.body.doc.id;

    const cases = [
      ['POST', '/api/paper/docs', {}, { filename: 'x.txt', contentBase64: Buffer.from('x').toString('base64') }],
      ['GET', '/api/paper/docs', {}, {}],
      ['GET', '/api/paper/docs/:id', { path: `/api/paper/docs/${id}` }, {}],
      ['DELETE', '/api/paper/docs/:id', { path: `/api/paper/docs/${id}` }, {}],
      ['POST', '/api/paper/docs/:id/translate', { path: `/api/paper/docs/${id}/translate` }, {}],
      ['POST', '/api/paper/docs/:id/ask', { path: `/api/paper/docs/${id}/ask` }, { question: 'x' }]
    ];
    for (const [method, routePath, options, body] of cases) {
      const out = await ctx.call(method, routePath, { ...options, user: null, body });
      assert.equal(out.status, 403, `${method} ${routePath}`);
      assert.equal(out.body.code, 'FORBIDDEN');
    }
  } finally {
    await ctx.close();
  }
});

test('跨用户访问同一论文返回 403（读、删、翻译、问答）', async () => {
  const ctx = await startPaper();
  try {
    const created = await uploadText(ctx.call, 'Private sentence. Another sentence.');
    const id = created.body.doc.id;
    const other = { id: 'user-b', username: 'user-b', role: 'user' };

    const read = await ctx.call('GET', '/api/paper/docs/:id', { path: `/api/paper/docs/${id}`, user: other });
    assert.equal(read.status, 403);
    assert.equal(read.body.code, 'FORBIDDEN');

    const del = await ctx.call('DELETE', '/api/paper/docs/:id', { path: `/api/paper/docs/${id}`, user: other });
    assert.equal(del.status, 403);

    const translate = await ctx.call('POST', '/api/paper/docs/:id/translate', {
      path: `/api/paper/docs/${id}/translate`, user: other, body: {}
    });
    assert.equal(translate.status, 403);

    const ask = await ctx.call('POST', '/api/paper/docs/:id/ask', {
      path: `/api/paper/docs/${id}/ask`, user: other, body: { question: '什么？' }
    });
    assert.equal(ask.status, 403);

    // 原所有者仍能读取且未被删除
    const mine = await ctx.call('GET', '/api/paper/docs/:id', { path: `/api/paper/docs/${id}` });
    assert.equal(mine.status, 200);
  } finally {
    await ctx.close();
  }
});

test('列表按所有者隔离；删除后不可读取且原件被清理', async () => {
  const ctx = await startPaper();
  try {
    const a1 = (await uploadText(ctx.call, 'A one sentence.')).body.doc;
    const a2 = (await uploadText(ctx.call, 'A two sentence.', { filename: 'two.md' })).body.doc;
    const other = { id: 'user-b', username: 'user-b', role: 'user' };
    const b1 = (await uploadText(ctx.call, 'B one sentence.', { user: other })).body.doc;

    const listA = await ctx.call('GET', '/api/paper/docs');
    assert.deepEqual(listA.body.docs.map((doc) => doc.id).sort(), [a1.id, a2.id].sort());

    const listB = await ctx.call('GET', '/api/paper/docs', { user: other });
    assert.deepEqual(listB.body.docs.map((doc) => doc.id), [b1.id]);

    assert.equal(countFiles(ctx.config.uploadsDir), 3);
    const removed = await ctx.call('DELETE', '/api/paper/docs/:id', { path: `/api/paper/docs/${a1.id}` });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body, { deleted: true, id: a1.id });
    assert.equal(countFiles(ctx.config.uploadsDir), 2);

    const gone = await ctx.call('GET', '/api/paper/docs/:id', { path: `/api/paper/docs/${a1.id}` });
    assert.equal(gone.status, 404);
    assert.equal(gone.body.code, 'NOT_FOUND');

    const unknown = await ctx.call('GET', '/api/paper/docs/:id', { path: '/api/paper/docs/not-exists' });
    assert.equal(unknown.status, 404);
  } finally {
    await ctx.close();
  }
});

test('config.dataFile 未给时纯内存运行', async () => {
  const ctx = await startPaper({ config: { dataFile: null, uploadsDir: null } });
  try {
    const created = await uploadText(ctx.call, 'Memory only sentence.');
    assert.equal(created.status, 201);
    const id = created.body.doc.id;
    const read = await ctx.call('GET', '/api/paper/docs/:id', { path: `/api/paper/docs/${id}` });
    assert.equal(read.status, 200);
    assert.equal(read.body.doc.segmentCount, 1);

    const { paper } = require('./helpers.js');
    const health = await paper.health();
    assert.equal(health.storage, 'memory');
    assert.equal(health.uploads, 'memory');
  } finally {
    await ctx.close();
  }
});