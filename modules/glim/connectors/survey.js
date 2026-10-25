'use strict';
// Survey 连接器：创建/编辑、经授权发布、读取本人答卷与统计、导出 CSV。
// 所有权与发布快照由 Survey 模块裁决，连接器只转发现有语义。

const { request, joinPath, encodeSegment, contextToken, ConnectorError } = require('./http.js');

const MODULE_ID = 'survey';

const capabilities = [
  { name: 'survey_list', access: 'read', externalEffect: false, description: '列出当前用户创建的问卷' },
  { name: 'survey_read', access: 'read', externalEffect: false, description: '读取问卷草稿与题目' },
  { name: 'survey_create', access: 'write', externalEffect: true, description: '创建问卷草稿' },
  { name: 'survey_update', access: 'write', externalEffect: true, description: '修改问卷草稿' },
  { name: 'survey_publish', access: 'write', externalEffect: true, description: '发布问卷并回读公开快照' },
  { name: 'survey_close', access: 'write', externalEffect: true, description: '关闭问卷' },
  { name: 'survey_responses', access: 'read', externalEffect: false, description: '读取本人问卷的答卷' },
  { name: 'survey_stats', access: 'read', externalEffect: false, description: '读取本人问卷的基础统计' },
  { name: 'survey_export', access: 'read', externalEffect: false, description: '导出本人问卷的 CSV' }
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

function idOf(input, field = 'surveyId') {
  const value = input[field] !== undefined ? input[field] : input.id;
  if (typeof value !== 'string' || !value.trim()) throw new ConnectorError('glim.tool_invalid_input', `${field} 必须是非空字符串`, 400);
  return value.trim();
}

function draftOf(input) {
  const body = {};
  if (input.title !== undefined) body.title = input.title;
  if (input.description !== undefined) body.description = input.description;
  if (input.questions !== undefined) body.questions = input.questions;
  return body;
}

const handlers = {
  async survey_list(input, context) {
    const endpoint = baseOf(context);
    const status = input.status ? `?status=${encodeURIComponent(String(input.status))}` : '';
    const response = await request(joinPath(endpoint, `surveys${status}`), { token: tokenOf(context) });
    return { surveys: response.body && Array.isArray(response.body.surveys) ? response.body.surveys : [] };
  },

  async survey_read(input, context) {
    const endpoint = baseOf(context);
    const response = await request(joinPath(endpoint, `surveys/${encodeSegment(idOf(input))}`), { token: tokenOf(context) });
    return { survey: response.body ? response.body.survey : null };
  },

  async survey_create(input, context) {
    const endpoint = baseOf(context);
    const response = await request(joinPath(endpoint, 'surveys'), {
      method: 'POST',
      token: tokenOf(context),
      body: draftOf(input)
    });
    return { survey: response.body ? response.body.survey : null };
  },

  async survey_update(input, context) {
    const endpoint = baseOf(context);
    const body = draftOf(input);
    if (Object.keys(body).length === 0) throw new ConnectorError('glim.tool_invalid_input', '没有可更新的字段', 400);
    const response = await request(joinPath(endpoint, `surveys/${encodeSegment(idOf(input))}`), {
      method: 'PATCH',
      token: tokenOf(context),
      body
    });
    return { survey: response.body ? response.body.survey : null };
  },

  async survey_publish(input, context) {
    const endpoint = baseOf(context);
    const response = await request(joinPath(endpoint, `surveys/${encodeSegment(idOf(input))}/publish`), {
      method: 'POST',
      token: tokenOf(context),
      body: {}
    });
    const result = response.body || {};
    let readBack = null;
    if (result.publicPath) {
      try {
        const publicResponse = await request(joinPath(endpoint, result.publicPath.replace(/^\/api\/survey\//, '')), { json: true });
        readBack = { ok: true, title: publicResponse.body && publicResponse.body.survey ? publicResponse.body.survey.title : null };
      } catch (error) {
        readBack = { ok: false, status: error.status || 502, code: error.code || 'glim.connector_error' };
      }
    }
    return { ...result, readBack };
  },

  async survey_close(input, context) {
    const endpoint = baseOf(context);
    const response = await request(joinPath(endpoint, `surveys/${encodeSegment(idOf(input))}/close`), {
      method: 'POST',
      token: tokenOf(context),
      body: {}
    });
    return { survey: response.body ? response.body.survey : null };
  },

  async survey_responses(input, context) {
    const endpoint = baseOf(context);
    const response = await request(joinPath(endpoint, `surveys/${encodeSegment(idOf(input))}/responses`), { token: tokenOf(context) });
    return response.body || {};
  },

  async survey_stats(input, context) {
    const endpoint = baseOf(context);
    const response = await request(joinPath(endpoint, `surveys/${encodeSegment(idOf(input))}/stats`), { token: tokenOf(context) });
    return { stats: response.body ? response.body.stats : null };
  },

  async survey_export(input, context) {
    const endpoint = baseOf(context);
    const response = await request(joinPath(endpoint, `surveys/${encodeSegment(idOf(input))}/export.csv`), { token: tokenOf(context) });
    return { csv: typeof response.body === 'string' ? response.body : '' };
  }
};

module.exports = { MODULE_ID, capabilities, handlers };
