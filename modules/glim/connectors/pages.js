'use strict';
// Pages 连接器：通过 Pages 模块的正式 HTTP 接口操作当前用户自己的站点。
// 不 require 其他模块，不绕过站点所有权、slug 唯一与发布快照规则。

const { request, joinPath, encodeSegment, contextToken, ConnectorError } = require('./http.js');

const MODULE_ID = 'pages';

const capabilities = [
  { name: 'pages_list_sites', access: 'read', externalEffect: false, description: '列出当前用户的站点' },
  { name: 'pages_read_site', access: 'read', externalEffect: false, description: '读取站点详情与文件列表' },
  { name: 'pages_create_site', access: 'write', externalEffect: true, description: '创建一个站点' },
  { name: 'pages_write_file', access: 'write', externalEffect: true, description: '写入或修改站点文件' },
  { name: 'pages_read_file', access: 'read', externalEffect: false, description: '读取站点文件内容' },
  { name: 'pages_delete_file', access: 'write', externalEffect: true, description: '删除站点文件' },
  { name: 'pages_preview_site', access: 'read', externalEffect: false, description: '获取站点草稿预览地址并回读' },
  { name: 'pages_publish_site', access: 'write', externalEffect: true, description: '发布站点并回读公开地址' }
];

function baseOf(context) {
  const endpoint = context && context.connector ? context.connector.endpoint : null;
  if (typeof endpoint !== 'string' || !endpoint) throw new ConnectorError('glim.connector_missing_endpoint', '连接缺少 endpoint', 409);
  return endpoint;
}

function tokenOf(context) {
  const token = contextToken(context);
  if (!token) throw new ConnectorError('glim.connector_no_session', '缺少当前用户会话，拒绝以管理员身份代调', 403);
  return token;
}

function text(value, field, max = 500) {
  if (typeof value !== 'string' || !value.trim()) throw new ConnectorError('glim.tool_invalid_input', `${field} 必须是非空字符串`, 400);
  if (value.length > max) throw new ConnectorError('glim.tool_invalid_input', `${field} 过长`, 400);
  return value;
}

async function getSite(context, endpoint, siteId) {
  const response = await request(joinPath(endpoint, `sites/${encodeSegment(siteId)}`), { token: tokenOf(context) });
  return response.body && response.body.site ? response.body.site : null;
}

function publicUrl(endpoint, publicPath, filePath = 'index.html') {
  const root = String(publicPath).endsWith('/') ? publicPath : `${publicPath}/`;
  // 公开路径由 Pages 自己声明，可能是 /api/pages/public/... 这样的同源绝对路径。
  return new URL(`${root}${filePath}`.replace(/^\/\//, '/'), endpoint).toString();
}

async function readPublic(context, endpoint, publicPath, filePath = 'index.html') {
  const url = publicUrl(endpoint, publicPath, filePath);
  try {
    const response = await request(url, { json: false, maxBytes: 512 * 1024 });
    return { ok: true, status: response.status, bytes: response.body.length };
  } catch (error) {
    return { ok: false, status: error.status || 502, code: error.code || 'glim.connector_error' };
  }
}

const handlers = {
  async pages_list_sites(input, context) {
    const endpoint = baseOf(context);
    const response = await request(joinPath(endpoint, 'sites'), { token: tokenOf(context) });
    return { sites: response.body && Array.isArray(response.body.sites) ? response.body.sites : [] };
  },

  async pages_read_site(input, context) {
    const endpoint = baseOf(context);
    const site = await getSite(context, endpoint, text(input.siteId, 'siteId', 128));
    if (!site) throw new ConnectorError('glim.connector_incompatible', 'Pages 返回的站点数据不完整', 502);
    return { site };
  },

  async pages_create_site(input, context) {
    const endpoint = baseOf(context);
    const body = { name: text(input.name, 'name', 80) };
    if (typeof input.slug === 'string' && input.slug.trim()) body.slug = input.slug.trim();
    if (typeof input.description === 'string') body.description = input.description.slice(0, 500);
    const response = await request(joinPath(endpoint, 'sites'), { method: 'POST', token: tokenOf(context), body });
    return { site: response.body && response.body.site ? response.body.site : null };
  },

  async pages_write_file(input, context) {
    const endpoint = baseOf(context);
    const siteId = text(input.siteId, 'siteId', 128);
    const filePath = text(input.path, 'path', 512);
    if (typeof input.content !== 'string') throw new ConnectorError('glim.tool_invalid_input', 'content 必须是字符串', 400);
    const body = { content: input.content };
    if (typeof input.contentType === 'string' && input.contentType.trim()) body.contentType = input.contentType.trim();
    const response = await request(joinPath(endpoint, `sites/${encodeSegment(siteId)}/files/${filePath.split('/').map(encodeSegment).join('/')}`), {
      method: 'PUT',
      token: tokenOf(context),
      body
    });
    return { file: response.body && response.body.file ? response.body.file : null };
  },

  async pages_read_file(input, context) {
    const endpoint = baseOf(context);
    const siteId = text(input.siteId, 'siteId', 128);
    const filePath = text(input.path, 'path', 512);
    const response = await request(joinPath(endpoint, `sites/${encodeSegment(siteId)}/files/${filePath.split('/').map(encodeSegment).join('/')}`), {
      token: tokenOf(context)
    });
    return { file: response.body && response.body.file ? response.body.file : null };
  },

  async pages_delete_file(input, context) {
    const endpoint = baseOf(context);
    const siteId = text(input.siteId, 'siteId', 128);
    const filePath = text(input.path, 'path', 512);
    const response = await request(joinPath(endpoint, `sites/${encodeSegment(siteId)}/files/${filePath.split('/').map(encodeSegment).join('/')}`), {
      method: 'DELETE',
      token: tokenOf(context)
    });
    return response.body || { ok: true };
  },

  async pages_preview_site(input, context) {
    const endpoint = baseOf(context);
    const site = await getSite(context, endpoint, text(input.siteId, 'siteId', 128));
    if (!site || typeof site.previewPath !== 'string') {
      throw new ConnectorError('glim.connector_incompatible', '该部署的 Pages 未提供草稿预览地址', 409);
    }
    const previewUrl = publicUrl(endpoint, site.previewPath);
    const readBack = await readPublic(context, endpoint, site.previewPath, 'index.html');
    return { siteId: site.id, previewUrl, readBack };
  },

  async pages_publish_site(input, context) {
    const endpoint = baseOf(context);
    const siteId = text(input.siteId, 'siteId', 128);
    const published = await request(joinPath(endpoint, `sites/${encodeSegment(siteId)}/publish`), {
      method: 'POST',
      token: tokenOf(context),
      body: {}
    });
    const result = published.body || {};
    if (!result.publicPath) throw new ConnectorError('glim.connector_incompatible', 'Pages 发布响应缺少 publicPath', 502);
    const readBack = await readPublic(context, endpoint, result.publicPath, 'index.html');
    return { ...result, readBack };
  }
};

module.exports = { MODULE_ID, capabilities, handlers };
