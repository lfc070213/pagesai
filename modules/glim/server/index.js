'use strict';
// Glim 模块（公开版，方案 §7.4）：可单独运行的智能体闭环。
//
// 范围（严格按任务书，不扩散）：
//  1. 会话与消息：/api/glim/sessions、/api/glim/sessions/:id/messages，按用户隔离；
//  2. 长期记忆：每用户一条，GET/PUT /api/glim/memory，带长度上限；
//  3. 模型适配：只使用部署者提供的 config.chatAdapter；未配置返回 409，绝不模拟回复；
//  4. 连接登记与授权：POST/GET /api/glim/connectors、grant/revoke；不做任何局域网扫描；
//  5. 工具调用：GET /api/glim/tools 只列已授权且 implemented 的能力；invoke 未授权 403、不兼容 409；
//  6. 身份：只信任 ctx.user；缺失即拒绝，没有固定 owner 回落；
//  7. 工作区：每用户受限文件区，可被模型以工作区工具读写；
//  8. 模块发现：只读部署提供的模块目录，按版本/状态/授权给出结论，发现本身不授予数据权限；
//  9. 任务：可排队、停止与恢复；重启后中断任务如实标记为 interrupted，可恢复；
// 10. 审计：工具调用记录来源、结果与耗时，不记录参数内容或令牌。
//
// 依赖：仅 Node 内置模块 + 公共核心 core/storage/json-store.js + 本模块 connectors/。
// 不 require 旧 source/site 代码。

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { JsonStore } = require('../../../core/storage/json-store');
const connectors = require('../connectors/index.js');
const { createWorkspace } = require('./workspace.js');
const { TaskRunner } = require('./tasks.js');
const discovery = require('./discovery.js');

const ROUTE_PREFIX = '/api/glim';
const MODEL_NOT_CONFIGURED = 'glim.model_not_configured';
const MODEL_FAILED = 'glim.model_failed';
const CAPABILITY_NAME = /^[a-z][a-z0-9_]{2,47}$/;
const ACCESS_VALUES = new Set(['read', 'write']);
const CLIENT_ROLES = new Set(['user', 'assistant']);
const MODULE_PREFIXES = Object.freeze({
  pages: '/api/pages',
  disk: '/api/disk',
  mail: '/api/mail',
  survey: '/api/survey',
  paper: '/api/paper'
});

const DEFAULTS = Object.freeze({
  memoryMaxChars: 4000,
  messageMaxChars: 8000,
  historyLimit: 50,
  maxConnectorsPerUser: 20,
  maxWorkspaceFileBytes: 2 * 1024 * 1024,
  maxWorkspaceFiles: 200,
  maxWorkspaceTotalBytes: 20 * 1024 * 1024,
  maxToolRounds: 4,
  maxRunningTasksPerUser: 1,
  auditLimit: 1000
});

// 集成方注入的本机适配器。真实连接器通过 connectors/ 按 moduleId 解析；
// 只有“已登记 connector 声明 moduleId 且用户已授权”时才会调用，绝不按同名猜测。
const tools = {};

/** 当前运行状态；start() 建立，stop() 清除。只保存非秘密对象。 */
let state = null;

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return crypto.randomUUID();
}

function ok(status, body) {
  return { status, body };
}

function fail(status, code, message) {
  // 统一错误形状：只暴露 code/message，不携带内部细节或秘密。
  return { status, body: { code, message } };
}

function notStarted() {
  return fail(503, 'glim.not_started', 'Glim 模块尚未启动');
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) return fallback;
  return number;
}

function codepointLength(value) {
  return Array.from(String(value)).length;
}

function normalizeLogger(logger) {
  return {
    info: (...args) => {
      if (logger && typeof logger.info === 'function') logger.info(...args);
    },
    warn: (...args) => {
      if (logger && typeof logger.warn === 'function') logger.warn(...args);
    },
    error: (...args) => {
      if (logger && typeof logger.error === 'function') logger.error(...args);
    }
  };
}

function normalizeOrigins(raw) {
  const configured = Array.isArray(raw) && raw.length > 0;
  const origins = [];
  if (configured) {
    for (const item of raw) {
      try {
        const url = new URL(String(item).trim());
        if (url.protocol === 'http:' || url.protocol === 'https:') origins.push(url.origin);
      } catch {
        // 非法白名单项不放大权限；若全部非法，则任何来源都无法匹配。
      }
    }
  }
  return { configured, origins: [...new Set(origins)] };
}

function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const origins = normalizeOrigins(config.trustedConnectorOrigins);
  return {
    ...config,
    dataFile: typeof config.dataFile === 'string' && config.dataFile.length > 0 ? config.dataFile : null,
    memoryMaxChars: clampInt(config.memoryMaxChars, DEFAULTS.memoryMaxChars, 1, 100000),
    messageMaxChars: clampInt(config.messageMaxChars, DEFAULTS.messageMaxChars, 1, 50000),
    historyLimit: clampInt(config.historyLimit, DEFAULTS.historyLimit, 1, 500),
    maxConnectorsPerUser: clampInt(config.maxConnectorsPerUser, DEFAULTS.maxConnectorsPerUser, 1, 500),
    workspaceRoot: typeof config.workspaceRoot === 'string' && config.workspaceRoot.trim() ? config.workspaceRoot.trim() : null,
    maxWorkspaceFileBytes: clampInt(config.maxWorkspaceFileBytes, DEFAULTS.maxWorkspaceFileBytes, 1024, 32 * 1024 * 1024),
    maxWorkspaceFiles: clampInt(config.maxWorkspaceFiles, DEFAULTS.maxWorkspaceFiles, 1, 5000),
    maxWorkspaceTotalBytes: clampInt(config.maxWorkspaceTotalBytes, DEFAULTS.maxWorkspaceTotalBytes, 1024, 1024 * 1024 * 1024),
    moduleDirectoryUrl: normalizeHttpUrl(config.moduleDirectoryUrl),
    moduleMinVersions: normalizeMinVersions(config.moduleMinVersions),
    maxToolRounds: clampInt(config.maxToolRounds, DEFAULTS.maxToolRounds, 1, 8),
    maxRunningTasksPerUser: clampInt(config.maxRunningTasksPerUser, DEFAULTS.maxRunningTasksPerUser, 1, 4),
    auditLimit: clampInt(config.auditLimit, DEFAULTS.auditLimit, 10, 10000),
    allowConnectorRegistration: config.allowConnectorRegistration !== false,
    requireAdminForConnectorRegistration: config.requireAdminForConnectorRegistration === true,
    trustedOriginsConfigured: origins.configured,
    trustedConnectorOrigins: origins.origins,
    systemPrompt: typeof config.systemPrompt === 'string' && config.systemPrompt.trim() ? config.systemPrompt : null,
    chatAdapter: config.chatAdapter
  };
}

function normalizeHttpUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeMinVersions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const moduleId of discovery.KNOWN_MODULES) {
    const value = raw[moduleId];
    if (typeof value === 'string' && value.trim() && value.length <= 32) out[moduleId] = value.trim();
  }
  return out;
}

function bodyOf(ctx) {
  if (!ctx || ctx.body === undefined || ctx.body === null) return {};
  if (typeof ctx.body !== 'object' || Array.isArray(ctx.body)) return {};
  return ctx.body;
}

function getQuery(ctx, key) {
  const query = ctx && ctx.query;
  if (!query) return undefined;
  if (typeof query.get === 'function') return query.get(key);
  const value = query[key];
  if (Array.isArray(value)) return value[0];
  return value;
}

function userIdOf(user) {
  if (typeof user === 'string' && user.trim()) return user.trim();
  if (!user || typeof user !== 'object') return null;
  const raw = user.id !== undefined && user.id !== null ? user.id : user.username;
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim();
  return value || null;
}

/**
 * 身份校验：只认 ctx.user。没有身份时，读请求 401、写请求 403（任务书统一接口要求）。
 * 不读取任何默认 owner，也不从请求参数推断用户。
 */
function auth(ctx, write) {
  const userId = userIdOf(ctx && ctx.user);
  if (userId) return { userId };
  if (write) return { error: fail(403, 'glim.write_forbidden', '未认证的写操作被拒绝') };
  return { error: fail(401, 'glim.unauthenticated', '缺少身份，拒绝访问') };
}

function codePointLimitError(raw, max, code, label) {
  if (typeof raw !== 'string') return fail(400, 'glim.invalid_input', `${label} 必须是字符串`);
  if (raw.trim().length === 0) return fail(400, 'glim.invalid_input', `${label} 不能为空`);
  if (codepointLength(raw) > max) return fail(400, code, `${label} 长度不得超过 ${max} 个字符`);
  return null;
}

// ---------------------------------------------------------------------------
// 会话 / 消息
// ---------------------------------------------------------------------------

function publicSession(session) {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount || 0
  };
}

function publicMessage(message) {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt
  };
}

function ownSessionOrError(s, userId, sessionId) {
  const session = s.store.get('sessions')[sessionId] || null;
  if (!session) return { error: fail(404, 'glim.session_not_found', '会话不存在') };
  if (session.userId !== userId) return { error: fail(403, 'glim.forbidden', '无权访问其他用户的会话') };
  return { session };
}

function messagesOfSession(s, session) {
  return s.store
    .list('messages')
    .filter((message) => message.sessionId === session.id && message.userId === session.userId)
    .sort((a, b) => a.seq - b.seq);
}

async function listSessions(ctx) {
  const guard = auth(ctx, false);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  const sessions = s.store
    .list('sessions')
    .filter((session) => session.userId === guard.userId)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map(publicSession);
  return ok(200, { sessions });
}

async function createSession(ctx) {
  const guard = auth(ctx, true);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  const body = bodyOf(ctx);
  let title = '新会话';
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim().length === 0) {
      return fail(400, 'glim.invalid_input', 'title 必须是非空字符串');
    }
    if (codepointLength(body.title) > 120) {
      return fail(400, 'glim.invalid_input', 'title 长度不得超过 120 个字符');
    }
    title = body.title.trim();
  }
  const at = nowIso();
  const session = {
    id: newId(),
    userId: guard.userId,
    title,
    createdAt: at,
    updatedAt: at,
    messageSeq: 0,
    messageCount: 0
  };
  s.store.put('sessions', session.id, session);
  return ok(201, { session: publicSession(session) });
}

async function getSession(ctx) {
  const guard = auth(ctx, false);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  const found = ownSessionOrError(s, guard.userId, (ctx.params || {}).id);
  if (found.error) return found.error;
  return ok(200, { session: publicSession(found.session) });
}

async function deleteSession(ctx) {
  const guard = auth(ctx, true);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  const sessionId = (ctx.params || {}).id;
  const found = ownSessionOrError(s, guard.userId, sessionId);
  if (found.error) return found.error;
  for (const message of messagesOfSession(s, found.session)) s.store.remove('messages', message.id);
  s.store.remove('sessions', found.session.id);
  return ok(200, { deleted: true, id: found.session.id });
}

async function listMessages(ctx) {
  const guard = auth(ctx, false);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  const found = ownSessionOrError(s, guard.userId, (ctx.params || {}).id);
  if (found.error) return found.error;

  const limitRaw = Number.parseInt(String(getQuery(ctx, 'limit') ?? '50'), 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
  const beforeRaw = Number.parseInt(String(getQuery(ctx, 'before') ?? ''), 10);
  const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : null;

  let messages = messagesOfSession(s, found.session);
  if (before !== null) messages = messages.filter((message) => message.seq < before);
  messages = messages.slice(-limit).map(publicMessage);
  return ok(200, { session: publicSession(found.session), messages });
}

// ---------------------------------------------------------------------------
// 模型适配（不使用任何模拟回复）
// ---------------------------------------------------------------------------

function resolveChatAdapter(s) {
  const raw = s.config.chatAdapter;
  if (typeof raw === 'function') return { kind: 'function', fn: raw, model: raw.model || null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : null;
  if (typeof raw.chat === 'function') return { kind: 'function', fn: raw.chat.bind(raw), model };
  if (typeof raw.complete === 'function') return { kind: 'function', fn: raw.complete.bind(raw), model };
  if (typeof raw.endpoint === 'string' && raw.endpoint.trim()) {
    return {
      kind: 'http',
      endpoint: raw.endpoint.trim(),
      model,
      apiKey: typeof raw.apiKey === 'string' && raw.apiKey ? raw.apiKey : null,
      timeoutMs: clampInt(raw.timeoutMs, 30000, 1000, 120000)
    };
  }
  return null;
}

function extractModelContent(raw) {
  if (typeof raw === 'string') return raw.trim() ? raw.trim() : null;
  if (!raw || typeof raw !== 'object') return null;
  for (const value of [raw.content, raw.text, raw.reply, raw.output_text]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  if (raw.message && typeof raw.message.content === 'string' && raw.message.content.trim()) {
    return raw.message.content.trim();
  }
  if (Array.isArray(raw.choices) && raw.choices.length > 0) {
    const first = raw.choices[0];
    if (first && first.message && typeof first.message.content === 'string' && first.message.content.trim()) {
      return first.message.content.trim();
    }
    if (first && typeof first.text === 'string' && first.text.trim()) return first.text.trim();
  }
  return null;
}

function abortError() {
  const error = new Error('调用已停止');
  error.code = 'glim.tool_aborted';
  error.status = 409;
  error.expose = true;
  return error;
}

function requestHttpModel(adapter, messages, { tools: toolDefs = null, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(adapter.endpoint);
    } catch {
      reject(new Error('模型地址不合法'));
      return;
    }
    const transport = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
    if (!transport) {
      reject(new Error('模型地址只支持 http/https'));
      return;
    }
    const payloadObject = { messages };
    if (adapter.model) payloadObject.model = adapter.model;
    if (Array.isArray(toolDefs) && toolDefs.length > 0) {
      payloadObject.tools = toolDefs;
      payloadObject.tool_choice = 'auto';
    }
    const payload = JSON.stringify(payloadObject);
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json',
      'content-length': Buffer.byteLength(payload)
    };
    if (adapter.apiKey) headers.authorization = `Bearer ${adapter.apiKey}`;

    let aborted = false;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const req = transport.request(url, { method: 'POST', headers, timeout: adapter.timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          req.destroy(new Error('模型响应过大'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', (error) => finish(reject, error));
      res.on('end', () => {
        if (aborted) return;
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          finish(reject, new Error(`模型服务返回 ${res.statusCode || '未知状态'}`));
          return;
        }
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          finish(resolve, JSON.parse(text));
        } catch {
          finish(reject, new Error('模型响应不是合法 JSON'));
        }
      });
    });
    const onAbort = () => {
      aborted = true;
      req.destroy(abortError());
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('timeout', () => req.destroy(new Error('模型服务超时')));
    req.on('error', (error) => finish(reject, aborted ? abortError() : error));
    req.end(payload);
  });
}

/** 让任意 Promise 响应中断；函数适配器无法自行取消时也能及时收敛。 */
function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

/** 返回模型原始响应，供工具循环读取 tool_calls。 */
async function callChatAdapterRaw(s, adapter, messages, meta = {}) {
  if (meta.signal && meta.signal.aborted) throw abortError();
  if (adapter.kind === 'function') {
    return withAbort(adapter.fn({
      messages,
      model: adapter.model,
      user: meta.userId ? { id: meta.userId } : null,
      sessionId: meta.sessionId || null,
      tools: Array.isArray(meta.tools) ? meta.tools : [],
      signal: meta.signal || null
    }), meta.signal);
  }
  return requestHttpModel(adapter, messages, { tools: meta.tools || null, signal: meta.signal || null });
}

async function callChatAdapter(s, adapter, messages, meta) {
  const raw = await callChatAdapterRaw(s, adapter, messages, meta);
  const content = extractModelContent(raw);
  if (!content) throw new Error('模型适配器未返回文本内容');
  return content;
}

/** 归一化 OpenAI 风格与常见的自定义 tool_calls 形状。 */
function extractToolCalls(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const sources = [];
  if (Array.isArray(raw.toolCalls)) sources.push(...raw.toolCalls);
  if (Array.isArray(raw.tool_calls)) sources.push(...raw.tool_calls);
  if (raw.message && Array.isArray(raw.message.tool_calls)) sources.push(...raw.message.tool_calls);
  if (Array.isArray(raw.choices) && raw.choices[0]) {
    const message = raw.choices[0].message;
    if (message && Array.isArray(message.tool_calls)) sources.push(...message.tool_calls);
    if (Array.isArray(raw.choices[0].tool_calls)) sources.push(...raw.choices[0].tool_calls);
  }
  const calls = [];
  for (const item of sources) {
    if (!item || typeof item !== 'object') continue;
    const fn = item.function && typeof item.function === 'object' ? item.function : item;
    const name = typeof fn.name === 'string' ? fn.name : typeof item.name === 'string' ? item.name : null;
    if (!name || !CAPABILITY_NAME.test(name)) continue;
    let args = fn.arguments !== undefined ? fn.arguments : item.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
    calls.push({
      id: typeof item.id === 'string' && item.id ? item.id : `call_${crypto.randomUUID()}`,
      name,
      arguments: args
    });
    if (calls.length >= 8) break;
  }
  return calls;
}

function buildModelMessages(history, config, memoryText = null) {
  const out = [];
  const system = [];
  if (config.systemPrompt) system.push(config.systemPrompt);
  if (memoryText) system.push(`以下是该用户明确保存的长期记忆，仅作为背景，不得据此泄露他人数据：\n${memoryText}`);
  if (system.length > 0) out.push({ role: 'system', content: system.join('\n\n') });
  for (const item of history) {
    if (!item || (item.role !== 'user' && item.role !== 'assistant')) continue;
    out.push({ role: item.role, content: item.content });
  }
  return out;
}

function memoryTextOf(s, userId) {
  const record = s.store.get('memory')[memoryKey(userId)] || null;
  if (!record || typeof record.content !== 'string' || !record.content) return null;
  return record.content;
}

/** 已授权、已实现、本机可执行的工具目录（同名只保留第一个）。 */
function toolCatalog(s, userId) {
  const catalog = [];
  const seen = new Set();
  for (const entry of grantedEntries(s, userId)) {
    const capability = entry.capability;
    if (capability.implemented !== true) continue;
    if (seen.has(capability.name)) continue;
    if (!isLocalToolReady(entry.connector, capability.name)) continue;
    seen.add(capability.name);
    catalog.push({
      entry,
      definition: {
        type: 'function',
        function: {
          name: capability.name,
          description: `${capability.description || capability.name}（${capability.access}${capability.externalEffect ? '，有外部副作用' : ''}）`,
          parameters: { type: 'object', properties: {}, additionalProperties: true }
        }
      }
    });
  }
  return catalog;
}

function toolContent(value) {
  const text = JSON.stringify(value === undefined ? null : value);
  return text.length > 20000 ? `${text.slice(0, 20000)}…` : text;
}

/**
 * 模型工具循环：最多 maxToolRounds 轮；每次调用仍走授权、实现与适配器检查。
 * 工具失败只作为 tool 消息返回给模型，不伪造业务结果；中断直接终止。
 */
async function runAgent(s, { userId, session, content, messages: providedMessages = null, ctx = null, signal = null, maxToolRounds = s.config.maxToolRounds, onTrace = null }) {
  const adapter = resolveChatAdapter(s);
  if (!adapter) {
    return { error: fail(409, MODEL_NOT_CONFIGURED, '未配置模型适配器（config.chatAdapter），拒绝生成模拟回复') };
  }
  let messages;
  if (Array.isArray(providedMessages)) {
    messages = buildModelMessages(providedMessages, s.config, memoryTextOf(s, userId));
  } else {
    const history = session ? messagesOfSession(s, session).slice(-s.config.historyLimit) : [];
    messages = buildModelMessages(history, s.config, memoryTextOf(s, userId));
    messages.push({ role: 'user', content });
  }
  const catalog = toolCatalog(s, userId);
  const definitions = catalog.map((item) => item.definition);
  const byName = new Map(catalog.map((item) => [item.entry.capability.name, item.entry]));

  for (let round = 0; round <= maxToolRounds; round += 1) {
    if (signal && signal.aborted) throw abortError();
    const useTools = round < maxToolRounds ? definitions : [];
    const raw = await callChatAdapterRaw(s, adapter, messages, {
      userId,
      sessionId: session ? session.id : null,
      tools: useTools,
      signal
    });
    const calls = useTools.length > 0 ? extractToolCalls(raw) : [];
    if (calls.length === 0) {
      const reply = extractModelContent(raw);
      if (!reply) throw new Error('模型适配器未返回文本内容');
      return { reply };
    }
    messages.push({
      role: 'assistant',
      content: extractModelContent(raw) || '',
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) }
      }))
    });
    for (const call of calls) {
      if (signal && signal.aborted) throw abortError();
      const entry = byName.get(call.name);
      let payload;
      if (!entry) {
        payload = { error: 'glim.tool_not_authorized', message: `工具 ${call.name} 未授权或不可用` };
        if (onTrace) onTrace({ at: nowIso(), type: 'tool', name: call.name, status: 'error', code: 'glim.tool_not_authorized' });
      } else {
        const startedMs = Date.now();
        const executed = await executeToolEntry(s, userId, entry, call.arguments, { ctx, source: 'agent', signal });
        if (executed.error) {
          if (executed.error.body.code === 'glim.tool_aborted') throw abortError();
          payload = { error: executed.error.body.code, message: executed.error.body.message };
          if (onTrace) {
            onTrace({
              at: nowIso(), type: 'tool', name: call.name, status: 'error',
              code: executed.error.body.code, durationMs: Date.now() - startedMs
            });
          }
        } else {
          payload = executed.result;
          if (onTrace) {
            onTrace({ at: nowIso(), type: 'tool', name: call.name, status: 'ok', durationMs: Date.now() - startedMs });
          }
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: toolContent(payload) });
    }
  }
  // 达到轮次上限后再请求一次，且不再提供工具，要求模型收敛到文本答复。
  if (signal && signal.aborted) throw abortError();
  const raw = await callChatAdapterRaw(s, adapter, messages, { userId, sessionId: session ? session.id : null, tools: [], signal });
  const reply = extractModelContent(raw);
  if (!reply) throw new Error('模型在工具轮次上限后未返回文本内容');
  return { reply };
}

function recordExchange(s, session, userId, content, reply) {
  const baseSeq = Number.isSafeInteger(session.messageSeq) ? session.messageSeq : 0;
  const at = nowIso();
  const userMessage = {
    id: newId(),
    sessionId: session.id,
    userId,
    role: 'user',
    content,
    seq: baseSeq + 1,
    createdAt: at
  };
  const assistantMessage = {
    id: newId(),
    sessionId: session.id,
    userId,
    role: 'assistant',
    content: reply,
    seq: baseSeq + 2,
    createdAt: at
  };
  s.store.put('messages', userMessage.id, userMessage);
  s.store.put('messages', assistantMessage.id, assistantMessage);
  const updated = s.store.update('sessions', session.id, {
    messageSeq: baseSeq + 2,
    messageCount: (session.messageCount || 0) + 2,
    updatedAt: at
  });
  return { userMessage, assistantMessage, session: updated || session };
}

async function generateExchange(s, session, userId, content, options = {}) {
  let reply;
  try {
    const result = await runAgent(s, {
      userId,
      session,
      content,
      ctx: options.ctx || null,
      signal: options.signal || null,
      maxToolRounds: options.maxToolRounds,
      onTrace: options.onTrace || null
    });
    if (result.error) return result;
    reply = result.reply;
  } catch (err) {
    if (err && err.code === 'glim.tool_aborted') {
      return { error: fail(409, 'glim.tool_aborted', '任务已停止') };
    }
    s.logger.warn(`[glim] 模型调用失败: ${err && err.message ? err.message : 'unknown'}`);
    return { error: fail(502, MODEL_FAILED, '模型调用失败，未生成回复') };
  }
  const recorded = recordExchange(s, session, userId, content, reply);
  return {
    userMessage: publicMessage(recorded.userMessage),
    assistantMessage: publicMessage(recorded.assistantMessage),
    session: publicSession(recorded.session)
  };
}

async function postMessage(ctx) {
  const guard = auth(ctx, true);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  const found = ownSessionOrError(s, guard.userId, (ctx.params || {}).id);
  if (found.error) return found.error;

  const body = bodyOf(ctx);
  const invalid = codePointLimitError(body.content, s.config.messageMaxChars, 'glim.message_too_long', 'content');
  if (invalid) return invalid;

  const result = await generateExchange(s, found.session, guard.userId, body.content, { ctx });
  if (result.error) return result.error;
  return ok(201, result);
}

function sanitizeClientMessages(raw, maxChars) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: fail(400, 'glim.invalid_input', 'messages 必须是非空数组') };
  }
  if (raw.length > 50) return { error: fail(400, 'glim.invalid_input', 'messages 最多 50 条') };
  const messages = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: fail(400, 'glim.invalid_input', `messages[${index}] 必须是对象`) };
    }
    if (!CLIENT_ROLES.has(item.role)) {
      return { error: fail(400, 'glim.invalid_input', `messages[${index}].role 只能是 user 或 assistant`) };
    }
    const invalid = codePointLimitError(item.content, maxChars, 'glim.message_too_long', `messages[${index}].content`);
    if (invalid) return { error: invalid };
    messages.push({ role: item.role, content: item.content });
  }
  return { messages };
}

async function chat(ctx) {
  const guard = auth(ctx, true);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  const body = bodyOf(ctx);
  const sessionId = body.sessionId;

  if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId.trim())) {
    return fail(400, 'glim.invalid_input', 'sessionId 必须是非空字符串');
  }

  if (sessionId) {
    if (body.messages !== undefined) {
      return fail(400, 'glim.invalid_input', '提供 sessionId 时只接受 content，不接受 messages');
    }
    const found = ownSessionOrError(s, guard.userId, sessionId);
    if (found.error) return found.error;
    const invalid = codePointLimitError(body.content, s.config.messageMaxChars, 'glim.message_too_long', 'content');
    if (invalid) return invalid;
    const result = await generateExchange(s, found.session, guard.userId, body.content, { ctx });
    if (result.error) return result.error;
    return ok(201, result);
  }

  let messages;
  if (body.messages !== undefined) {
    const sanitized = sanitizeClientMessages(body.messages, s.config.messageMaxChars);
    if (sanitized.error) return sanitized.error;
    messages = sanitized.messages;
  } else {
    const invalid = codePointLimitError(body.content, s.config.messageMaxChars, 'glim.message_too_long', 'content');
    if (invalid) return invalid;
    messages = [{ role: 'user', content: body.content }];
  }
  if (body.content !== undefined && body.messages !== undefined) {
    const invalid = codePointLimitError(body.content, s.config.messageMaxChars, 'glim.message_too_long', 'content');
    if (invalid) return invalid;
    messages.push({ role: 'user', content: body.content });
  }

  try {
    const result = await runAgent(s, {
      userId: guard.userId,
      session: null,
      messages,
      ctx,
      signal: ctx ? ctx.signal : null
    });
    if (result.error) return result.error;
    return ok(200, { reply: result.reply });
  } catch (err) {
    if (err && err.code === 'glim.tool_aborted') return fail(409, 'glim.tool_aborted', '调用已停止');
    s.logger.warn(`[glim] 模型调用失败: ${err && err.message ? err.message : 'unknown'}`);
    return fail(502, MODEL_FAILED, '模型调用失败，未生成回复');
  }
}

// ---------------------------------------------------------------------------
// 长期记忆
// ---------------------------------------------------------------------------

function memoryKey(userId) {
  // 加前缀避免把用户 ID 直接当作对象键时触发 __proto__ 等特殊键。
  return `user:${userId}`;
}

async function getMemory(ctx) {
  const guard = auth(ctx, false);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  const record = s.store.get('memory')[memoryKey(guard.userId)] || null;
  return ok(200, {
    content: record ? record.content : '',
    updatedAt: record ? record.updatedAt : null,
    maxChars: s.config.memoryMaxChars
  });
}

async function putMemory(ctx) {
  const guard = auth(ctx, true);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  const body = bodyOf(ctx);
  if (typeof body.content !== 'string') {
    return fail(400, 'glim.invalid_input', 'content 必须是字符串');
  }
  if (codepointLength(body.content) > s.config.memoryMaxChars) {
    return fail(400, 'glim.memory_too_long', `长期记忆长度不得超过 ${s.config.memoryMaxChars} 个字符`);
  }
  const record = {
    userId: guard.userId,
    content: body.content,
    updatedAt: nowIso()
  };
  const key = memoryKey(guard.userId);
  if (s.store.has('memory', key)) s.store.update('memory', key, record);
  else s.store.put('memory', key, record);
  return ok(200, {
    content: record.content,
    updatedAt: record.updatedAt,
    maxChars: s.config.memoryMaxChars
  });
}

// ---------------------------------------------------------------------------
// 连接登记与授权
// ---------------------------------------------------------------------------

function normalizeEndpoint(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { error: 'endpoint 必须是非空字符串' };
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: 'endpoint 必须是合法的绝对 URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: 'endpoint 只支持 http/https' };
  }
  if (url.username || url.password) {
    return { error: 'endpoint 不得包含用户名或密码' };
  }
  url.hash = '';
  let endpoint = url.toString();
  if (url.pathname === '/' && !url.search) endpoint = endpoint.replace(/\/$/, '');
  return { endpoint, origin: url.origin };
}

function normalizeCapabilities(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'capabilities 必须是非空数组' };
  }
  if (raw.length > 50) return { error: 'capabilities 最多 50 项' };
  const seen = new Set();
  const capabilities = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: `capabilities[${index}] 必须是对象` };
    }
    if (typeof item.name !== 'string' || !CAPABILITY_NAME.test(item.name)) {
      return { error: `capabilities[${index}].name 必须是 3-48 位小写字母/数字/下划线` };
    }
    if (!ACCESS_VALUES.has(item.access)) {
      return { error: `capabilities[${index}].access 只能是 read 或 write` };
    }
    if (item.implemented !== undefined && typeof item.implemented !== 'boolean') {
      return { error: `capabilities[${index}].implemented 必须是布尔值` };
    }
    if (item.externalEffect !== undefined && typeof item.externalEffect !== 'boolean') {
      return { error: `capabilities[${index}].externalEffect 必须是布尔值` };
    }
    if (item.version !== undefined && (typeof item.version !== 'string' || item.version.length > 32)) {
      return { error: `capabilities[${index}].version 必须是不超过 32 字符的字符串` };
    }
    if (item.description !== undefined && (typeof item.description !== 'string' || item.description.length > 200)) {
      return { error: `capabilities[${index}].description 必须是不超过 200 字符的字符串` };
    }
    if (seen.has(item.name)) return { error: `capability 名称重复: ${item.name}` };
    seen.add(item.name);
    capabilities.push({
      name: item.name,
      access: item.access,
      implemented: item.implemented === true,
      externalEffect: item.externalEffect === true,
      version: item.version || null,
      description: item.description || null
    });
  }
  return { capabilities };
}

function publicCapability(capability) {
  return {
    name: capability.name,
    access: capability.access,
    implemented: capability.implemented === true,
    externalEffect: capability.externalEffect === true,
    version: capability.version || null,
    description: capability.description || null
  };
}

function publicConnector(connector, grant) {
  return {
    id: connector.id,
    name: connector.name,
    moduleId: connector.moduleId || null,
    endpoint: connector.endpoint,
    version: connector.version || null,
    capabilities: connector.capabilities.map(publicCapability),
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
    granted: Boolean(grant),
    grant: grant ? { capabilities: grant.capabilities.slice(), updatedAt: grant.updatedAt } : null
  };
}

function connectorOwnedOrError(s, userId, connectorId) {
  const connector = s.store.get('connectors')[connectorId] || null;
  if (!connector) return { error: fail(404, 'glim.connector_not_found', 'connector 不存在') };
  if (connector.userId !== userId) {
    return { error: fail(403, 'glim.forbidden', '无权访问其他用户的 connector') };
  }
  return { connector };
}

function grantKey(connectorId, userId) {
  return `${connectorId}:${userId}`;
}

function getGrant(s, connectorId, userId) {
  return s.store.get('grants')[grantKey(connectorId, userId)] || null;
}

function grantedEntries(s, userId) {
  const entries = [];
  for (const grant of s.store.list('grants')) {
    if (grant.userId !== userId) continue;
    if (!Array.isArray(grant.capabilities)) continue;
    const connector = s.store.get('connectors')[grant.connectorId];
    if (!connector || connector.userId !== userId || !Array.isArray(connector.capabilities)) continue;
    for (const capability of connector.capabilities) {
      if (grant.capabilities.includes(capability.name)) entries.push({ connector, capability, grant });
    }
  }
  return entries;
}

function injectedTool(name) {
  return Object.prototype.hasOwnProperty.call(tools, name) && typeof tools[name] === 'function' ? tools[name] : null;
}

/**
 * 工具是否有本机实现。
 * 只有两种情况算“可用”：部署注入的同名函数，或 connector 显式声明了受支持的 moduleId。
 * 仅凭工具名相同不会把任意连接器接到本机适配器。
 */
function handlerForConnector(connector, name) {
  const injected = injectedTool(name);
  if (injected) return injected;
  if (connector && typeof connector.moduleId === 'string') return connectors.handlerFor(connector.moduleId, name);
  return null;
}

function isLocalToolReady(connector, name) {
  return Boolean(handlerForConnector(connector, name));
}

function recordAudit(s, record) {
  const entry = {
    id: `audit_${crypto.randomUUID()}`,
    userId: record.userId,
    source: record.source || 'invoke',
    tool: record.tool,
    access: record.access || null,
    connectorId: record.connectorId || null,
    moduleId: record.moduleId || null,
    externalEffect: record.externalEffect === true,
    ok: record.ok === true,
    code: record.code || null,
    durationMs: Number.isSafeInteger(record.durationMs) ? record.durationMs : null,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt
  };
  s.store.put('audit', entry.id, entry);
  const own = s.store.list('audit').filter((item) => item.userId === entry.userId);
  if (own.length > s.config.auditLimit) {
    own
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
      .slice(0, own.length - s.config.auditLimit)
      .forEach((item) => s.store.remove('audit', item.id));
  }
  return entry;
}

/**
 * 执行一次已授权的工具。结果不包含密钥；失败只返回 code/message。
 * 审计记录参数“键名”以外的内容一律不落库。
 */
async function executeToolEntry(s, userId, entry, input, { ctx = null, source = 'invoke', signal = null } = {}) {
  const name = entry.capability.name;
  const handler = handlerForConnector(entry.connector, name);
  const startedAt = nowIso();
  const startedMs = Date.now();
  if (!handler) {
    recordAudit(s, {
      userId, source, tool: name, access: entry.capability.access,
      connectorId: entry.connector.id, moduleId: entry.connector.moduleId || null,
      externalEffect: entry.capability.externalEffect === true,
      ok: false, code: 'glim.tool_incompatible', startedAt, finishedAt: nowIso(),
      durationMs: Date.now() - startedMs
    });
    return { error: fail(409, 'glim.tool_incompatible', `工具 ${name} 缺少本机适配器，拒绝返回伪造结果`) };
  }
  try {
    const result = await handler(input, {
      req: ctx ? ctx.req : null,
      user: ctx ? ctx.user : null,
      userId,
      connector: {
        id: entry.connector.id,
        name: entry.connector.name,
        moduleId: entry.connector.moduleId || null,
        endpoint: entry.connector.endpoint
      },
      capability: publicCapability(entry.capability),
      signal
    });
    recordAudit(s, {
      userId, source, tool: name, access: entry.capability.access,
      connectorId: entry.connector.id, moduleId: entry.connector.moduleId || null,
      externalEffect: entry.capability.externalEffect === true,
      ok: true, startedAt, finishedAt: nowIso(), durationMs: Date.now() - startedMs
    });
    return { result: result === undefined ? null : result, entry };
  } catch (err) {
    const aborted = Boolean((signal && signal.aborted) || (err && err.code === 'glim.tool_aborted'));
    const exposed = err && err.expose === true && Number.isInteger(err.status) && typeof err.code === 'string';
    const code = aborted ? 'glim.tool_aborted' : exposed ? err.code : 'glim.tool_failed';
    const status = aborted ? 409 : exposed ? err.status : 502;
    const message = aborted ? '工具调用已停止' : exposed ? err.message : `工具 ${name} 执行失败`;
    recordAudit(s, {
      userId, source, tool: name, access: entry.capability.access,
      connectorId: entry.connector.id, moduleId: entry.connector.moduleId || null,
      externalEffect: entry.capability.externalEffect === true,
      ok: false, code, startedAt, finishedAt: nowIso(), durationMs: Date.now() - startedMs
    });
    if (!exposed && !aborted) {
      s.logger.warn(`[glim] 工具 ${name} 执行失败: ${err && err.message ? err.message : 'unknown'}`);
    }
    return { error: fail(status, code, message) };
  }
}

async function listConnectors(ctx) {
  const guard = auth(ctx, false);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  const connectors = s.store
    .list('connectors')
    .filter((connector) => connector.userId === guard.userId)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map((connector) => publicConnector(connector, getGrant(s, connector.id, guard.userId)));
  return ok(200, { connectors });
}

async function createConnector(ctx) {
  const guard = auth(ctx, true);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  if (!s.config.allowConnectorRegistration) {
    return fail(403, 'glim.connector_registration_disabled', '部署配置已关闭 connector 登记');
  }
  if (s.config.requireAdminForConnectorRegistration && (!ctx.user || ctx.user.role !== 'admin')) {
    return fail(403, 'glim.forbidden', '登记 connector 需要管理员身份');
  }

  const body = bodyOf(ctx);
  const endpointResult = normalizeEndpoint(body.endpoint);
  if (endpointResult.error) return fail(400, 'glim.invalid_input', endpointResult.error);
  if (
    s.config.trustedOriginsConfigured &&
    !s.config.trustedConnectorOrigins.includes(endpointResult.origin)
  ) {
    return fail(403, 'glim.connector_origin_denied', 'connector 来源不在受信白名单内');
  }

  let moduleId = null;
  if (body.moduleId !== undefined) {
    if (typeof body.moduleId !== 'string' || !connectors.supports(body.moduleId)) {
      return fail(400, 'glim.invalid_input', 'moduleId 不是受支持的模块');
    }
    moduleId = body.moduleId;
  }

  let capabilityResult;
  if (moduleId) {
    // 模块连接的能力集合由本机适配器声明，请求体不能抬高 access 或伪造 implemented。
    if (body.capabilities !== undefined) {
      return fail(400, 'glim.invalid_input', '声明 moduleId 时能力列表由模块提供，不接受请求体覆盖');
    }
    capabilityResult = { capabilities: connectors.capabilitiesFor(moduleId) };
  } else {
    capabilityResult = normalizeCapabilities(body.capabilities);
    if (capabilityResult.error) return fail(400, 'glim.invalid_input', capabilityResult.error);
  }

  const existing = s.store.list('connectors').filter((connector) => connector.userId === guard.userId);
  if (existing.length >= s.config.maxConnectorsPerUser) {
    return fail(409, 'glim.connector_limit', `每个用户最多登记 ${s.config.maxConnectorsPerUser} 个 connector`);
  }

  let name = endpointResult.origin;
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return fail(400, 'glim.invalid_input', 'name 必须是非空字符串');
    }
    if (codepointLength(body.name) > 80) {
      return fail(400, 'glim.invalid_input', 'name 长度不得超过 80 个字符');
    }
    name = body.name.trim();
  }
  let version = null;
  if (body.version !== undefined) {
    if (typeof body.version !== 'string' || body.version.length > 32) {
      return fail(400, 'glim.invalid_input', 'version 必须是不超过 32 字符的字符串');
    }
    version = body.version;
  }

  const at = nowIso();
  const connector = {
    id: newId(),
    userId: guard.userId,
    name,
    moduleId,
    endpoint: endpointResult.endpoint,
    version,
    capabilities: capabilityResult.capabilities,
    createdAt: at,
    updatedAt: at
  };
  s.store.put('connectors', connector.id, connector);
  return ok(201, { connector: publicConnector(connector, null) });
}

async function getConnector(ctx) {
  const guard = auth(ctx, false);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  const found = connectorOwnedOrError(s, guard.userId, (ctx.params || {}).id);
  if (found.error) return found.error;
  const grant = getGrant(s, found.connector.id, guard.userId);
  return ok(200, { connector: publicConnector(found.connector, grant) });
}

async function deleteConnector(ctx) {
  const guard = auth(ctx, true);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  const found = connectorOwnedOrError(s, guard.userId, (ctx.params || {}).id);
  if (found.error) return found.error;
  for (const grant of s.store.list('grants')) {
    if (grant.connectorId === found.connector.id) s.store.remove('grants', grantKey(grant.connectorId, grant.userId));
  }
  s.store.remove('connectors', found.connector.id);
  return ok(200, { deleted: true, id: found.connector.id });
}

function readRequestedCapabilities(raw, connector) {
  if (raw === undefined || raw === null) {
    return { names: connector.capabilities.map((capability) => capability.name) };
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'capabilities 必须是非空数组' };
  }
  const declared = new Set(connector.capabilities.map((capability) => capability.name));
  const names = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !declared.has(item)) {
      return { error: `capability 不属于该 connector: ${String(item)}` };
    }
    if (!names.includes(item)) names.push(item);
  }
  return { names };
}

async function grantConnector(ctx) {
  const guard = auth(ctx, true);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  const found = connectorOwnedOrError(s, guard.userId, (ctx.params || {}).id);
  if (found.error) return found.error;

  const body = bodyOf(ctx);
  const requested = readRequestedCapabilities(body.capabilities, found.connector);
  if (requested.error) return fail(400, 'glim.invalid_input', requested.error);

  const existing = getGrant(s, found.connector.id, guard.userId);
  const at = nowIso();
  const names = [...new Set([...(existing ? existing.capabilities : []), ...requested.names])];
  const grant = {
    connectorId: found.connector.id,
    userId: guard.userId,
    capabilities: names,
    createdAt: existing ? existing.createdAt : at,
    updatedAt: at
  };
  if (existing) s.store.update('grants', grantKey(grant.connectorId, guard.userId), grant);
  else s.store.put('grants', grantKey(grant.connectorId, guard.userId), grant);
  return ok(200, {
    grant: { connectorId: grant.connectorId, capabilities: grant.capabilities.slice(), updatedAt: grant.updatedAt },
    connector: publicConnector(found.connector, grant)
  });
}

async function revokeConnector(ctx) {
  const guard = auth(ctx, true);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  const found = connectorOwnedOrError(s, guard.userId, (ctx.params || {}).id);
  if (found.error) return found.error;

  const body = bodyOf(ctx);
  let requested = null;
  if (body.capabilities !== undefined) {
    const parsed = readRequestedCapabilities(body.capabilities, found.connector);
    if (parsed.error) return fail(400, 'glim.invalid_input', parsed.error);
    requested = parsed.names;
  }

  const existing = getGrant(s, found.connector.id, guard.userId);
  if (!existing) {
    return ok(200, { connectorId: found.connector.id, granted: false, capabilities: [] });
  }

  const remaining = requested
    ? existing.capabilities.filter((name) => !requested.includes(name))
    : [];
  if (remaining.length === 0) {
    s.store.remove('grants', grantKey(found.connector.id, guard.userId));
  } else {
    s.store.update('grants', grantKey(found.connector.id, guard.userId), {
      capabilities: remaining,
      updatedAt: nowIso()
    });
  }
  return ok(200, {
    connectorId: found.connector.id,
    granted: remaining.length > 0,
    capabilities: remaining
  });
}

// ---------------------------------------------------------------------------
// 工具：列表与调用
// ---------------------------------------------------------------------------

async function listTools(ctx) {
  const guard = auth(ctx, false);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();

  const seen = new Set();
  const available = [];
  for (const entry of grantedEntries(s, guard.userId)) {
    if (entry.capability.implemented !== true) continue;
    const key = `${entry.connector.id}:${entry.capability.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    available.push({
      name: entry.capability.name,
      access: entry.capability.access,
      implemented: true,
      externalEffect: entry.capability.externalEffect === true,
      version: entry.capability.version || null,
      description: entry.capability.description || null,
      connectorId: entry.connector.id,
      connectorName: entry.connector.name,
      moduleId: entry.connector.moduleId || null,
      endpoint: entry.connector.endpoint,
      // 本机是否已有真实实现；false 时调用会得到 409，而不是伪造结果。
      adapterReady: isLocalToolReady(entry.connector, entry.capability.name)
    });
  }
  available.sort((a, b) => a.name.localeCompare(b.name) || a.connectorId.localeCompare(b.connectorId));
  return ok(200, { tools: available });
}

async function invokeTool(ctx) {
  const guard = auth(ctx, true);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();

  const name = (ctx.params || {}).name;
  if (typeof name !== 'string' || !CAPABILITY_NAME.test(name)) {
    return fail(400, 'glim.invalid_input', '工具名不合法');
  }

  let candidates = grantedEntries(s, guard.userId).filter((entry) => entry.capability.name === name);
  if (candidates.length === 0) {
    return fail(403, 'glim.tool_not_authorized', `未授权调用工具 ${name}`);
  }

  const body = bodyOf(ctx);
  if (body.access !== undefined) {
    if (body.access !== 'read' && body.access !== 'write') {
      return fail(400, 'glim.invalid_input', 'access 只能是 read 或 write');
    }
    candidates = candidates.filter((entry) => entry.capability.access === body.access);
    if (candidates.length === 0) {
      return fail(409, 'glim.tool_incompatible', `工具 ${name} 的授权访问类型不匹配`);
    }
  }

  const implemented = candidates.filter((entry) => entry.capability.implemented === true);
  if (implemented.length === 0) {
    return fail(409, 'glim.tool_incompatible', `工具 ${name} 尚未实现（implemented=false）`);
  }
  const ready = implemented.filter((entry) => isLocalToolReady(entry.connector, name));
  if (ready.length === 0) {
    return fail(409, 'glim.tool_incompatible', `工具 ${name} 缺少本机适配器，拒绝返回伪造结果`);
  }

  const chosen = ready[0];
  const input = body.input !== undefined ? body.input : body.arguments !== undefined ? body.arguments : {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail(400, 'glim.invalid_input', 'input 必须是对象');
  }
  const executed = await executeToolEntry(s, guard.userId, chosen, input, { ctx, source: 'invoke' });
  if (executed.error) return executed.error;
  return ok(200, {
    tool: name,
    connectorId: chosen.connector.id,
    result: executed.result
  });
}

// ---------------------------------------------------------------------------
// 工作区（每用户受限文件区）
// ---------------------------------------------------------------------------

function workspaceOrError(s) {
  if (!s.workspace) return { error: fail(409, 'glim.workspace_not_configured', '未配置 workspaceRoot，工作区不可用') };
  return { workspace: s.workspace };
}

function mapWorkspaceError(err, s) {
  if (err && err.expose === true && Number.isInteger(err.status) && typeof err.code === 'string') {
    return fail(err.status, err.code, err.message);
  }
  s.logger.warn(`[glim] 工作区操作失败: ${err && err.message ? err.message : 'unknown'}`);
  return fail(500, 'glim.workspace_failed', '工作区操作失败');
}

async function listWorkspace(ctx) {
  const guard = auth(ctx, false);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  const found = workspaceOrError(s);
  if (found.error) return found.error;
  try {
    const usage = found.workspace.list(guard.userId);
    return ok(200, {
      files: usage.files,
      totalBytes: usage.totalBytes,
      maxFileBytes: s.config.maxWorkspaceFileBytes,
      maxFiles: s.config.maxWorkspaceFiles,
      maxTotalBytes: s.config.maxWorkspaceTotalBytes
    });
  } catch (err) {
    return mapWorkspaceError(err, s);
  }
}

async function getWorkspaceFile(ctx) {
  const guard = auth(ctx, false);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  const found = workspaceOrError(s);
  if (found.error) return found.error;
  try {
    const file = found.workspace.read(guard.userId, getQuery(ctx, 'path'));
    const text = file.content.toString('utf8');
    const isUtf8 = Buffer.from(text, 'utf8').equals(file.content) && !file.content.includes(0);
    return ok(200, {
      path: file.path,
      size: file.size,
      updatedAt: file.updatedAt,
      encoding: isUtf8 ? 'utf8' : 'base64',
      content: isUtf8 ? text : file.content.toString('base64')
    });
  } catch (err) {
    return mapWorkspaceError(err, s);
  }
}

async function putWorkspaceFile(ctx) {
  const guard = auth(ctx, true);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  const found = workspaceOrError(s);
  if (found.error) return found.error;
  const body = bodyOf(ctx);
  if (typeof body.path !== 'string' || !body.path.trim()) {
    return fail(400, 'glim.invalid_input', 'path 必须是非空字符串');
  }
  const encoding = body.encoding === undefined ? 'utf8' : body.encoding;
  if (encoding !== 'utf8' && encoding !== 'base64') {
    return fail(400, 'glim.invalid_input', 'encoding 只能是 utf8 或 base64');
  }
  if (typeof body.content !== 'string') {
    return fail(400, 'glim.invalid_input', 'content 必须是字符串');
  }
  let buffer;
  if (encoding === 'base64') {
    if (!/^[A-Za-z0-9+/=\s]*$/.test(body.content)) {
      return fail(400, 'glim.invalid_input', '内容不是合法 Base64');
    }
    buffer = Buffer.from(body.content, 'base64');
  } else {
    buffer = Buffer.from(body.content, 'utf8');
  }
  try {
    const written = found.workspace.write(guard.userId, body.path, buffer);
    return ok(written.created ? 201 : 200, { file: written });
  } catch (err) {
    return mapWorkspaceError(err, s);
  }
}

async function deleteWorkspaceFile(ctx) {
  const guard = auth(ctx, true);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  const found = workspaceOrError(s);
  if (found.error) return found.error;
  const body = bodyOf(ctx);
  if (typeof body.path !== 'string' || !body.path.trim()) {
    return fail(400, 'glim.invalid_input', 'path 必须是非空字符串');
  }
  try {
    return ok(200, found.workspace.remove(guard.userId, body.path));
  } catch (err) {
    return mapWorkspaceError(err, s);
  }
}

// ---------------------------------------------------------------------------
// 模块发现：只读部署提供的目录，不授权数据
// ---------------------------------------------------------------------------

async function getDiscovery(ctx) {
  const guard = auth(ctx, false);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();

  const owned = s.store.list('connectors').filter((connector) => connector.userId === guard.userId);
  const registeredByModule = new Set(owned.map((connector) => connector.moduleId).filter(Boolean));
  const grantedByModule = new Set();
  for (const grant of s.store.list('grants')) {
    if (grant.userId !== guard.userId) continue;
    const connector = s.store.get('connectors')[grant.connectorId];
    if (!connector || connector.userId !== guard.userId || !connector.moduleId) continue;
    if (Array.isArray(grant.capabilities) && grant.capabilities.length > 0) grantedByModule.add(connector.moduleId);
  }
  const connectorByModule = new Map(owned.filter((connector) => connector.moduleId).map((connector) => [connector.moduleId, connector]));
  const baseOptions = { minimums: s.config.moduleMinVersions, grantedByModule, registeredByModule };

  if (!s.config.moduleDirectoryUrl) {
    return ok(200, {
      configured: false,
      source: null,
      modules: discovery.describeModules({ modules: [] }, baseOptions).map((item) => ({
        ...item,
        connectorId: connectorByModule.has(item.moduleId) ? connectorByModule.get(item.moduleId).id : null,
        reason: '未配置 moduleDirectoryUrl，无法读取模块目录'
      }))
    });
  }

  let directory;
  try {
    directory = await discovery.fetchDirectory(s.config.moduleDirectoryUrl);
  } catch (err) {
    if (err && err.expose === true && Number.isInteger(err.status)) {
      return fail(err.status, err.code || 'glim.discovery_failed', err.message);
    }
    return fail(502, 'glim.discovery_failed', '模块目录不可用');
  }
  const modules = discovery.describeModules(directory, baseOptions).map((item) => {
    const connector = connectorByModule.get(item.moduleId) || null;
    return { ...item, connectorId: connector ? connector.id : null };
  });
  return ok(200, { configured: true, source: new URL(s.config.moduleDirectoryUrl).origin, modules });
}

async function createModuleConnector(ctx) {
  const guard = auth(ctx, true);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  if (!s.config.allowConnectorRegistration) {
    return fail(403, 'glim.connector_registration_disabled', '部署配置已关闭 connector 登记');
  }
  if (s.config.requireAdminForConnectorRegistration && (!ctx.user || ctx.user.role !== 'admin')) {
    return fail(403, 'glim.forbidden', '登记 connector 需要管理员身份');
  }
  const body = bodyOf(ctx);
  const moduleId = body.moduleId;
  if (typeof moduleId !== 'string' || !connectors.supports(moduleId)) {
    return fail(400, 'glim.invalid_input', 'moduleId 不是受支持的模块');
  }
  if (!s.config.moduleDirectoryUrl) {
    return fail(409, 'glim.discovery_not_configured', '未配置 moduleDirectoryUrl，无法确定模块地址');
  }
  const existing = s.store.list('connectors').find(
    (connector) => connector.userId === guard.userId && connector.moduleId === moduleId
  );
  if (existing) {
    const grant = getGrant(s, existing.id, guard.userId);
    return ok(200, { connector: publicConnector(existing, grant), existing: true });
  }
  if (s.store.list('connectors').filter((connector) => connector.userId === guard.userId).length >= s.config.maxConnectorsPerUser) {
    return fail(409, 'glim.connector_limit', `每个用户最多登记 ${s.config.maxConnectorsPerUser} 个 connector`);
  }

  const endpoint = new URL(MODULE_PREFIXES[moduleId], s.config.moduleDirectoryUrl).toString();
  if (s.config.trustedOriginsConfigured && !s.config.trustedConnectorOrigins.includes(new URL(endpoint).origin)) {
    return fail(403, 'glim.connector_origin_denied', 'connector 来源不在受信白名单内');
  }
  const at = nowIso();
  const connector = {
    id: newId(),
    userId: guard.userId,
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : discovery.MODULE_LABELS[moduleId],
    moduleId,
    endpoint,
    version: typeof body.version === 'string' && body.version.length <= 32 ? body.version : null,
    capabilities: connectors.capabilitiesFor(moduleId),
    createdAt: at,
    updatedAt: at
  };
  s.store.put('connectors', connector.id, connector);

  let grant = null;
  if (body.grant === true) {
    grant = {
      connectorId: connector.id,
      userId: guard.userId,
      capabilities: connector.capabilities.map((capability) => capability.name),
      createdAt: at,
      updatedAt: at
    };
    s.store.put('grants', grantKey(connector.id, guard.userId), grant);
  }
  return ok(201, { connector: publicConnector(connector, grant), existing: false });
}

// ---------------------------------------------------------------------------
// 任务：排队、停止、恢复
// ---------------------------------------------------------------------------

function createSessionRecord(s, userId, title) {
  const at = nowIso();
  const session = {
    id: newId(),
    userId,
    title: title || '新会话',
    createdAt: at,
    updatedAt: at,
    messageSeq: 0,
    messageCount: 0
  };
  s.store.put('sessions', session.id, session);
  return session;
}

function taskErrorResult(err, s) {
  if (err && err.expose === true && Number.isInteger(err.status) && typeof err.code === 'string') {
    return fail(err.status, err.code, err.message);
  }
  s.logger.warn(`[glim] 任务操作失败: ${err && err.message ? err.message : 'unknown'}`);
  return fail(500, 'glim.task_failed', '任务操作失败');
}

async function runTask(task, { signal, maxToolRounds, onTrace }) {
  const s = state;
  if (!s) throw Object.assign(new Error('Glim 模块尚未启动'), { code: 'glim.not_started', status: 503, expose: true });
  const context = s.taskContexts.get(task.id) || {};
  let session;
  if (task.sessionId) {
    session = s.store.get('sessions')[task.sessionId] || null;
    if (!session || session.userId !== task.userId) {
      throw Object.assign(new Error('会话不存在'), { code: 'glim.session_not_found', status: 404, expose: true });
    }
  } else {
    session = createSessionRecord(s, task.userId, task.prompt.slice(0, 60));
  }
  try {
    const result = await generateExchange(s, session, task.userId, task.prompt, {
      ctx: { req: context.req || null, user: context.user || null },
      signal,
      maxToolRounds,
      onTrace
    });
    if (result.error) {
      const error = new Error(result.error.body.message);
      error.code = result.error.body.code;
      error.status = result.error.status;
      error.expose = true;
      throw error;
    }
    return {
      reply: result.assistantMessage.content,
      messageId: result.assistantMessage.id,
      sessionId: result.session.id
    };
  } finally {
    s.taskContexts.delete(task.id);
  }
}

async function createTask(ctx) {
  const guard = auth(ctx, true);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  if (!resolveChatAdapter(s)) {
    return fail(409, MODEL_NOT_CONFIGURED, '未配置模型适配器（config.chatAdapter），无法创建任务');
  }
  const body = bodyOf(ctx);
  const invalid = codePointLimitError(body.prompt, s.config.messageMaxChars, 'glim.message_too_long', 'prompt');
  if (invalid) return invalid;
  let sessionId = null;
  if (body.sessionId !== undefined && body.sessionId !== null) {
    if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
      return fail(400, 'glim.invalid_input', 'sessionId 必须是非空字符串');
    }
    const found = ownSessionOrError(s, guard.userId, body.sessionId);
    if (found.error) return found.error;
    sessionId = found.session.id;
  }
  let operationId = null;
  if (body.operationId !== undefined) {
    if (typeof body.operationId !== 'string' || !body.operationId.trim() || body.operationId.length > 128) {
      return fail(400, 'glim.invalid_input', 'operationId 必须是不超过 128 字符的非空字符串');
    }
    operationId = body.operationId.trim();
  }
  try {
    const task = s.tasks.create({ userId: guard.userId, sessionId, prompt: body.prompt, operationId });
    s.taskContexts.set(task.id, { req: ctx.req || null, user: ctx.user || null });
    return ok(202, { task });
  } catch (err) {
    return taskErrorResult(err, s);
  }
}

async function listTasks(ctx) {
  const guard = auth(ctx, false);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  const limitRaw = Number.parseInt(String(getQuery(ctx, 'limit') ?? '50'), 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
  const sessionId = getQuery(ctx, 'sessionId') || null;
  return ok(200, { tasks: s.tasks.list(guard.userId, { sessionId, limit }) });
}

async function getTask(ctx) {
  const guard = auth(ctx, false);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  try {
    return ok(200, { task: s.tasks.get(guard.userId, (ctx.params || {}).id) });
  } catch (err) {
    return taskErrorResult(err, s);
  }
}

async function stopTask(ctx) {
  const guard = auth(ctx, true);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  try {
    return ok(200, { task: s.tasks.stop(guard.userId, (ctx.params || {}).id) });
  } catch (err) {
    return taskErrorResult(err, s);
  }
}

async function resumeTask(ctx) {
  const guard = auth(ctx, true);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  if (!resolveChatAdapter(s)) {
    return fail(409, MODEL_NOT_CONFIGURED, '未配置模型适配器（config.chatAdapter），无法恢复任务');
  }
  try {
    const taskId = (ctx.params || {}).id;
    s.taskContexts.set(taskId, { req: ctx.req || null, user: ctx.user || null });
    return ok(200, { task: s.tasks.resume(guard.userId, taskId) });
  } catch (err) {
    return taskErrorResult(err, s);
  }
}

async function getHealth(ctx) {
  const guard = auth(ctx, false);
  if (guard.error) return guard.error;
  return ok(200, await health());
}

async function listAudit(ctx) {  const guard = auth(ctx, false);
  if (guard.error) return guard.error;
  const s = state;
  if (!s) return notStarted();
  const limitRaw = Number.parseInt(String(getQuery(ctx, 'limit') ?? '50'), 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 50;
  const records = s.store
    .list('audit')
    .filter((record) => record.userId === guard.userId)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, limit);
  return ok(200, { audit: records });
}

// ---------------------------------------------------------------------------
// 生命周期与路由表
// ---------------------------------------------------------------------------

async function start(ctx = {}) {
  const config = normalizeConfig(ctx.config);
  const logger = normalizeLogger(ctx.logger);
  const store = new JsonStore({ filePath: config.dataFile });
  const workspace = config.workspaceRoot
    ? createWorkspace({
      root: config.workspaceRoot,
      maxFileBytes: config.maxWorkspaceFileBytes,
      maxFiles: config.maxWorkspaceFiles,
      maxTotalBytes: config.maxWorkspaceTotalBytes,
      logger
    })
    : null;
  state = { config, logger, store, workspace, tasks: null, taskContexts: new Map(), startedAt: nowIso() };
  state.tasks = new TaskRunner({
    store,
    logger,
    run: runTask,
    maxRunningPerUser: config.maxRunningTasksPerUser,
    maxToolRounds: config.maxToolRounds
  });
  logger.info(`[glim] started (storage=${config.dataFile ? 'file' : 'memory'}, model=${resolveChatAdapter(state) ? 'configured' : 'not-configured'}, workspace=${workspace ? 'configured' : 'off'}, discovery=${config.moduleDirectoryUrl ? 'configured' : 'off'}, connectors=${connectors.MODULE_IDS.length})`);
}

async function stop() {
  if (!state) return;
  const s = state;
  s.tasks.abortAll();
  s.logger.info('[glim] stopped (data retained)');
  state = null;
}

async function health() {
  return {
    ok: true,
    started: Boolean(state),
    storage: state ? (state.config.dataFile ? 'file' : 'memory') : null,
    model: state ? (resolveChatAdapter(state) ? 'configured' : 'not-configured') : null,
    workspace: state ? Boolean(state.workspace) : false,
    discovery: state ? Boolean(state.config.moduleDirectoryUrl) : false,
    connectors: state ? connectors.MODULE_IDS.slice() : [],
    tasks: state ? state.tasks.health() : { active: 0 }
  };
}

const routes = [
  // 会话与消息
  { method: 'GET', path: `${ROUTE_PREFIX}/sessions`, handler: listSessions },
  { method: 'POST', path: `${ROUTE_PREFIX}/sessions`, handler: createSession },
  { method: 'GET', path: `${ROUTE_PREFIX}/sessions/:id`, handler: getSession },
  { method: 'DELETE', path: `${ROUTE_PREFIX}/sessions/:id`, handler: deleteSession },
  { method: 'GET', path: `${ROUTE_PREFIX}/sessions/:id/messages`, handler: listMessages },
  { method: 'POST', path: `${ROUTE_PREFIX}/sessions/:id/messages`, handler: postMessage },
  // 对话（无 sessionId 时是一次性补全，不落库）
  { method: 'POST', path: `${ROUTE_PREFIX}/chat`, handler: chat },
  // 长期记忆
  { method: 'GET', path: `${ROUTE_PREFIX}/memory`, handler: getMemory },
  { method: 'PUT', path: `${ROUTE_PREFIX}/memory`, handler: putMemory },
  // 工作区
  { method: 'GET', path: `${ROUTE_PREFIX}/workspace`, handler: listWorkspace },
  { method: 'GET', path: `${ROUTE_PREFIX}/workspace/file`, handler: getWorkspaceFile },
  { method: 'PUT', path: `${ROUTE_PREFIX}/workspace/file`, handler: putWorkspaceFile },
  { method: 'POST', path: `${ROUTE_PREFIX}/workspace/delete`, handler: deleteWorkspaceFile },
  // 模块发现
  { method: 'GET', path: `${ROUTE_PREFIX}/discovery`, handler: getDiscovery },
  { method: 'POST', path: `${ROUTE_PREFIX}/connectors/from-module`, handler: createModuleConnector },
  // 连接登记与授权
  { method: 'GET', path: `${ROUTE_PREFIX}/connectors`, handler: listConnectors },
  { method: 'POST', path: `${ROUTE_PREFIX}/connectors`, handler: createConnector },
  { method: 'GET', path: `${ROUTE_PREFIX}/connectors/:id`, handler: getConnector },
  { method: 'DELETE', path: `${ROUTE_PREFIX}/connectors/:id`, handler: deleteConnector },
  { method: 'POST', path: `${ROUTE_PREFIX}/connectors/:id/grant`, handler: grantConnector },
  { method: 'POST', path: `${ROUTE_PREFIX}/connectors/:id/revoke`, handler: revokeConnector },
  // 工具
  { method: 'GET', path: `${ROUTE_PREFIX}/tools`, handler: listTools },
  { method: 'POST', path: `${ROUTE_PREFIX}/tools/:name/invoke`, handler: invokeTool },
  // 任务
  { method: 'GET', path: `${ROUTE_PREFIX}/tasks`, handler: listTasks },
  { method: 'POST', path: `${ROUTE_PREFIX}/tasks`, handler: createTask },
  { method: 'GET', path: `${ROUTE_PREFIX}/tasks/:id`, handler: getTask },
  { method: 'POST', path: `${ROUTE_PREFIX}/tasks/:id/stop`, handler: stopTask },
  { method: 'POST', path: `${ROUTE_PREFIX}/tasks/:id/resume`, handler: resumeTask },
  // 审计
  { method: 'GET', path: `${ROUTE_PREFIX}/audit`, handler: listAudit },
  // 控制台状态
  { method: 'GET', path: `${ROUTE_PREFIX}/health`, handler: getHealth }
];

module.exports = { start, stop, health, routes, tools };
