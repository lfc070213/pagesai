'use strict';
// Disk 连接器：通过 Disk 模块正式 HTTP 接口操作当前用户文件。
// 上传走 init → 顺序分块 → complete，条件写入与配额由 Disk 服务端裁决。

const crypto = require('node:crypto');
const { request, joinPath, encodeSegment, contextToken, ConnectorError } = require('./http.js');

const MODULE_ID = 'disk';
const MAX_TOOL_FILE_BYTES = 4 * 1024 * 1024;

const capabilities = [
  { name: 'disk_list_files', access: 'read', externalEffect: false, description: '列出当前用户的文件' },
  { name: 'disk_list_folders', access: 'read', externalEffect: false, description: '列出当前用户的文件夹' },
  { name: 'disk_read_file', access: 'read', externalEffect: false, description: '读取文件内容（Base64）' },
  { name: 'disk_write_file', access: 'write', externalEffect: true, description: '上传新文件或覆盖已有文件' },
  { name: 'disk_move_file', access: 'write', externalEffect: true, description: '重命名或移动文件' },
  { name: 'disk_delete_file', access: 'write', externalEffect: true, description: '删除文件（软删，可恢复）' },
  { name: 'disk_create_folder', access: 'write', externalEffect: true, description: '创建文件夹' },
  { name: 'disk_quota', access: 'read', externalEffect: false, description: '读取配额与用量' }
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

function requireText(value, field, max = 512) {
  if (typeof value !== 'string' || !value.trim()) throw new ConnectorError('glim.tool_invalid_input', `${field} 必须是非空字符串`, 400);
  if (value.length > max) throw new ConnectorError('glim.tool_invalid_input', `${field} 过长`, 400);
  return value.trim();
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function listAllFolders(endpoint, token) {
  const response = await request(joinPath(endpoint, 'folders'), { token });
  return response.body && Array.isArray(response.body.folders) ? response.body.folders : [];
}

const handlers = {
  async disk_list_files(input, context) {
    const endpoint = baseOf(context);
    const folderId = input.folderId ? encodeURIComponent(String(input.folderId)) : '';
    const response = await request(joinPath(endpoint, `files${folderId ? `?folderId=${folderId}` : ''}`), { token: tokenOf(context) });
    return {
      files: response.body && Array.isArray(response.body.files) ? response.body.files : [],
      quota: response.body ? response.body.quota || null : null
    };
  },

  async disk_list_folders(input, context) {
    const endpoint = baseOf(context);
    const parentId = input.parentId ? `?parentId=${encodeURIComponent(String(input.parentId))}` : '';
    const response = await request(joinPath(endpoint, `folders${parentId}`), { token: tokenOf(context) });
    return { folders: response.body && Array.isArray(response.body.folders) ? response.body.folders : [] };
  },

  async disk_quota(input, context) {
    const endpoint = baseOf(context);
    const response = await request(joinPath(endpoint, 'quota'), { token: tokenOf(context) });
    return response.body || {};
  },

  async disk_read_file(input, context) {
    const endpoint = baseOf(context);
    const fileId = requireText(input.fileId, 'fileId', 128);
    const response = await request(joinPath(endpoint, `files/${encodeSegment(fileId)}/content`), {
      token: tokenOf(context),
      json: false,
      maxBytes: MAX_TOOL_FILE_BYTES
    });
    return {
      fileId,
      contentType: response.headers['content-type'] || 'application/octet-stream',
      contentBase64: response.body.toString('base64'),
      size: response.body.length
    };
  },

  async disk_write_file(input, context) {
    const endpoint = baseOf(context);
    const token = tokenOf(context);
    const name = requireText(input.name, 'name', 255);
    let buffer;
    if (typeof input.contentBase64 === 'string') {
      buffer = Buffer.from(input.contentBase64, 'base64');
    } else if (typeof input.content === 'string') {
      buffer = Buffer.from(input.content, 'utf8');
    } else {
      throw new ConnectorError('glim.tool_invalid_input', '需要 content 或 contentBase64', 400);
    }
    if (buffer.length > MAX_TOOL_FILE_BYTES) throw new ConnectorError('glim.tool_invalid_input', '工具上传文件超过 4 MiB 上限', 413);
    const operationId = typeof input.operationId === 'string' && input.operationId
      ? input.operationId
      : `glim_${crypto.randomUUID()}`;
    const initBody = {
      name,
      size: buffer.length,
      sha256: sha256(buffer),
      mimeType: typeof input.mimeType === 'string' && input.mimeType ? input.mimeType : 'application/octet-stream',
      operationId
    };
    if (input.folderId) initBody.folderId = String(input.folderId);
    if (input.fileId) {
      if (!Number.isSafeInteger(input.baseRevision)) {
        throw new ConnectorError('glim.tool_invalid_input', '覆盖已有文件必须提供 baseRevision', 400);
      }
      initBody.fileId = String(input.fileId);
      initBody.baseRevision = input.baseRevision;
    } else {
      initBody.baseRevision = 0;
    }
    const init = await request(joinPath(endpoint, 'uploads/init'), { method: 'POST', token, body: initBody });
    const info = init.body || {};
    const chunkSize = Number.isSafeInteger(info.chunkSize) && info.chunkSize > 0 ? info.chunkSize : buffer.length || 1;
    let index = 0;
    for (let offset = 0; offset < buffer.length; offset += chunkSize) {
      const chunk = buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length));
      await request(joinPath(endpoint, `uploads/${encodeSegment(info.uploadId)}/chunks/${index}`), {
        method: 'PUT',
        token,
        body: { data: chunk.toString('base64'), sha256: sha256(chunk) }
      });
      index += 1;
    }
    const completed = await request(joinPath(endpoint, `uploads/${encodeSegment(info.uploadId)}/complete`), {
      method: 'POST',
      token,
      body: {}
    });
    return { operationId, file: completed.body && completed.body.file ? completed.body.file : null };
  },

  async disk_move_file(input, context) {
    const endpoint = baseOf(context);
    const fileId = requireText(input.fileId, 'fileId', 128);
    if (!Number.isSafeInteger(input.baseRevision)) {
      throw new ConnectorError('glim.tool_invalid_input', 'baseRevision 必须是整数', 400);
    }
    const body = { baseRevision: input.baseRevision };
    if (typeof input.name === 'string' && input.name.trim()) body.name = input.name.trim();
    if (input.folderId !== undefined) body.folderId = input.folderId === null ? null : String(input.folderId);
    if (body.name === undefined && body.folderId === undefined) {
      throw new ConnectorError('glim.tool_invalid_input', '需要 name 或 folderId', 400);
    }
    const response = await request(joinPath(endpoint, `files/${encodeSegment(fileId)}`), { method: 'PATCH', token: tokenOf(context), body });
    return { file: response.body && response.body.file ? response.body.file : null };
  },

  async disk_delete_file(input, context) {
    const endpoint = baseOf(context);
    const fileId = requireText(input.fileId, 'fileId', 128);
    if (!Number.isSafeInteger(input.baseRevision)) {
      throw new ConnectorError('glim.tool_invalid_input', 'baseRevision 必须是整数', 400);
    }
    const response = await request(joinPath(endpoint, `files/${encodeSegment(fileId)}/delete`), {
      method: 'POST',
      token: tokenOf(context),
      body: { baseRevision: input.baseRevision }
    });
    return response.body || { deleted: true, fileId };
  },

  async disk_create_folder(input, context) {
    const endpoint = baseOf(context);
    const body = { name: requireText(input.name, 'name', 255) };
    if (input.parentId) body.parentId = String(input.parentId);
    if (typeof input.operationId === 'string' && input.operationId) body.operationId = input.operationId;
    const response = await request(joinPath(endpoint, 'folders'), { method: 'POST', token: tokenOf(context), body });
    return { folder: response.body && response.body.folder ? response.body.folder : null };
  }
};

module.exports = { MODULE_ID, capabilities, handlers, listAllFolders };
