'use strict';
// 翻译 / 问答 / 检索适配器。
//
// 设计要点：
//  - 适配器只从 config 解析；**未配置绝不影响读、列表、删除、上传**；
//  - 未配置或配置了但不可用时返回 null，由服务层给出 409 + 明确 paper.* code；
//  - 支持三种注入形态：函数、带同名方法的对象、endpoint 形式的 HTTP 适配器；
//  - HTTP 适配器只使用 Node 内置 fetch，不引第三方依赖，也不把 apiKey 写进错误信息。

const DEFAULT_TIMEOUT_MS = 60000;

function httpAdapter(settings, operation) {
  const endpoint = String(settings.endpoint || '');
  if (!/^https?:\/\//i.test(endpoint)) return null;
  const timeoutMs = Number.isSafeInteger(settings.timeoutMs) && settings.timeoutMs >= 1000
    ? settings.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const model = typeof settings.model === 'string' && settings.model.trim() ? settings.model.trim() : undefined;

  async function post(payload) {
    const headers = { 'content-type': 'application/json' };
    if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...payload, ...(model ? { model } : {}) }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      // 只暴露错误类别，不带 endpoint/apiKey。
      throw new Error(`上游适配器请求失败（${err && err.name ? err.name : 'network'}）`);
    }
    if (!response.ok) throw new Error(`上游适配器返回 HTTP ${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new Error('上游适配器响应不是合法 JSON');
    }
  }

  if (operation === 'translate') {
    return {
      type: 'http',
      async translate(input) {
        const body = await post({
          segments: input.segments.map((item, index) => ({ i: index, sid: item.sid, text: item.text })),
          targetLang: input.targetLang,
          context: input.context || ''
        });
        return body;
      }
    };
  }
  if (operation === 'ask') {
    return {
      type: 'http',
      async ask(input) {
        const body = await post({
          question: input.question,
          segments: input.segments,
          doc: input.doc
        });
        return body;
      }
    };
  }
  if (operation === 'search') {
    return {
      type: 'http',
      async search(input) {
        const body = await post({
          question: input.question,
          topK: input.topK,
          segments: input.segments
        });
        return body;
      }
    };
  }
  return null;
}

/**
 * 解析适配器。返回 null 表示「未配置或不可用」，调用方必须返回 409。
 * @param {*} value config.translateAdapter / config.qaAdapter / config.searchAdapter
 * @param {'translate'|'ask'|'search'} operation
 */
function resolveAdapter(value, operation) {
  if (!value) return null;
  if (typeof value === 'function') return { type: 'function', [operation]: value };
  if (typeof value !== 'object') return null;
  if (typeof value[operation] === 'function') return { type: 'method', [operation]: value[operation].bind(value) };
  if (typeof value.endpoint === 'string' && value.endpoint.trim()) return httpAdapter(value, operation);
  return null;
}

function normalizeList(value, keys) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const key of keys) {
      if (Array.isArray(value[key])) return value[key];
    }
  }
  return null;
}

/**
 * 把适配器返回的各种形状归一成「与输入等长的译文数组」。
 * 形状不符合就抛错：宁可在该批中断并允许恢复，也不能把译文错位对齐。
 */
function normalizeTranslations(result, batch) {
  let list = null;
  if (typeof result === 'string') {
    if (batch.length === 1) list = [result];
  } else {
    list = normalizeList(result, ['translations', 'segments', 'items', 'result', 'results', 'data']);
    // 也接受 {"0":"译文","1":"译文"} 这种按下标对象的形状
    if (!list && result && typeof result === 'object') {
      const keys = Object.keys(result);
      if (keys.length === batch.length && keys.every((key) => /^\d+$/.test(key))) {
        list = keys.sort((a, b) => Number(a) - Number(b)).map((key) => result[key]);
      }
    }
  }
  if (!Array.isArray(list)) throw new Error('翻译适配器返回格式不正确（应为等长数组）');
  if (list.length !== batch.length) {
    throw new Error(`翻译适配器返回 ${list.length} 条，期望 ${batch.length} 条`);
  }
  // 带 i 下标的对象允许乱序返回，按 i 重排后仍必须覆盖 0..n-1。
  if (list.every((item) => item && Number.isInteger(item.i))) {
    const sorted = [...list].sort((a, b) => a.i - b.i);
    if (!sorted.every((item, index) => item.i === index)) {
      throw new Error('翻译适配器返回的 i 不是完整的 0..n-1');
    }
    list = sorted;
  }
  return list.map((item, index) => {
    const text = typeof item === 'string'
      ? item
      : (item && typeof item === 'object'
        ? (typeof item.text === 'string' ? item.text : (typeof item.translation === 'string' ? item.translation : ''))
        : '');
    if (!text.trim()) throw new Error(`翻译适配器第 ${index + 1} 条译文为空`);
    return text;
  });
}

function normalizeAnswer(result) {
  if (typeof result === 'string') {
    if (!result.trim()) throw new Error('问答适配器返回空答案');
    return { answer: result.trim(), citations: [] };
  }
  if (!result || typeof result !== 'object') throw new Error('问答适配器返回格式不正确');
  const answer = [result.answer, result.content, result.text]
    .find((item) => typeof item === 'string' && item.trim());
  if (!answer) throw new Error('问答适配器未返回 answer');
  const citations = normalizeList(result, ['citations', 'sources', 'references', 'refs']) || [];
  return { answer: answer.trim(), citations };
}

/** 检索结果归一成 sid 数组；无法识别的条目直接丢弃（不猜）。 */
function normalizeSearchSids(result) {
  const list = normalizeList(result, ['results', 'hits', 'matches', 'items']) || [];
  const sids = [];
  for (const item of list) {
    if (typeof item === 'string') sids.push(item);
    else if (item && typeof item === 'object' && typeof item.sid === 'string') sids.push(item.sid);
    else if (item && typeof item === 'object' && typeof item.sentenceId === 'string') sids.push(item.sentenceId);
  }
  return sids;
}

module.exports = {
  normalizeAnswer,
  normalizeSearchSids,
  normalizeTranslations,
  resolveAdapter
};
