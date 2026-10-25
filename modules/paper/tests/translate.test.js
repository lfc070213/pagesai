'use strict';
// 翻译：未配置 409、进度、等长校验、中断恢复、并发保护。

const test = require('node:test');
const assert = require('node:assert/strict');

const { startPaper, uploadText } = require('./helpers.js');

const TEXT = 'Alpha beta gamma. Delta epsilon zeta. Eta theta iota. Kappa lambda mu.';

async function translate(call, docId, body = {}) {
  return call('POST', '/api/paper/docs/:id/translate', {
    path: `/api/paper/docs/${docId}/translate`,
    body
  });
}

async function progress(call, docId, query = {}) {
  return call('GET', '/api/paper/docs/:id/translate', {
    path: `/api/paper/docs/${docId}/translate`,
    query
  });
}

test('未配置 translateAdapter 返回 409 paper.translate_not_configured，进度为 idle', async () => {
  const ctx = await startPaper();
  try {
    const doc = (await uploadText(ctx.call, TEXT)).body.doc;
    const out = await translate(ctx.call, doc.id);
    assert.equal(out.status, 409);
    assert.equal(out.body.code, 'paper.translate_not_configured');

    const state = await progress(ctx.call, doc.id);
    assert.equal(state.status, 200);
    assert.equal(state.body.job.status, 'idle');
    assert.equal(state.body.job.total, 4);
    assert.equal(state.body.job.progress, 0);

    const badLang = await translate(ctx.call, doc.id, { targetLang: '中文' });
    assert.equal(badLang.status, 400);
    assert.equal(badLang.body.code, 'INVALID_INPUT');
  } finally {
    await ctx.close();
  }
});

test('翻译成功：逐句译文按 sid 持久化，进度 100% 且可查询全文', async () => {
  const adapter = async ({ segments }) => segments.map((segment) => `译文：${segment.text}`);
  const ctx = await startPaper({ config: { translateAdapter: adapter } });
  try {
    const doc = (await uploadText(ctx.call, TEXT)).body.doc;
    const out = await translate(ctx.call, doc.id);
    assert.equal(out.status, 200);
    assert.equal(out.body.job.status, 'done');
    assert.equal(out.body.job.total, 4);
    assert.equal(out.body.job.done, 4);
    assert.equal(out.body.job.progress, 1);
    assert.equal(out.body.job.targetLang, 'zh');

    const state = await progress(ctx.call, doc.id, { include: 'text' });
    assert.equal(state.status, 200);
    assert.equal(state.body.job.status, 'done');
    const texts = state.body.translations;
    assert.deepEqual(Object.keys(texts).sort(), ['0:0', '0:1', '0:2', '0:3']);
    assert.equal(texts['0:0'], '译文：Alpha beta gamma.');
  } finally {
    await ctx.close();
  }
});

test('已完成翻译再次调用是幂等的，不会重复消耗适配器', async () => {
  let calls = 0;
  const adapter = async ({ segments }) => {
    calls += 1;
    return segments.map((item) => `译：${item.text}`);
  };
  const ctx = await startPaper({ config: { translateAdapter: adapter } });
  try {
    const doc = (await uploadText(ctx.call, TEXT)).body.doc;
    assert.equal((await translate(ctx.call, doc.id)).status, 200);
    const before = calls;
    const again = await translate(ctx.call, doc.id);
    assert.equal(again.status, 200);
    assert.equal(again.body.job.status, 'done');
    assert.equal(calls, before);
  } finally {
    await ctx.close();
  }
});

test('适配器返回条数与输入不符时中断，绝不写入错位译文', async () => {
  const adapter = async ({ segments }) => segments.slice(0, 1).map((segment) => `漏译：${segment.text}`);
  const ctx = await startPaper({ config: { translateAdapter: adapter } });
  try {
    const doc = (await uploadText(ctx.call, TEXT)).body.doc;
    const out = await translate(ctx.call, doc.id);
    assert.equal(out.status, 502);
    assert.equal(out.body.code, 'paper.translate_failed');
    assert.equal(out.body.details.job.status, 'interrupted');
    assert.equal(out.body.details.job.done, 0);

    const state = await progress(ctx.call, doc.id, { include: 'text' });
    assert.equal(state.body.job.status, 'interrupted');
    assert.deepEqual(state.body.translations, {});
  } finally {
    await ctx.close();
  }
});

test('中断后可恢复：只补翻未完成句子，已完成 sid 不重复翻译', async () => {
  let calls = 0;
  let fail = true;
  const translatedSids = [];
  const adapter = async ({ segments }) => {
    calls += 1;
    if (fail && calls === 2) throw new Error('模拟上游中断');
    translatedSids.push(...segments.map((item) => item.sid));
    return segments.map((item) => `译：${item.text}`);
  };

  const ctx = await startPaper({ config: { translateAdapter: adapter, translateBatchSize: 1 } });
  try {
    const doc = (await uploadText(ctx.call, TEXT)).body.doc;

    const first = await translate(ctx.call, doc.id);
    assert.equal(first.status, 502);
    assert.equal(first.body.code, 'paper.translate_failed');
    assert.equal(first.body.details.job.status, 'interrupted');
    assert.equal(first.body.details.job.done, 1);
    assert.equal(first.body.details.job.progress, 0.25);
    assert.deepEqual(translatedSids, ['0:0']);

    const afterFailure = await progress(ctx.call, doc.id, { include: 'text' });
    assert.equal(afterFailure.body.job.status, 'interrupted');
    assert.deepEqual(Object.keys(afterFailure.body.translations), ['0:0']);

    fail = false;
    const resumed = await translate(ctx.call, doc.id);
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.job.status, 'done');
    assert.equal(resumed.body.job.done, 4);
    assert.equal(resumed.body.job.progress, 1);
    // 恢复时只翻 0:1/0:2/0:3，0:0 没有被重复翻译
    assert.deepEqual(translatedSids, ['0:0', '0:1', '0:2', '0:3']);

    const final = await progress(ctx.call, doc.id, { include: 'text' });
    assert.equal(Object.keys(final.body.translations).length, 4);
  } finally {
    await ctx.close();
  }
});

test('同一论文翻译运行中再次发起返回 409 paper.translate_in_progress', async () => {
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  let releaseResolve;
  const gate = new Promise((resolve) => { releaseResolve = resolve; });
  const adapter = async ({ segments }) => {
    enteredResolve();
    await gate;
    return segments.map((item) => `译：${item.text}`);
  };

  const ctx = await startPaper({ config: { translateAdapter: adapter } });
  try {
    const doc = (await uploadText(ctx.call, TEXT)).body.doc;
    const first = translate(ctx.call, doc.id);
    await entered;
    const concurrent = await translate(ctx.call, doc.id);
    assert.equal(concurrent.status, 409);
    assert.equal(concurrent.body.code, 'paper.translate_in_progress');
    releaseResolve();
    const done = await first;
    assert.equal(done.status, 200);
    assert.equal(done.body.job.status, 'done');
  } finally {
    await ctx.close();
  }
});

test('restart=true 清空旧译文并重新翻译', async () => {
  let prefix = '第一次';
  const adapter = async ({ segments }) => segments.map((item) => `${prefix}：${item.text}`);
  const ctx = await startPaper({ config: { translateAdapter: adapter } });
  try {
    const doc = (await uploadText(ctx.call, TEXT)).body.doc;
    assert.equal((await translate(ctx.call, doc.id)).status, 200);

    prefix = '第二次';
    const restarted = await translate(ctx.call, doc.id, { restart: true });
    assert.equal(restarted.status, 200);
    assert.equal(restarted.body.job.status, 'done');

    const state = await progress(ctx.call, doc.id, { include: 'text' });
    assert.match(state.body.translations['0:0'], /^第二次：/);
  } finally {
    await ctx.close();
  }
});

test('适配器带 i 下标乱序返回时按 i 重排，仍与原文逐句对齐', async () => {
  const adapter = async ({ segments }) => segments
    .map((item, i) => ({ i, text: `译${i}：${item.text}` }))
    .reverse();
  const ctx = await startPaper({ config: { translateAdapter: adapter } });
  try {
    const doc = (await uploadText(ctx.call, TEXT)).body.doc;
    const out = await translate(ctx.call, doc.id);
    assert.equal(out.status, 200);
    const state = await progress(ctx.call, doc.id, { include: 'text' });
    assert.equal(state.body.translations['0:0'], '译0：Alpha beta gamma.');
    assert.equal(state.body.translations['0:3'], '译3：Kappa lambda mu.');
  } finally {
    await ctx.close();
  }
});
