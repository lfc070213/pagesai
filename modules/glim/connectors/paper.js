'use strict';
// Paper 连接器：查询本人论文、读取正文片段、发起翻译、结合文献问答。
// 翻译与问答未配置适配器时如实返回 409，不制造译文或来源。

const { request, joinPath, encodeSegment, contextToken, ConnectorError } = require('./http.js');

const MODULE_ID = 'paper';

const capabilities = [
  { name: 'paper_search', access: 'read', externalEffect: false, description: '在本人论文库中按标题检索' },
  { name: 'paper_list_docs', access: 'read', externalEffect: false, description: '列出本人论文' },
  { name: 'paper_read_doc', access: 'read', externalEffect: false, description: '读取论文结构与正文片段' },
  { name: 'paper_upload_doc', access: 'write', externalEffect: true, description: '上传论文（PDF/TXT，Base64）' },
  { name: 'paper_translate_doc', access: 'write', externalEffect: false, description: '发起或继续翻译任务' },
  { name: 'paper_get_translation', access: 'read', externalEffect: false, description: '读取翻译进度与对齐文本' },
  { name: 'paper_ask_doc', access: 'read', externalEffect: false, description: '基于论文真实片段问答' },
  { name: 'paper_delete_doc', access: 'write', externalEffect: true, description: '删除本人论文及其产物' }
];

function baseOf(context) {
  const endpoint = context && context.connector ? context.connector.endpoint : null;
  if (typeof endpoint !== 'string' || !endpoint) throw new ConnectorError('glim.connector_missing_endpoint', '连接缺少 endpoint', 409);
  return endpoint;
}

function tokenOf(context) {
  const token = contextToken(context);
  if (!token) throw new ConnectorError('glim.connector_no_session', '缺少当前用户会话，拒绝代调', 403);
  return token;
}

function docIdOf(input) {
  const value = input.docId !== undefined ? input.docId : input.id;
  if (typeof value !== 'string' || !value.trim()) throw new ConnectorError('glim.tool_invalid_input', 'docId 必须是非空字符串', 400);
  return value.trim();
}

async function listDocs(endpoint, token) {
  const response = await request(joinPath(endpoint, 'docs'), { token });
  return response.body && Array.isArray(response.body.docs) ? response.body.docs : [];
}

const handlers = {
  async paper_list_docs(input, context) {
    const endpoint = baseOf(context);
    return { docs: await listDocs(endpoint, tokenOf(context)) };
  },

  async paper_search(input, context) {
    const endpoint = baseOf(context);
    const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
    if (!query) throw new ConnectorError('glim.tool_invalid_input', 'query 必须是非空字符串', 400);
    const docs = await listDocs(endpoint, tokenOf(context));
    const matched = docs.filter((doc) => `${doc.title || ''} ${doc.filename || ''}`.toLowerCase().includes(query));
    return { query, docs: matched };
  },

  async paper_read_doc(input, context) {
    const endpoint = baseOf(context);
    const response = await request(joinPath(endpoint, `docs/${encodeSegment(docIdOf(input))}`), { token: tokenOf(context) });
    return response.body || {};
  },

  async paper_upload_doc(input, context) {
    const endpoint = baseOf(context);
    if (typeof input.filename !== 'string' || !input.filename.trim()) throw new ConnectorError('glim.tool_invalid_input', 'filename 必须是非空字符串', 400);
    if (typeof input.contentBase64 !== 'string' || !input.contentBase64) throw new ConnectorError('glim.tool_invalid_input', 'contentBase64 必须是非空字符串', 400);
    const response = await request(joinPath(endpoint, 'docs'), {
      method: 'POST',
      token: tokenOf(context),
      body: { filename: input.filename.trim(), contentBase64: input.contentBase64 },
      timeoutMs: 120000,
      maxBytes: 4 * 1024 * 1024
    });
    return response.body || {};
  },

  async paper_translate_doc(input, context) {
    const endpoint = baseOf(context);
    const body = { restart: input.restart === true };
    if (typeof input.targetLang === 'string' && input.targetLang) body.targetLang = input.targetLang;
    const response = await request(joinPath(endpoint, `docs/${encodeSegment(docIdOf(input))}/translate`), {
      method: 'POST',
      token: tokenOf(context),
      body,
      timeoutMs: 300000
    });
    return response.body || {};
  },

  async paper_get_translation(input, context) {
    const endpoint = baseOf(context);
    const params = new URLSearchParams();
    if (typeof input.targetLang === 'string' && input.targetLang) params.set('targetLang', input.targetLang);
    params.set('include', 'text');
    const response = await request(joinPath(endpoint, `docs/${encodeSegment(docIdOf(input))}/translate?${params}`), {
      token: tokenOf(context),
      timeoutMs: 120000
    });
    return response.body || {};
  },

  async paper_ask_doc(input, context) {
    const endpoint = baseOf(context);
    if (typeof input.question !== 'string' || !input.question.trim()) throw new ConnectorError('glim.tool_invalid_input', 'question 必须是非空字符串', 400);
    const body = { question: input.question.trim() };
    if (Number.isSafeInteger(input.topK)) body.topK = input.topK;
    const response = await request(joinPath(endpoint, `docs/${encodeSegment(docIdOf(input))}/ask`), {
      method: 'POST',
      token: tokenOf(context),
      body,
      timeoutMs: 120000
    });
    return response.body || {};
  },

  async paper_delete_doc(input, context) {
    const endpoint = baseOf(context);
    const response = await request(joinPath(endpoint, `docs/${encodeSegment(docIdOf(input))}`), {
      method: 'DELETE',
      token: tokenOf(context)
    });
    return response.body || { deleted: true };
  }
};

module.exports = { MODULE_ID, capabilities, handlers };
