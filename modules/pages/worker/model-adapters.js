'use strict';

const crypto = require('node:crypto');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function extractJson(text) {
  const trimmed = String(text || '').trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(unfenced); } catch { /* locate a JSON object below */ }
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('MODEL_INVALID_JSON');
  return JSON.parse(unfenced.slice(start, end + 1));
}

function validateResult(result) {
  if (!result || typeof result !== 'object' || !result.files || typeof result.files !== 'object' || Array.isArray(result.files)) {
    throw new Error('MODEL_INVALID_RESULT');
  }
  const entries = Object.entries(result.files);
  if (entries.length < 1 || entries.length > 50) throw new Error('MODEL_INVALID_RESULT');
  for (const [filePath, value] of entries) {
    if (typeof value !== 'string' && (!value || typeof value.content !== 'string')) throw new Error('MODEL_INVALID_RESULT');
    if (!filePath || filePath.length > 300) throw new Error('MODEL_INVALID_RESULT');
  }
  return {
    files: result.files,
    summary: typeof result.summary === 'string' ? result.summary.slice(0, 500) : '模型已返回文件修改',
    usage: result.usage && typeof result.usage === 'object' ? result.usage : null
  };
}

async function deterministicGenerate(payload, emit) {
  const prompt = payload.prompt.trim();
  await emit('reasoning', { text: '本地确定性测试模型正在生成合成页面；未调用任何外部模型。' });
  const marker = crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 12);
  const existing = payload.files['index.html'];
  let html;
  if (typeof existing === 'string' && existing.includes('</body>')) {
    html = existing.replace(/<meta\s+data-pagesai-test-marker[^>]*>/i, '').replace(
      '</body>',
      `<meta data-pagesai-test-marker="${marker}"><section class="pagesai-test-change"><h2>已按请求修改</h2><p>${escapeHtml(prompt)}</p></section></body>`
    );
  } else {
    html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta data-pagesai-test-marker="${marker}"><title>${escapeHtml(payload.site.name)}</title><style>body{font-family:system-ui,sans-serif;max-width:760px;margin:4rem auto;padding:0 1.5rem;color:#172033;background:#f6f8fc}main{background:white;padding:2rem;border-radius:1rem;box-shadow:0 8px 30px #17203318}code{color:#475569}</style></head><body><main><p>PagesAI 本地确定性验收</p><h1>${escapeHtml(payload.site.name)}</h1><p>${escapeHtml(prompt)}</p><p>验收标记：<code>${marker}</code></p></main></body></html>`;
  }
  await emit('output', { text: `已生成 index.html（测试标记 ${marker}）。` });
  return validateResult({ files: { 'index.html': html }, summary: '本地确定性测试模型完成合成页面修改', usage: { external: false, deterministic: true } });
}

async function openAiGenerate(payload, model, apiKey, emit, signal) {
  const base = model.baseUrl.replace(/\/+$/, '');
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: model.model,
      stream: true,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: '你是 PagesAI 网站修改器。只返回一个 JSON 对象，格式 {"files":{"index.html":"完整文件内容"},"summary":"简短说明"}。路径必须是站点相对路径；不得返回解释或 Markdown。保留现有功能，输出完整文件。' },
        { role: 'user', content: JSON.stringify({ prompt: payload.prompt, targetPath: payload.targetPath, site: payload.site, files: payload.files, materials: payload.materials.map(({ name, contentType, text }) => ({ name, contentType, text })) }) }
      ]
    }),
    signal
  });
  if (!response.ok) {
    await response.body.cancel().catch(() => {});
    throw new Error(`OPENAI_HTTP_${response.status}`);
  }
  if (!response.body) throw new Error('OPENAI_EMPTY_STREAM');
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage = null;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      const event = JSON.parse(data);
      const delta = event.choices && event.choices[0] && event.choices[0].delta && event.choices[0].delta.content;
      if (delta) {
        text += delta;
        if (text.length > 8 * 1024 * 1024) throw new Error('MODEL_OUTPUT_LIMIT');
        await emit('output', { text: delta });
      }
      if (event.usage) usage = event.usage;
    }
  }
  const result = validateResult({ ...extractJson(text), usage });
  return result;
}

async function generate(payload, model, { apiKey, allowTestModel, emit, signal }) {
  if (model.kind === 'deterministic-test') {
    if (!allowTestModel) throw new Error('TEST_MODEL_DISABLED');
    return deterministicGenerate(payload, emit);
  }
  if (model.kind === 'openai-compatible') return openAiGenerate(payload, model, apiKey, emit, signal);
  throw new Error('MODEL_KIND_UNSUPPORTED');
}

module.exports = { deterministicGenerate, openAiGenerate, extractJson, validateResult, generate };
