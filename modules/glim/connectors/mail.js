'use strict';
// Mail 连接器：查询本人邮件、读取正文、删除与经授权发信。
// 发信携带幂等键，同一个工具 operationId 重试不会重复投递。

const crypto = require('node:crypto');
const { request, joinPath, encodeSegment, contextToken, ConnectorError } = require('./http.js');

const MODULE_ID = 'mail';

const capabilities = [
  { name: 'mail_list_messages', access: 'read', externalEffect: false, description: '列出当前用户邮箱的邮件' },
  { name: 'mail_read_message', access: 'read', externalEffect: false, description: '读取指定邮件正文与附件信息' },
  { name: 'mail_delete_message', access: 'write', externalEffect: true, description: '删除指定邮件' },
  { name: 'mail_send', access: 'write', externalEffect: true, description: '以部署配置的系统身份发信（幂等）' }
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

function text(value, field, max = 200) {
  if (typeof value !== 'string' || !value.trim()) throw new ConnectorError('glim.tool_invalid_input', `${field} 必须是非空字符串`, 400);
  if (value.length > max) throw new ConnectorError('glim.tool_invalid_input', `${field} 过长`, 400);
  return value.trim();
}

const handlers = {
  async mail_list_messages(input, context) {
    const endpoint = baseOf(context);
    const params = new URLSearchParams();
    if (input.folder) params.set('folder', String(input.folder));
    if (Number.isSafeInteger(input.limit)) params.set('limit', String(Math.min(Math.max(input.limit, 1), 100)));
    if (Number.isSafeInteger(input.offset)) params.set('offset', String(Math.max(input.offset, 0)));
    const suffix = params.toString() ? `messages?${params}` : 'messages';
    const response = await request(joinPath(endpoint, suffix), { token: tokenOf(context) });
    return {
      messages: response.body && Array.isArray(response.body.messages) ? response.body.messages : [],
      total: response.body ? response.body.total : null,
      folder: response.body ? response.body.folder : input.folder || null
    };
  },

  async mail_read_message(input, context) {
    const endpoint = baseOf(context);
    const id = text(input.id, 'id', 200);
    const folder = input.folder ? `?folder=${encodeURIComponent(String(input.folder))}` : '';
    const response = await request(joinPath(endpoint, `messages/${encodeSegment(id)}${folder}`), { token: tokenOf(context) });
    return { message: response.body ? response.body.message : null };
  },

  async mail_delete_message(input, context) {
    const endpoint = baseOf(context);
    const id = text(input.id, 'id', 200);
    const params = input.folder ? `?folder=${encodeURIComponent(String(input.folder))}` : '';
    const response = await request(joinPath(endpoint, `messages/${encodeSegment(id)}${params}`), {
      method: 'DELETE',
      token: tokenOf(context)
    });
    return response.body || { deleted: true, id };
  },

  async mail_send(input, context) {
    const endpoint = baseOf(context);
    const body = {
      to: input.to,
      subject: typeof input.subject === 'string' ? input.subject : '',
      text: typeof input.text === 'string' ? input.text : '',
      idempotencyKey: typeof input.operationId === 'string' && input.operationId
        ? `glim_${input.operationId}`
        : `glim_${crypto.randomUUID()}`
    };
    if (typeof input.html === 'string' && input.html) body.html = input.html;
    if (!body.text && !body.html) throw new ConnectorError('glim.tool_invalid_input', 'text 或 html 至少提供一个', 400);
    if (Array.isArray(input.attachments)) {
      body.attachments = input.attachments.map((item) => ({
        filename: item.filename || item.name,
        contentType: item.contentType || item.type || 'application/octet-stream',
        contentBase64: item.contentBase64 || item.content
      }));
    }
    const response = await request(joinPath(endpoint, 'send'), { method: 'POST', token: tokenOf(context), body });
    return response.body || {};
  }
};

module.exports = { MODULE_ID, capabilities, handlers };
