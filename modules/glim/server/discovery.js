'use strict';
// 已知模块目录与版本检查。
//
// 只读取部署提供的核心模块目录（/api/modules），不扫描局域网、不访问任意地址。
// 发现结果只是“是否安装/配置/可用/待授权”的状态说明，本身不授予任何数据权限。

const http = require('node:http');
const https = require('node:https');

const KNOWN_MODULES = Object.freeze(['pages', 'disk', 'mail', 'survey', 'paper']);
const MODULE_LABELS = Object.freeze({
  pages: 'Pages 网站',
  disk: 'Disk 网盘',
  mail: 'Mail 邮箱',
  survey: 'Survey 问卷',
  paper: 'Paper 论文'
});

function parseVersion(value) {
  const text = String(value === undefined || value === null ? '' : value).trim().replace(/^v/i, '');
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

function atLeast(actual, minimum) {
  if (!minimum) return true;
  const left = parseVersion(actual);
  const right = parseVersion(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return true;
}

function fetchDirectory(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      reject(Object.assign(new Error('模块目录地址不合法'), { code: 'glim.discovery_invalid_url', status: 400, expose: true }));
      return;
    }
    const transport = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null;
    if (!transport) {
      reject(Object.assign(new Error('模块目录只支持 http/https'), { code: 'glim.discovery_invalid_url', status: 400, expose: true }));
      return;
    }
    const req = transport.request(parsed, { method: 'GET', headers: { accept: 'application/json' }, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 512 * 1024) req.destroy(new Error('模块目录响应过大'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(Object.assign(new Error(`模块目录返回 ${res.statusCode || '未知状态'}`), { status: 502, expose: true }));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(Object.assign(new Error('模块目录响应不是合法 JSON'), { code: 'glim.discovery_incompatible', status: 502, expose: true }));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('模块目录请求超时')));
    req.on('error', reject);
    req.end();
  });
}

function capabilityNames(moduleId, fallback) {
  if (moduleId === 'pages' || moduleId === 'disk' || moduleId === 'mail' || moduleId === 'survey' || moduleId === 'paper') {
    // 延迟 require，避免目录探测在没有连接器能力时加载全部适配器。
    const connector = require(`../connectors/${moduleId}.js`);
    return connector.capabilities.map((item) => item.name);
  }
  return Array.isArray(fallback) ? fallback.map((item) => item.name).filter(Boolean) : [];
}

/**
 * 计算五个可选模块的相对状态。
 * @param {object} directory GET /api/modules 的响应
 * @param {object} options {minimums, grantedByModule:Set, registeredByModule:Set}
 */
function describeModules(directory, options = {}) {
  const modules = Array.isArray(directory && directory.modules) ? directory.modules : [];
  const byId = new Map(modules.map((item) => [item.id, item]));
  const minimums = options.minimums && typeof options.minimums === 'object' ? options.minimums : {};
  const granted = options.grantedByModule instanceof Set ? options.grantedByModule : new Set();
  const registered = options.registeredByModule instanceof Set ? options.registeredByModule : new Set();
  const results = [];
  for (const moduleId of KNOWN_MODULES) {
    const entry = byId.get(moduleId) || null;
    const minimum = typeof minimums[moduleId] === 'string' ? minimums[moduleId] : null;
    const version = entry && typeof entry.version === 'string' ? entry.version : null;
    const compatible = entry ? atLeast(version, minimum) : false;
    let status;
    let reason = null;
    if (!entry || entry.installed === false) {
      status = 'not-installed';
      reason = '该模块未安装';
    } else if (entry.configured === false) {
      status = 'not-configured';
      reason = '已登记但配置不完整';
    } else if (entry.ready !== true) {
      status = 'unavailable';
      reason = entry.startError || '模块未就绪';
    } else if (!compatible) {
      status = 'incompatible';
      reason = `模块版本 ${version || '未知'} 低于要求 ${minimum}`;
    } else if (granted.has(moduleId)) {
      status = 'available';
      reason = null;
    } else {
      status = 'pending-auth';
      reason = registered.has(moduleId) ? '已登记连接，等待授权' : '尚未登记为该用户的连接';
    }
    results.push({
      moduleId,
      label: MODULE_LABELS[moduleId],
      status,
      reason,
      version,
      minimumVersion: minimum,
      compatible,
      registered: registered.has(moduleId),
      granted: granted.has(moduleId),
      endpointPath: entry && typeof entry.routePrefix === 'string' ? entry.routePrefix : null,
      capabilities: entry ? capabilityNames(moduleId, entry.capabilities) : []
    });
  }
  return results;
}

module.exports = { KNOWN_MODULES, MODULE_LABELS, describeModules, fetchDirectory, parseVersion, atLeast };
