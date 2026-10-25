'use strict';
// 问答：未配置 409、检索降级、引用索引合法、适配器故障。

const test = require('node:test');
const assert = require('node:assert/strict');

const { startPaper, uploadText } = require('./helpers.js');

const TEXT = 'Neural networks learn representations. Attention improves sequence models. Training needs data.';
const QUESTION = 'attention 的作用是什么？';

async function ask(call, docId, body) {
  return call('POST', '/api/paper/docs/:id/ask', {
    path: `/api/paper/docs/${docId}/ask`,
    body
  });
}

async function segmentSids(call, docId) {
  const read = await call('GET', '/api/paper/docs/:id', { path: `/api/paper/docs/${docId}` });
  return read.body.doc.blocks.flatMap((block) => block.segments.map((segment) => segment.sid));
}

test('未配置 qaAdapter 返回 409 paper.qa_not_configured；空问题返回 400', async () => {
  const ctx = await startPaper();
  try {
    const doc = (await uploadText(ctx.call, TEXT)).body.doc;
    const out = await ask(ctx.call, doc.id, { question: QUESTION });
    assert.equal(out.status, 409);
    assert.equal(out.body.code, 'paper.qa_not_configured');

    const empty = await ask(ctx.call, doc.id, { question: '   ' });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.code, 'INVALID_INPUT');
  } finally {
    await ctx.close();
  }
});

test('未配置检索适配器时明确降级，引用索引仍然合法', async () => {
  const ctx = await startPaper({
    config: {
      qaAdapter: async ({ segments }) => ({
        answer: `根据 ${segments.length} 个句子回答。`,
        citations: [{ sid: segments[0].sid }, '99:99']
      })
    }
  });
  try {
    const doc = (await uploadText(ctx.call, TEXT)).body.doc;
    const sids = await segmentSids(ctx.call, doc.id);
    const out = await ask(ctx.call, doc.id, { question: QUESTION });
    assert.equal(out.status, 200);
    assert.ok(out.body.answer);
    assert.equal(out.body.degraded.code, 'paper.search_unavailable');
    assert.equal(out.body.search.source, 'local');
    assert.equal(out.body.search.configured, false);
    assert.equal(out.body.citationsIgnored, 1);

    // 引用必须是文档里真实存在的句子索引
    assert.ok(out.body.citations.length >= 1);
    for (const citation of out.body.citations) {
      assert.ok(sids.includes(citation.sid), citation.sid);
      assert.equal(typeof citation.blockIndex, 'number');
      assert.equal(typeof citation.sentenceIndex, 'number');
      assert.ok(citation.blockIndex >= 0);
      assert.ok(citation.sentenceIndex >= 0);
    }
    for (const sid of out.body.retrieved) assert.ok(sids.includes(sid));
  } finally {
    await ctx.close();
  }
});

test('配置检索适配器时按其返回 sid 构建上下文，并只保留合法引用', async () => {
  let captured = null;
  const ctx = await startPaper({
    config: {
      searchAdapter: {
        async search() { return { results: [{ sid: '0:2' }, { sid: 'bad:sid' }] }; }
      },
      qaAdapter: async ({ segments }) => {
        captured = segments;
        return { answer: '训练需要数据。', citations: ['0:2'] };
      }
    }
  });
  try {
    const doc = (await uploadText(ctx.call, TEXT)).body.doc;
    const sids = await segmentSids(ctx.call, doc.id);
    const out = await ask(ctx.call, doc.id, { question: '训练需要什么？', topK: 1 });
    assert.equal(out.status, 200);
    assert.equal(out.body.degraded, null);
    assert.equal(out.body.search.source, 'adapter');
    assert.equal(out.body.search.configured, true);
    assert.equal(captured[0].sid, '0:2');
    assert.equal(out.body.citations.length, 1);
    assert.equal(out.body.citations[0].sid, '0:2');
    assert.ok(sids.includes(out.body.citations[0].sid));
    assert.ok(out.body.retrieved.includes('0:2'));
  } finally {
    await ctx.close();
  }
});

test('检索适配器故障时降级到本地关键词检索且仍回答问题', async () => {
  const ctx = await startPaper({
    config: {
      searchAdapter: { async search() { throw new Error('检索服务超时'); } },
      qaAdapter: async () => ({ answer: '降级后仍可回答。', citations: [] })
    }
  });
  try {
    const doc = (await uploadText(ctx.call, TEXT)).body.doc;
    const out = await ask(ctx.call, doc.id, { question: QUESTION });
    assert.equal(out.status, 200);
    assert.equal(out.body.search.source, 'local');
    assert.equal(out.body.degraded.code, 'paper.search_failed');
    assert.match(out.body.degraded.message, /检索服务超时/);
    assert.equal(out.body.answer, '降级后仍可回答。');
    assert.deepEqual(out.body.citations, []);
    // 本地检索仍应命中 attention 所在句子
    assert.ok(out.body.retrieved.includes('0:1'));
  } finally {
    await ctx.close();
  }
});

test('问答适配器故障返回 502 paper.qa_failed', async () => {
  const ctx = await startPaper({
    config: { qaAdapter: async () => { throw new Error('模型不可用'); } }
  });
  try {
    const doc = (await uploadText(ctx.call, TEXT)).body.doc;
    const out = await ask(ctx.call, doc.id, { question: QUESTION });
    assert.equal(out.status, 502);
    assert.equal(out.body.code, 'paper.qa_failed');
  } finally {
    await ctx.close();
  }
});

test('问题与 topK 的输入校验', async () => {
  const ctx = await startPaper({
    config: { qaAdapter: async ({ segments }) => ({ answer: `共 ${segments.length} 句`, citations: [] }) }
  });
  try {
    const doc = (await uploadText(ctx.call, TEXT)).body.doc;
    assert.equal((await ask(ctx.call, doc.id, { question: 'x'.repeat(2001) })).status, 400);
    assert.equal((await ask(ctx.call, doc.id, { question: 'x', topK: 0 })).status, 400);
    assert.equal((await ask(ctx.call, doc.id, { question: 'x', topK: 'abc' })).status, 400);
    assert.equal((await ask(ctx.call, doc.id, { question: 'x', topK: 3 })).status, 200);
  } finally {
    await ctx.close();
  }
});

test('引用支持 sid / 扁平下标 / 块内下标，越界与非法引用被丢弃', async () => {
  const ctx = await startPaper({
    config: {
      qaAdapter: async () => ({
        answer: '多形状引用。',
        citations: ['0:0', 1, { blockIndex: 0, sentenceIndex: 2 }, { index: 99 }, 'bad:sid']
      })
    }
  });
  try {
    const doc = (await uploadText(ctx.call, TEXT)).body.doc;
    const out = await ask(ctx.call, doc.id, { question: QUESTION });
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.citations.map((item) => item.sid), ['0:0', '0:1', '0:2']);
    assert.equal(out.body.citationsIgnored, 2);
    const sids = await segmentSids(ctx.call, doc.id);
    for (const citation of out.body.citations) assert.ok(sids.includes(citation.sid));
  } finally {
    await ctx.close();
  }
});
