'use strict';
// Glim 连接器的 HTTP 客户端。
//
// 只允许把当前请求的会话令牌转发给已登记的同源模块；不保存、不打印令牌。
// 响应体有上限，超时与中断都可取消；非 2xx 统一转换为可展示的连接器错误。

const http = require('node:http');
const https = require('node:https');

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_BYTES = 32 * 1024 * 1024;

class ConnectorError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
    this.status = status;
    this.expose = true;
  }
}

function request(url, { method = 'GET', token = null, body = null, timeoutMs = DEFAULT_TIMEOUT_MS, signal = null, json = true, maxBytes = json ? MAX_JSON_BYTES : MAX_BINARY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = url instanceof URL ? url : new URL(String(url));
    } catch {
      reject(new ConnectorError('glim.connector_invalid_endpoint', '连接地址不合法', 400));
      return;
    }
    const transport = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null;
    if (!transport) {
      reject(new ConnectorError('glim.connector_invalid_endpoint', '连接地址只支持 http/https', 400));
      return;
    }
    const payload = body === null || body === undefined
      ? null
      : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { accept: json ? 'application/json' : '*/*' };
    if (payload) {
      headers['content-type'] = Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json';
      headers['content-length'] = String(payload.length);
    }
    if (token) headers.authorization = `Bearer ${token}`;

    let aborted = false;
    const req = transport.request(parsed, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new ConnectorError('glim.connector_too_large', '连接响应超过大小上限', 502));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', (error) => reject(error instanceof ConnectorError ? error : new ConnectorError('glim.connector_unavailable', '连接服务不可用', 502)));
      res.on('end', () => {
        if (aborted) return;
        const data = Buffer.concat(chunks);
        const status = res.statusCode || 0;
        let parsedBody = null;
        if (json) {
          const text = data.toString('utf8');
          if (text) {
            try {
              parsedBody = JSON.parse(text);
            } catch {
              reject(new ConnectorError('glim.connector_incompatible', '连接服务返回了非 JSON 响应', 502));
              return;
            }
          }
        }
        if (status < 200 || status >= 300) {
          const code = parsedBody && typeof parsedBody.code === 'string' ? parsedBody.code : 'glim.connector_error';
          const message = parsedBody && typeof parsedBody.message === 'string'
            ? parsedBody.message
            : `连接服务返回 HTTP ${status}`;
          reject(new ConnectorError(code, message, status === 401 || status === 403 ? 403 : 502));
          return;
        }
        resolve({ status, body: json ? parsedBody : data, headers: res.headers });
      });
    });
    const onAbort = () => {
      aborted = true;
      req.destroy(new ConnectorError('glim.tool_aborted', '工具调用已停止', 409));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('timeout', () => req.destroy(new ConnectorError('glim.connector_timeout', '连接服务超时', 504)));
    req.on('error', (error) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(error instanceof ConnectorError ? error : new ConnectorError('glim.connector_unavailable', '连接服务不可用', 502));
    });
    req.on('close', () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    });
    req.end(payload || undefined);
  });
}

function joinPath(base, suffix) {
  const root = String(base).replace(/\/+$/, '');
  const tail = String(suffix || '').replace(/^\/+/, '');
  return tail ? `${root}/${tail}` : root;
}

function encodeSegment(value) {
  return encodeURIComponent(String(value));
}

function contextToken(context) {
  const req = context && context.req;
  const headers = req && req.headers ? req.headers : {};
  const raw = headers.authorization || headers.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return match ? match[1] : null;
}

module.exports = { request, joinPath, encodeSegment, contextToken, ConnectorError };
