'use strict';
// PagesAI 公开版 Mail 模块（方案 §7.5）。
//
// 设计边界：
//  - 只依赖 Node 内置模块与公共核心（CoreError / JsonStore）；
//  - 发信、收件都由部署注入适配器（config.transport.sendMail / config.imap），
//    未配置时明确返回 409，绝不伪造“已发送”或“已收件”；
//  - 系统发件身份（config.from）与用户发信权限（config.userSendEnabled）分离；
//  - 所有写操作默认要求登录；验证码可显式通过 verification.public 开放给注册前置流程；
//  - 数据默认纯内存，给出 config.dataFile 时使用 JsonStore 落盘；
//  - HTML 采用白名单净化，附件下载先校验当前用户对邮件的所有权。

const crypto = require('node:crypto');
const { CoreError } = require('../../../core/errors.js');
const { JsonStore } = require('../../../core/storage/json-store.js');
const { createSmtpTransport } = require('../providers/smtp.js');
const { createImapInbox } = require('../providers/imap.js');

const ROUTE_PREFIX = '/api/mail';

const EMAIL_PATTERN = /^[^\s@<>(),;:\\"\[\]]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const MAX_RECIPIENTS = 20;
const MAX_SUBJECT = 500;
const MAX_TEXT = 100_000;
const MAX_HTML_INPUT = 1_000_000;
const MAX_HTML = 500_000;
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const DEFAULT_PAGE_LIMIT = 30;
const MAX_PAGE_LIMIT = 100;
const MAX_PAGE_OFFSET = 10_000;

// 验证码默认策略（与方案 §7.5 一致）。部署可在 config.verification 内收紧或放宽，
// 但默认值就是验收口径：10 分钟窗口最多 5 次，验证码 10 分钟有效。
const VERIFICATION_DEFAULTS = Object.freeze({
  windowMs: 10 * 60 * 1000,
  maxPerWindow: 5,
  ttlMs: 10 * 60 * 1000,
  maxAttempts: 5,
  public: false
});

const HTML_ALLOWED_TAGS = new Set([
  'a', 'p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's',
  'blockquote', 'pre', 'code', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'img'
]);
const HTML_VOID_TAGS = new Set(['br', 'hr', 'img']);
// 这些标签连同内部内容一起丢弃，避免 <script> 文本再次被拼回标签。
const HTML_DROP_CONTENT_TAGS = [
  'script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript',
  'svg', 'math', 'form', 'textarea', 'select', 'button', 'link', 'meta', 'base'
];
const HTML_DROP_CONTENT_RE = new RegExp(
  `<(${HTML_DROP_CONTENT_TAGS.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`,
  'gi'
);
const HTML_DROP_TAG_RE = new RegExp(
  `<\\/?(${HTML_DROP_CONTENT_TAGS.join('|')})\\b[^>]*>`,
  'gi'
);
const HTML_TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g;
const HTML_ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const DANGEROUS_CONTENT_TYPES = /^(?:text\/html|application\/xhtml\+xml|image\/svg\+xml|application\/(?:java|ecma)script|text\/javascript|application\/xml|text\/xml)$/i;

/** 生成带 HTTP 状态的可安全展示的模块错误（不携带秘密与内部细节）。 */
function fail(code, message, status) {
  return new CoreError(code, message, { status });
}

function safeHeader(value, maxLength) {
  const text = value === undefined || value === null ? '' : String(value);
  return text.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

/** 展示型邮件头：额外去掉尖括号，避免前端误当 HTML 拼接。 */
function safeDisplayHeader(value, maxLength) {
  return safeHeader(value, maxLength).replace(/[<>]/g, '');
}

function safeId(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
}

function stripNulls(value) {
  return String(value).replace(/\u0000/g, '');
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  const email = value.trim();
  if (email.length === 0 || email.length > 254) return '';
  return EMAIL_PATTERN.test(email) ? email : '';
}

function parseRecipients(value) {
  if (value === undefined || value === null) return [];
  const source = Array.isArray(value) ? value : String(value).split(/[;,]/);
  if (!Array.isArray(source) || source.length === 0 || source.length > MAX_RECIPIENTS) return [];
  const recipients = [];
  const seen = new Set();
  for (const item of source) {
    if (typeof item !== 'string') return [];
    let candidate = item;
    const named = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(item);
    if (named) candidate = named[2];
    const email = normalizeEmail(candidate);
    if (!email) return [];
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(email);
  }
  return recipients.length > 0 && recipients.length <= MAX_RECIPIENTS ? recipients : [];
}

function normalizeFrom(value) {
  let address = '';
  let name = '';
  if (typeof value === 'string') {
    const named = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(value);
    if (named) {
      name = safeHeader(named[1].replace(/^"|"$/g, ''), 120);
      address = normalizeEmail(named[2]);
    } else {
      address = normalizeEmail(value);
    }
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    address = normalizeEmail(value.address || value.email || '');
    name = safeHeader(value.name || '', 120);
  }
  if (!address) return null;
  return { address, name: name || null };
}

function actorId(user) {
  if (!user || typeof user !== 'object') return null;
  const raw = user.id !== undefined ? user.id : (user.userId !== undefined ? user.userId : user.username);
  if (raw === undefined || raw === null) return null;
  const id = String(raw).trim().slice(0, 200);
  return id || null;
}

function hashString(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isoNow(clock) {
  return new Date(clock()).toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function briefError(error) {
  let text = error && error.message ? String(error.message) : String(error || 'unknown');
  // 适配器错误可能把认证信息写进 message；日志前先做一次保守脱敏。
  text = text.replace(/(password|passwd|pass|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=***');
  if (error && error.code) text = `${error.code}: ${text}`;
  return text.slice(0, 300);
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function safeFilename(value, fallback = 'attachment') {
  const name = String(value === undefined || value === null ? fallback : value)
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180);
  return name || fallback;
}

function safeContentType(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i.test(text)
    ? text
    : 'application/octet-stream';
}

function safeSize(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(number, Number.MAX_SAFE_INTEGER) : null;
}

function decodeBase64(value) {
  const text = String(value).replace(/\s+/g, '');
  if (text === '') return Buffer.alloc(0);
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw fail('mail.invalid_input', '附件内容不是合法 Base64', 400);
  }
  return Buffer.from(text, 'base64');
}

function decodeBase64Safe(value) {
  try {
    return decodeBase64(value);
  } catch {
    return null;
  }
}

function toIso(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

// ---------------------------------------------------------------------------
// HTML 净化：白名单标签 + 属性白名单 + URL 协议校验。
// 不依赖第三方库，覆盖 script/iframe/on* 属性/javascript:、data:、vbscript: 等风险。
// ---------------------------------------------------------------------------

const HTML_ENTITY_MAP = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  colon: ':', tab: '\t', newline: '\n', sol: '/', bsol: '\\'
});

function decodeEntities(value) {
  return String(value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, body) => {
    if (body[0] === '#') {
      const hexadecimal = body[1] === 'x' || body[1] === 'X';
      const codePoint = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return '';
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return '';
      }
    }
    const named = HTML_ENTITY_MAP[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function escapeText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sanitizeUrl(value, { image = false } = {}) {
  let url = String(value === undefined || value === null ? '' : value);
  // 先解码，再剔除控制字符，再解码一次：覆盖 java&#x0A;script: 这类绕过。
  for (let index = 0; index < 3; index += 1) url = decodeEntities(url);
  url = url.replace(/[\u0000-\u0020\u007f]+/g, '');
  url = decodeEntities(url).replace(/[\u0000-\u0020\u007f]+/g, '').trim();
  if (!url) return null;
  if (url.startsWith('//')) return null;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (image) {
      if (name !== 'http' && name !== 'https') return null;
    } else if (!['http', 'https', 'mailto'].includes(name)) {
      return null;
    }
    return url;
  }
  if (image) return null;
  // 相对链接允许以 /、#、? 或普通路径字符开头。
  return /^[\/#?a-zA-Z0-9._~-]/.test(url) ? url : null;
}

function parseAttributes(source) {
  const attrs = {};
  HTML_ATTR_RE.lastIndex = 0;
  let match;
  while ((match = HTML_ATTR_RE.exec(source)) !== null) {
    const name = match[1].toLowerCase();
    // 事件处理器、xmlns/xlink 等带冒号或非白名单属性一律丢弃。
    if (!/^[a-z][a-z0-9-]*$/.test(name)) continue;
    if (name.startsWith('on')) continue;
    attrs[name] = match[3] !== undefined ? match[3] : (match[4] !== undefined ? match[4] : (match[5] !== undefined ? match[5] : ''));
  }
  return attrs;
}

function renderAttributes(entries) {
  let output = '';
  for (const [name, value] of entries) {
    output += ` ${name}="${escapeAttr(value)}"`;
  }
  return output;
}

function sanitizeHtml(input) {
  if (typeof input !== 'string' || input.length === 0) return '';
  let html = input.slice(0, MAX_HTML_INPUT);
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  // 先移除危险标签及其内容，再移除残留的开/闭标签。
  html = html.replace(HTML_DROP_CONTENT_RE, '');
  html = html.replace(HTML_DROP_TAG_RE, '');

  let output = '';
  let lastIndex = 0;
  let match;
  HTML_TAG_RE.lastIndex = 0;
  while ((match = HTML_TAG_RE.exec(html)) !== null) {
    const text = html.slice(lastIndex, match.index);
    output += escapeText(decodeEntities(text));
    lastIndex = HTML_TAG_RE.lastIndex;

    const tagText = match[0];
    const closing = tagText.startsWith('</');
    const rawName = match[1].toLowerCase();
    const name = rawName === 'strike' ? 's' : rawName;
    if (!HTML_ALLOWED_TAGS.has(name)) continue;

    if (closing) {
      if (!HTML_VOID_TAGS.has(name)) output += `</${name}>`;
      continue;
    }

    const attrs = parseAttributes(match[2] || '');
    const rendered = [];

    if (name === 'a') {
      const href = sanitizeUrl(attrs.href, { image: false });
      if (href) rendered.push(['href', href]);
      const title = safeHeader(attrs.title, 300);
      if (title) rendered.push(['title', title]);
      rendered.push(['rel', 'noopener noreferrer nofollow']);
      rendered.push(['target', '_blank']);
    } else if (name === 'img') {
      const src = sanitizeUrl(attrs.src, { image: true });
      if (!src) continue; // 没有安全 src 的图片直接丢弃
      rendered.push(['src', src]);
      const alt = safeHeader(attrs.alt, 500);
      rendered.push(['alt', alt]);
      const title = safeHeader(attrs.title, 300);
      if (title) rendered.push(['title', title]);
      for (const dimension of ['width', 'height']) {
        const value = safeHeader(attrs[dimension], 8);
        if (/^\d{1,4}$/.test(value)) rendered.push([dimension, value]);
      }
    } else if (name === 'td' || name === 'th') {
      for (const span of ['colspan', 'rowspan']) {
        const value = safeHeader(attrs[span], 4);
        if (/^\d{1,3}$/.test(value) && Number(value) >= 1 && Number(value) <= 100) rendered.push([span, value]);
      }
    }

    output += `<${name}${renderAttributes(rendered)}>`;
  }

  output += escapeText(decodeEntities(html.slice(lastIndex)));

  // 兜底：即使解析有遗漏，也不让事件属性与 javascript: 文本出现在输出里。
  output = output.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  output = output.replace(/javascript\s*:/gi, '');
  return output;
}

// ---------------------------------------------------------------------------
// 入站邮件归一化：只保留白名单字段；正文 HTML 二次净化；附件仅保留元数据。
// ---------------------------------------------------------------------------

function formatAddress(value) {
  if (Array.isArray(value)) {
    return value.map((item) => formatAddress(item)).filter(Boolean).join(', ').slice(0, 1000);
  }
  if (value && typeof value === 'object') {
    const name = safeDisplayHeader(value.name, 120);
    const address = safeDisplayHeader(value.address || value.email, 254);
    if (name && address) return `${name} <${address}>`;
    return address || name;
  }
  return safeDisplayHeader(value, 1000);
}

function plainSnippet(value) {
  const text = decodeEntities(String(value === undefined || value === null ? '' : value).replace(/<[^>]*>/g, ' '));
  return text.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function normalizeAttachmentMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = safeId(raw.id !== undefined ? raw.id : (raw.attachmentId !== undefined ? raw.attachmentId : raw.part));
  if (!id) return null;
  return {
    id,
    filename: safeFilename(raw.filename !== undefined ? raw.filename : raw.name),
    contentType: safeContentType(raw.contentType !== undefined ? raw.contentType : raw.type),
    size: safeSize(raw.size)
  };
}

function normalizeIncomingMessage(raw, { includeBody = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const id = safeId(raw.id !== undefined ? raw.id : (raw.uid !== undefined ? raw.uid : raw.messageId));
  if (!id) return null;
  const attachments = (Array.isArray(raw.attachments) ? raw.attachments : [])
    .map((item) => normalizeAttachmentMeta(item))
    .filter(Boolean)
    .slice(0, 50);
  const message = {
    id,
    from: formatAddress(raw.from !== undefined ? raw.from : raw.fromAddress),
    to: formatAddress(raw.to !== undefined ? raw.to : raw.toAddress),
    subject: safeDisplayHeader(raw.subject !== undefined ? raw.subject : '(无主题)', MAX_SUBJECT),
    date: toIso(raw.date !== undefined ? raw.date : (raw.receivedAt !== undefined ? raw.receivedAt : raw.internalDate)),
    snippet: plainSnippet(raw.snippet !== undefined ? raw.snippet : raw.preview),
    unread: raw.unread === true || raw.seen === false,
    hasAttachments: raw.hasAttachments === true || attachments.length > 0,
    attachments
  };
  if (includeBody) {
    const rawHtml = typeof raw.html === 'string' ? raw.html : (typeof raw.bodyHtml === 'string' ? raw.bodyHtml : '');
    const rawText = typeof raw.text === 'string' ? raw.text : (typeof raw.bodyText === 'string' ? raw.bodyText : '');
    message.html = rawHtml ? sanitizeHtml(rawHtml).slice(0, MAX_HTML) : '';
    message.text = rawText ? stripNulls(rawText).slice(0, MAX_TEXT) : '';
  }
  return message;
}

function summaryOf(message) {
  const summary = clone(message);
  delete summary.html;
  delete summary.text;
  return summary;
}

function normalizeListResult(result) {
  let messages = null;
  let total = null;
  if (Array.isArray(result)) {
    messages = result;
    total = result.length;
  } else if (result && typeof result === 'object' && Array.isArray(result.messages)) {
    messages = result.messages;
    total = Number.isSafeInteger(result.total) && result.total >= 0 ? result.total : messages.length;
  } else {
    return null;
  }
  return { messages, total };
}

function normalizeDeliveryStatus(value) {
  return ['delivered', 'deferred', 'failed', 'unknown'].includes(value) ? value : 'unknown';
}

function pickMessageId(info) {
  if (!info || typeof info !== 'object') return null;
  const raw = info.messageId !== undefined ? info.messageId : (info.id !== undefined ? info.id : info.responseId);
  const id = safeId(raw);
  return id || null;
}

// ---------------------------------------------------------------------------
// 模块工厂
// ---------------------------------------------------------------------------

function createMailModule() {
  const state = {
    started: false,
    store: null,
    config: {},
    transport: null,
    imap: null,
    from: null,
    userSendEnabled: false,
    verification: { ...VERIFICATION_DEFAULTS },
    attachments: { maxBytes: MAX_TOTAL_ATTACHMENT_BYTES },
    sendTimeoutMs: 30_000,
    clock: () => Date.now(),
    codeGenerator: null,
    logger: { info() {}, warn() {}, error() {} },
    pending: new Map()
  };

  function log(level, message) {
    const fn = state.logger && state.logger[level];
    if (typeof fn === 'function') {
      try {
        fn(message);
      } catch {
        // 日志失败不影响业务。
      }
    }
  }

  function handle(handler) {
    return async function wrapped(ctx = {}) {
      try {
        if (!state.started) throw fail('mail.not_started', 'Mail 模块尚未启动', 503);
        return await handler(ctx);
      } catch (error) {
        if (error instanceof CoreError) {
          return { status: error.status, body: { code: error.code, message: error.message } };
        }
        log('error', `[mail] 未处理异常: ${briefError(error)}`);
        return { status: 500, body: { code: 'mail.internal_error', message: '邮件服务内部错误' } };
      }
    };
  }

  function requireUser(ctx) {
    const id = actorId(ctx && ctx.user);
    if (!id) throw fail('mail.unauthenticated', '需要登录后才能执行该操作', 403);
    return {
      id,
      raw: ctx.user,
      email: normalizeEmail(ctx.user.email)
    };
  }

  function optionalUser(ctx) {
    const id = actorId(ctx && ctx.user);
    if (!id) return null;
    return { id, raw: ctx.user, email: normalizeEmail(ctx.user.email) };
  }

  function adapterUser(user) {
    return {
      id: user.id,
      username: user.raw && user.raw.username !== undefined ? String(user.raw.username) : null,
      email: user.email || null
    };
  }

  function readBody(ctx) {
    const body = ctx ? ctx.body : undefined;
    if (body === undefined || body === null) return {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      throw fail('mail.invalid_input', '请求体必须是 JSON 对象', 400);
    }
    return body;
  }

  function queryValue(ctx, key) {
    const query = ctx ? ctx.query : undefined;
    if (!query) return undefined;
    if (typeof query.get === 'function') return query.get(key) === null ? undefined : query.get(key);
    return query[key];
  }

  function normalizeFolder(value) {
    const folder = String(value === undefined || value === null || value === '' ? 'INBOX' : value).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(folder)) {
      throw fail('mail.invalid_input', '邮箱文件夹名称不合法', 400);
    }
    return folder;
  }

  function folderOf(ctx, body) {
    if (body && body.folder !== undefined) return normalizeFolder(body.folder);
    const queryFolder = queryValue(ctx, 'folder');
    return normalizeFolder(queryFolder);
  }

  function readIdempotencyKey(ctx, body) {
    let value = body ? body.idempotencyKey : undefined;
    if (value === undefined && ctx && ctx.req && ctx.req.headers) {
      value = ctx.req.headers['idempotency-key'];
      if (value === undefined) value = ctx.req.headers['Idempotency-Key'];
    }
    if (value === undefined || value === null) return null;
    if (Array.isArray(value)) value = value[0];
    if (typeof value !== 'string') throw fail('mail.invalid_input', 'idempotencyKey 必须是字符串', 400);
    const key = value.trim();
    if (!key || key.length > 200) throw fail('mail.invalid_input', 'idempotencyKey 长度必须在 1–200 之间', 400);
    return key;
  }

  function requireTransport() {
    if (!state.transport || typeof state.transport.sendMail !== 'function') {
      throw fail('mail.transport_not_configured', '未配置发信适配器（config.transport.sendMail），无法发信', 409);
    }
    return state.transport;
  }

  function requireFrom() {
    if (!state.from || !state.from.address) {
      throw fail('mail.from_not_configured', '未配置系统发件身份（config.from），无法发信', 409);
    }
    return state.from;
  }

  function requireImap() {
    if (!state.imap || typeof state.imap !== 'object') {
      throw fail('mail.imap_not_configured', '未配置 IMAP 收件适配器（config.imap），无法访问邮箱', 409);
    }
    return state.imap;
  }

  function requireImapMethod(name) {
    const imap = requireImap();
    if (typeof imap[name] !== 'function') {
      throw fail('mail.imap_not_configured', 'IMAP 适配器缺少所需能力，无法访问邮箱', 409);
    }
    return imap[name].bind(imap);
  }

  function putRecord(collection, id, value) {
    if (state.store.has(collection, id)) return state.store.update(collection, id, value);
    return state.store.put(collection, id, value);
  }

  function replaceRecord(collection, id, value) {
    if (state.store.has(collection, id)) state.store.remove(collection, id);
    return state.store.put(collection, id, value);
  }

  function updateRecord(collection, id, patch) {
    if (state.store.has(collection, id)) return state.store.update(collection, id, patch);
    return state.store.put(collection, id, patch);
  }

  function idempotencyStoreId(userId, key) {
    return hashString(`idem\u0000${userId}\u0000${key}`);
  }

  function findIdempotency(userId, key) {
    if (!key) return null;
    return state.store.get('idempotency')[idempotencyStoreId(userId, key)] || null;
  }

  function saveIdempotency(userId, key, fingerprint, status, body) {
    if (!key) return;
    const id = idempotencyStoreId(userId, key);
    putRecord('idempotency', id, {
      id,
      userId,
      key,
      fingerprint,
      status,
      body: clone(body),
      createdAt: isoNow(state.clock)
    });
  }

  function normalizeOutgoingAttachments(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw fail('mail.invalid_input', 'attachments 必须是数组', 400);
    if (value.length > MAX_ATTACHMENTS) throw fail('mail.invalid_input', `附件不得超过 ${MAX_ATTACHMENTS} 个`, 400);
    const attachments = [];
    let total = 0;
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw fail('mail.invalid_input', '附件格式不正确', 400);
      }
      const filename = safeFilename(item.filename !== undefined ? item.filename : item.name);
      const contentType = safeContentType(item.contentType !== undefined ? item.contentType : item.type);
      let content;
      if (Buffer.isBuffer(item.content)) content = Buffer.from(item.content);
      else if (typeof item.contentBase64 === 'string') content = decodeBase64(item.contentBase64);
      else if (typeof item.content === 'string') content = decodeBase64(item.content);
      else throw fail('mail.invalid_input', '附件内容必须是 Base64 字符串', 400);
      if (content.length > MAX_ATTACHMENT_BYTES) {
        throw fail('mail.invalid_input', '单个附件超过大小限制', 413);
      }
      total += content.length;
      if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
        throw fail('mail.invalid_input', '附件总大小超过限制', 413);
      }
      attachments.push({ filename, contentType, content });
    }
    return attachments;
  }

  function buildSendEnvelope(body) {
    if (body.subject !== undefined && typeof body.subject !== 'string') {
      throw fail('mail.invalid_input', 'subject 必须是字符串', 400);
    }
    if (body.text !== undefined && typeof body.text !== 'string') {
      throw fail('mail.invalid_input', 'text 必须是字符串', 400);
    }
    if (body.html !== undefined && typeof body.html !== 'string') {
      throw fail('mail.invalid_input', 'html 必须是字符串', 400);
    }
    const to = parseRecipients(body.to);
    if (to.length === 0) throw fail('mail.invalid_input', '收件人格式不正确或数量超出限制', 400);
    const subject = safeHeader(body.subject || '', MAX_SUBJECT);
    const text = body.text ? stripNulls(body.text) : '';
    const htmlInput = body.html ? stripNulls(body.html) : '';
    if (!text && !htmlInput) throw fail('mail.invalid_input', '邮件正文不能为空', 400);
    if (text.length > MAX_TEXT) throw fail('mail.invalid_input', '纯文本正文超过大小限制', 413);
    if (htmlInput.length > MAX_HTML_INPUT) throw fail('mail.invalid_input', 'HTML 正文超过大小限制', 413);
    const html = htmlInput ? sanitizeHtml(htmlInput) : '';
    if (html.length > MAX_HTML) throw fail('mail.invalid_input', '净化后的 HTML 正文超过大小限制', 413);
    const attachments = normalizeOutgoingAttachments(body.attachments);
    const fingerprint = hashString(JSON.stringify({
      to,
      subject,
      text,
      html,
      attachments: attachments.map((item) => ({
        filename: item.filename,
        contentType: item.contentType,
        sha256: hashString(item.content)
      }))
    }));
    return { to, subject, text, html, attachments, fingerprint };
  }

  async function invokeTransport(message) {
    const payload = {
      from: message.from.name
        ? { name: message.from.name, address: message.from.address }
        : { address: message.from.address },
      to: message.to.slice(),
      subject: message.subject,
      text: message.text,
      html: message.html,
      attachments: message.attachments.map((item) => ({
        filename: item.filename,
        contentType: item.contentType,
        content: Buffer.from(item.content)
      })),
      meta: { module: 'mail', kind: message.kind, outboxId: message.outboxId }
    };
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('transport sendMail timeout');
        error.code = 'ETIMEDOUT';
        reject(error);
      }, state.sendTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    try {
      const pending = Promise.resolve().then(() => state.transport.sendMail(payload));
      const info = await Promise.race([pending, timeout]);
      if (info && typeof info === 'object') {
        if (info.accepted === false || info.ok === false || info.error) throw new Error('transport rejected message');
        if (Array.isArray(info.accepted) && info.accepted.length === 0) {
          throw new Error('transport accepted no recipients');
        }
      }
      return info;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function outboxBase(id, kind, userId, from, message) {
    return {
      id,
      kind,
      userId: userId || null,
      from: from.address,
      to: message.to.slice(),
      subject: message.subject,
      status: 'sending',
      transportStatus: 'pending',
      deliveryStatus: null,
      createdAt: isoNow(state.clock),
      attempts: 1
    };
  }

  async function executeSend(user, from, envelope, idempotencyKey) {
    const id = makeId('mail');
    putRecord('outbox', id, outboxBase(id, 'user', user.id, from, envelope));
    let info;
    try {
      info = await invokeTransport({
        from,
        to: envelope.to,
        subject: envelope.subject,
        text: envelope.text,
        html: envelope.html,
        attachments: envelope.attachments,
        kind: 'user',
        outboxId: id
      });
    } catch (error) {
      log('error', `[mail] 用户发信失败: ${briefError(error)}`);
      updateRecord('outbox', id, {
        status: 'failed',
        transportStatus: 'failed',
        deliveryStatus: null,
        errorCode: 'mail.send_failed',
        finishedAt: isoNow(state.clock)
      });
      const body = { code: 'mail.send_failed', message: '发信失败，请稍后重试' };
      saveIdempotency(user.id, idempotencyKey, envelope.fingerprint, 502, body);
      return { status: 502, body };
    }

    const deliveryStatus = normalizeDeliveryStatus(info && info.deliveryStatus);
    const providerMessageId = pickMessageId(info);
    updateRecord('outbox', id, {
      status: 'accepted',
      transportStatus: 'accepted',
      deliveryStatus,
      providerMessageId,
      finishedAt: isoNow(state.clock)
    });
    const body = {
      ok: true,
      id,
      status: 'accepted',
      transportStatus: 'accepted',
      deliveryStatus,
      messageId: providerMessageId,
      from: from.address,
      to: envelope.to,
      createdAt: isoNow(state.clock)
    };
    saveIdempotency(user.id, idempotencyKey, envelope.fingerprint, 200, body);
    return { status: 200, body };
  }

  async function deliverSystemMail(from, message) {
    const id = makeId('mail');
    putRecord('outbox', id, outboxBase(id, message.kind || 'system', null, from, message));
    try {
      const info = await invokeTransport({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        attachments: [],
        kind: message.kind || 'system',
        outboxId: id
      });
      const deliveryStatus = normalizeDeliveryStatus(info && info.deliveryStatus);
      const providerMessageId = pickMessageId(info);
      updateRecord('outbox', id, {
        status: 'accepted',
        transportStatus: 'accepted',
        deliveryStatus,
        providerMessageId,
        finishedAt: isoNow(state.clock)
      });
      return { id, deliveryStatus, providerMessageId };
    } catch (error) {
      updateRecord('outbox', id, {
        status: 'failed',
        transportStatus: 'failed',
        deliveryStatus: null,
        errorCode: 'mail.send_failed',
        finishedAt: isoNow(state.clock)
      });
      throw error;
    }
  }

  function verificationTtlMinutes() {
    return Math.max(1, Math.round(state.verification.ttlMs / 60_000));
  }

  function verificationSends(record, now) {
    if (!record || !Array.isArray(record.sends)) return [];
    return record.sends.filter((item) => (
      item
      && Number.isFinite(item.at)
      && now - item.at >= 0
      && now - item.at < state.verification.windowMs
    ));
  }

  function generateVerificationCode() {
    const generated = typeof state.codeGenerator === 'function' ? state.codeGenerator() : null;
    const code = generated === null || generated === undefined
      ? String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
      : String(generated).trim();
    if (!/^[0-9A-Za-z]{4,10}$/.test(code)) {
      throw fail('mail.internal_error', '验证码生成器返回了非法验证码', 500);
    }
    return code;
  }

  function resolutionEmail(body, user) {
    const raw = body && body.email !== undefined ? body.email : (user ? user.email : '');
    return normalizeEmail(raw);
  }

  // ------------------------------ 路由处理函数 ------------------------------

  async function sendHandler(ctx) {
    const user = requireUser(ctx);
    // 先给出“适配器未配置”的明确 409，避免部署缺配置时被误判为用户权限问题。
    requireTransport();
    if (state.userSendEnabled !== true) {
      throw fail('mail.user_send_disabled', '当前部署未开放用户发信', 403);
    }
    const from = requireFrom();
    const body = readBody(ctx);
    if (body.from !== undefined || body.sender !== undefined) {
      throw fail('mail.invalid_input', '不允许指定发件人；系统发件身份由部署配置决定', 400);
    }
    const envelope = buildSendEnvelope(body);
    const idempotencyKey = readIdempotencyKey(ctx, body);

    if (idempotencyKey) {
      const existing = findIdempotency(user.id, idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== envelope.fingerprint) {
          throw fail('mail.idempotency_conflict', '同一幂等键携带了不同的发信内容', 409);
        }
        return { status: existing.status, body: clone(existing.body) };
      }
    }

    if (!idempotencyKey) return executeSend(user, from, envelope, null);

    const pendingKey = `${user.id}\u0000${idempotencyKey}`;
    const pending = state.pending.get(pendingKey);
    if (pending) {
      if (pending.fingerprint !== envelope.fingerprint) {
        throw fail('mail.idempotency_conflict', '同一幂等键携带了不同的发信内容', 409);
      }
      return pending.promise;
    }

    const task = (async () => {
      const again = findIdempotency(user.id, idempotencyKey);
      if (again) {
        if (again.fingerprint !== envelope.fingerprint) {
          throw fail('mail.idempotency_conflict', '同一幂等键携带了不同的发信内容', 409);
        }
        return { status: again.status, body: clone(again.body) };
      }
      return executeSend(user, from, envelope, idempotencyKey);
    })();
    const tracked = task.finally(() => {
      const current = state.pending.get(pendingKey);
      if (current && current.promise === tracked) state.pending.delete(pendingKey);
    });
    state.pending.set(pendingKey, { fingerprint: envelope.fingerprint, promise: tracked });
    return tracked;
  }

  async function verificationHandler(ctx) {
    const body = readBody(ctx);
    const user = state.verification.public ? optionalUser(ctx) : requireUser(ctx);
    const email = resolutionEmail(body, user);
    if (!email) throw fail('mail.invalid_input', '邮箱格式不正确', 400);
    requireTransport();
    const from = requireFrom();

    const now = state.clock();
    const key = hashString(`verify\u0000${email}`);
    const existingRecord = state.store.get('verification')[key] || null;
    const previous = existingRecord ? clone(existingRecord) : null;
    const sends = verificationSends(existingRecord, now);
    if (sends.length >= state.verification.maxPerWindow) {
      throw fail('mail.verification_rate_limited', '验证码发送过于频繁，请稍后重试', 429);
    }

    const code = generateVerificationCode();
    const salt = crypto.randomBytes(16).toString('hex');
    const attemptId = crypto.randomBytes(8).toString('hex');
    const purpose = safeHeader(body.purpose === undefined ? 'verify' : body.purpose, 40) || 'verify';
    const record = {
      id: key,
      email,
      codeHash: hashString(`${salt}:${code}`),
      salt,
      purpose,
      createdAt: now,
      expiresAt: now + state.verification.ttlMs,
      attempts: 0,
      sends: [...sends, { at: now, id: attemptId }],
      actorUserId: user ? user.id : null,
      lastAttemptId: attemptId,
      lastSentAt: now,
      verifiedAt: null
    };
    replaceRecord('verification', key, record);

    try {
      await deliverSystemMail(from, {
        to: [email],
        subject: '【PagesAI】邮箱验证码',
        text: `您的验证码是 ${code}，${verificationTtlMinutes()} 分钟内有效。如非本人操作请忽略。`,
        html: `<p>您的验证码是 <strong>${escapeText(code)}</strong>，${verificationTtlMinutes()} 分钟内有效。</p><p>如非本人操作请忽略。</p>`,
        kind: 'verification'
      });
    } catch (error) {
      log('error', `[mail] 验证码发信失败: ${briefError(error)}`);
      const current = state.store.get('verification')[key];
      if (current && current.lastAttemptId === attemptId) {
        if (previous) replaceRecord('verification', key, previous);
        else state.store.remove('verification', key);
      }
      throw fail('mail.send_failed', '验证码发送失败，请稍后重试', 502);
    }

    // 响应与收件人是否存在完全无关；不返回验证码，也不返回账号状态。
    return {
      status: 200,
      body: {
        ok: true,
        status: 'accepted',
        expiresIn: Math.floor(state.verification.ttlMs / 1000)
      }
    };
  }

  async function verificationVerifyHandler(ctx) {
    const body = readBody(ctx);
    const user = state.verification.public ? optionalUser(ctx) : requireUser(ctx);
    const email = resolutionEmail(body, user);
    if (!email) throw fail('mail.invalid_input', '邮箱格式不正确', 400);
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!/^[0-9A-Za-z]{4,10}$/.test(code)) {
      throw fail('mail.verification_invalid', '验证码无效或已过期', 400);
    }

    const key = hashString(`verify\u0000${email}`);
    const record = state.store.get('verification')[key] || null;
    const now = state.clock();
    if (!record || !record.codeHash || !record.salt || !Number.isFinite(record.expiresAt)) {
      throw fail('mail.verification_invalid', '验证码无效或已过期', 400);
    }
    if (now > record.expiresAt) {
      updateRecord('verification', key, { codeHash: null, salt: null, expiresAt: 0 });
      throw fail('mail.verification_invalid', '验证码无效或已过期', 400);
    }
    if ((record.attempts || 0) >= state.verification.maxAttempts) {
      throw fail('mail.verification_rate_limited', '验证码尝试次数过多，请重新获取', 429);
    }
    const expected = Buffer.from(record.codeHash, 'hex');
    const actual = Buffer.from(hashString(`${record.salt}:${code}`), 'hex');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      updateRecord('verification', key, { attempts: (record.attempts || 0) + 1 });
      throw fail('mail.verification_invalid', '验证码无效或已过期', 400);
    }

    // 验证成功后只清空验证码，保留 sends 计数，避免“验证一次就重置限流”。
    updateRecord('verification', key, {
      codeHash: null,
      salt: null,
      expiresAt: 0,
      attempts: 0,
      verifiedAt: now
    });
    return { status: 200, body: { ok: true, email, purpose: record.purpose || 'verify' } };
  }

  function indexMessages(user, folder, messages) {
    for (const message of messages) {
      const id = hashString(`mi\u0000${folder}\u0000${message.id}`);
      const existing = state.store.get('mailbox_index')[id] || {
        id,
        folder,
        messageId: message.id,
        owners: {}
      };
      existing.folder = folder;
      existing.messageId = message.id;
      existing.owners = existing.owners && typeof existing.owners === 'object' ? existing.owners : {};
      existing.owners[user.id] = {
        summary: summaryOf(message),
        indexedAt: isoNow(state.clock)
      };
      if (state.store.has('mailbox_index', id)) {
        state.store.update('mailbox_index', id, {
          folder,
          messageId: message.id,
          owners: existing.owners
        });
      } else {
        state.store.put('mailbox_index', id, existing);
      }
    }
  }

  function ownershipFor(folder, messageId) {
    return state.store.get('mailbox_index')[hashString(`mi\u0000${folder}\u0000${messageId}`)] || null;
  }

  function assertOwnership(user, folder, messageId) {
    const record = ownershipFor(folder, messageId);
    if (!record) throw fail('mail.message_not_found', '邮件不存在', 404);
    if (!record.owners || !record.owners[user.id]) {
      throw fail('mail.forbidden', '无权访问该邮件', 403);
    }
    return record;
  }

  function removeOwner(record, userId) {
    if (!record || !record.owners) return;
    delete record.owners[userId];
    if (Object.keys(record.owners).length === 0) state.store.remove('mailbox_index', record.id);
    else state.store.update('mailbox_index', record.id, { owners: record.owners });
  }

  async function listMessagesHandler(ctx) {
    const user = requireUser(ctx);
    const listMessages = requireImapMethod('listMessages');
    const folder = folderOf(ctx, null);
    const limit = clampInt(queryValue(ctx, 'limit'), DEFAULT_PAGE_LIMIT, 1, MAX_PAGE_LIMIT);
    const offset = clampInt(queryValue(ctx, 'offset'), 0, 0, MAX_PAGE_OFFSET);

    let result;
    try {
      result = await listMessages({ user: adapterUser(user), folder, limit, offset });
    } catch (error) {
      log('error', `[mail] imap.listMessages 失败: ${briefError(error)}`);
      throw fail('mail.imap_error', '邮箱服务暂时不可用，请稍后重试', 502);
    }
    const normalized = normalizeListResult(result);
    if (!normalized) throw fail('mail.imap_error', '邮箱适配器返回了非法结果', 502);

    const messages = [];
    for (const raw of normalized.messages.slice(0, limit)) {
      const message = normalizeIncomingMessage(raw, { includeBody: true });
      if (!message) throw fail('mail.imap_error', '邮箱适配器返回了缺少 ID 的邮件', 502);
      messages.push(message);
    }
    indexMessages(user, folder, messages);
    return {
      status: 200,
      body: { messages, total: normalized.total, folder, limit, offset }
    };
  }

  async function getMessageHandler(ctx) {
    const user = requireUser(ctx);
    requireImap();
    const folder = folderOf(ctx, null);
    const id = safeId(ctx.params && ctx.params.id);
    if (!id) throw fail('mail.invalid_input', '邮件 ID 不合法', 400);
    const record = assertOwnership(user, folder, id);
    const imap = requireImap();
    const getMessage = typeof imap.getMessage === 'function' ? imap.getMessage.bind(imap) : null;

    if (!getMessage) {
      return { status: 200, body: { message: clone(record.owners[user.id].summary) } };
    }

    let raw;
    try {
      raw = await getMessage({ user: adapterUser(user), folder, id });
    } catch (error) {
      log('error', `[mail] imap.getMessage 失败: ${briefError(error)}`);
      throw fail('mail.imap_error', '邮箱服务暂时不可用，请稍后重试', 502);
    }
    if (!raw) throw fail('mail.message_not_found', '邮件不存在', 404);
    const message = normalizeIncomingMessage(raw, { includeBody: true });
    if (!message || message.id !== id) {
      throw fail('mail.imap_error', '邮箱适配器返回了非法邮件', 502);
    }
    indexMessages(user, folder, [message]);
    return { status: 200, body: { message } };
  }

  async function deleteMessageHandler(ctx) {
    const user = requireUser(ctx);
    const deleteMessage = requireImapMethod('deleteMessage');
    const body = readBody(ctx);
    const folder = folderOf(ctx, body);
    const id = safeId(ctx.params && ctx.params.id);
    if (!id) throw fail('mail.invalid_input', '邮件 ID 不合法', 400);
    const record = assertOwnership(user, folder, id);

    try {
      await deleteMessage({ user: adapterUser(user), folder, id });
    } catch (error) {
      log('error', `[mail] imap.deleteMessage 失败: ${briefError(error)}`);
      throw fail('mail.imap_error', '邮箱服务暂时不可用，请稍后重试', 502);
    }
    removeOwner(record, user.id);
    return { status: 200, body: { ok: true, deleted: true, id, folder } };
  }

  async function deleteMessagesHandler(ctx) {
    const user = requireUser(ctx);
    const deleteMessage = requireImapMethod('deleteMessage');
    const body = readBody(ctx);
    let ids = body.ids;
    if (ids === undefined) ids = queryValue(ctx, 'ids');
    if (ids === undefined) {
      const single = body.id !== undefined ? body.id : queryValue(ctx, 'id');
      if (single !== undefined) ids = [single];
    }
    if (typeof ids === 'string') ids = ids.split(',');
    if (!Array.isArray(ids) || ids.length === 0) {
      throw fail('mail.invalid_input', '需要提供要删除的邮件 ID', 400);
    }
    if (ids.length > 100) throw fail('mail.invalid_input', '一次最多删除 100 封邮件', 400);
    const unique = [];
    const seen = new Set();
    for (const value of ids) {
      const id = safeId(value);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      unique.push(id);
    }
    if (unique.length === 0) throw fail('mail.invalid_input', '需要提供要删除的邮件 ID', 400);

    const folder = folderOf(ctx, body);
    const records = unique.map((id) => assertOwnership(user, folder, id));

    for (let index = 0; index < unique.length; index += 1) {
      try {
        await deleteMessage({ user: adapterUser(user), folder, id: unique[index] });
      } catch (error) {
        log('error', `[mail] imap.deleteMessage 批量失败: ${briefError(error)}`);
        throw fail('mail.imap_error', '邮箱服务暂时不可用，请稍后重试', 502);
      }
      removeOwner(records[index], user.id);
    }
    return { status: 200, body: { ok: true, deleted: unique, folder } };
  }

  function attachmentContent(result) {
    if (Buffer.isBuffer(result)) return Buffer.from(result);
    if (!result || typeof result !== 'object') return null;
    if (Buffer.isBuffer(result.content)) return Buffer.from(result.content);
    if (typeof result.contentBase64 === 'string') return decodeBase64Safe(result.contentBase64);
    if (typeof result.content === 'string') return decodeBase64Safe(result.content);
    if (typeof result.data === 'string') return decodeBase64Safe(result.data);
    return null;
  }

  async function downloadAttachmentHandler(ctx) {
    const user = requireUser(ctx);
    const getAttachment = requireImapMethod('getAttachment');
    const folder = folderOf(ctx, null);
    const messageId = safeId(ctx.params && ctx.params.id);
    const attachmentId = safeId(ctx.params && ctx.params.attachmentId);
    if (!messageId || !attachmentId) {
      throw fail('mail.invalid_input', '附件 ID 不合法', 400);
    }
    const record = assertOwnership(user, folder, messageId);
    const summary = record.owners[user.id].summary || {};
    const summaryAttachments = Array.isArray(summary.attachments) ? summary.attachments : [];
    const known = summaryAttachments.find((item) => item.id === attachmentId) || null;
    if (summaryAttachments.length > 0 && !known) {
      throw fail('mail.attachment_not_found', '附件不存在', 404);
    }

    let result;
    try {
      result = await getAttachment({
        user: adapterUser(user),
        folder,
        messageId,
        attachmentId
      });
    } catch (error) {
      log('error', `[mail] imap.getAttachment 失败: ${briefError(error)}`);
      throw fail('mail.imap_error', '邮箱服务暂时不可用，请稍后重试', 502);
    }
    const content = attachmentContent(result);
    if (!content) throw fail('mail.attachment_not_found', '附件不存在', 404);
    if (content.length > state.attachments.maxBytes) {
      throw fail('mail.attachment_too_large', '附件超过下载大小限制', 413);
    }

    const filename = safeFilename(
      (result && result.filename) || (known && known.filename) || 'attachment'
    );
    let contentType = safeContentType(
      (result && result.contentType) || (known && known.contentType) || 'application/octet-stream'
    );
    // 下载接口一律按附件处理；危险类型强制降为 octet-stream，避免浏览器内联执行。
    if (DANGEROUS_CONTENT_TYPES.test(contentType)) contentType = 'application/octet-stream';

    return {
      status: 200,
      body: {
        ok: true,
        filename,
        contentType,
        size: content.length,
        contentBase64: content.toString('base64'),
        disposition: 'attachment'
      }
    };
  }

  // ------------------------------ 生命周期 ------------------------------

  async function start(options = {}) {
    if (state.started) return { ok: true, alreadyStarted: true };
    const config = options && options.config && typeof options.config === 'object' && !Array.isArray(options.config)
      ? options.config
      : {};
    const logger = options && options.logger ? options.logger : {};

    state.config = config;
    state.logger = {
      info: typeof logger.info === 'function' ? logger.info.bind(logger) : () => {},
      warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : () => {},
      error: typeof logger.error === 'function' ? logger.error.bind(logger) : () => {}
    };

    // 可选测试注入：clock / codeGenerator 只用于确定性测试，不属于部署配置。
    const clockSource = typeof options.clock === 'function' ? options.clock : null;
    state.clock = clockSource
      ? () => {
        const value = Number(clockSource());
        return Number.isFinite(value) ? value : Date.now();
      }
      : () => Date.now();

    state.codeGenerator = typeof options.codeGenerator === 'function' ? options.codeGenerator : null;

    let dataFile = null;
    if (config.dataFile !== undefined && config.dataFile !== null) {
      if (typeof config.dataFile !== 'string' || config.dataFile.trim() === '') {
        throw fail('mail.config_invalid', 'config.dataFile 必须是非空字符串或 null', 500);
      }
      dataFile = config.dataFile;
    }
    try {
      state.store = new JsonStore({ filePath: dataFile });
    } catch (error) {
      log('error', `[mail] 数据文件初始化失败: ${briefError(error)}`);
      throw fail('mail.config_invalid', '邮件数据存储初始化失败', 500);
    }

    const transport = config.transport;
    if (transport && typeof transport.sendMail === 'function') {
      state.transport = transport;
    } else if (typeof transport === 'function') {
      state.transport = { sendMail: transport };
    } else if (transport && typeof transport === 'object' && !Array.isArray(transport) && transport.provider === 'smtp') {
      try {
        state.transport = createSmtpTransport(transport);
      } catch (error) {
        log('error', `[mail] SMTP 适配器配置无效: ${briefError(error)}`);
        throw fail(error.code || 'mail.config_invalid', 'SMTP 发信配置无效', 500);
      }
    } else {
      state.transport = null;
    }

    const imap = config.imap;
    if (imap && typeof imap === 'object' && !Array.isArray(imap) && typeof imap.listMessages === 'function') {
      state.imap = imap;
    } else if (imap && typeof imap === 'object' && !Array.isArray(imap) && imap.provider === 'imap') {
      try {
        // 凭据解析器只由部署代码注入；模块不持久化邮箱明文密码。
        state.imap = createImapInbox(imap, { credentialsFor: options.imapCredentialsFor });
      } catch (error) {
        log('error', `[mail] IMAP 适配器配置无效: ${briefError(error)}`);
        throw fail(error.code || 'mail.config_invalid', 'IMAP 收件配置无效', 500);
      }
    } else {
      state.imap = null;
    }
    state.from = normalizeFrom(config.from);
    state.userSendEnabled = config.userSendEnabled === true;

    const verification = config.verification && typeof config.verification === 'object'
      ? config.verification
      : {};
    state.verification = {
      windowMs: clampInt(verification.windowMs, VERIFICATION_DEFAULTS.windowMs, 1000, 86_400_000),
      maxPerWindow: clampInt(verification.maxPerWindow, VERIFICATION_DEFAULTS.maxPerWindow, 1, 100),
      ttlMs: clampInt(verification.ttlMs, VERIFICATION_DEFAULTS.ttlMs, 1000, 3_600_000),
      maxAttempts: clampInt(verification.maxAttempts, VERIFICATION_DEFAULTS.maxAttempts, 1, 20),
      public: verification.public === true
    };
    const attachments = config.attachments && typeof config.attachments === 'object'
      ? config.attachments
      : {};
    state.attachments = {
      maxBytes: clampInt(attachments.maxBytes, MAX_TOTAL_ATTACHMENT_BYTES, 1024, 50 * 1024 * 1024)
    };
    state.sendTimeoutMs = clampInt(config.sendTimeoutMs, 30_000, 1000, 120_000);
    state.pending = new Map();
    state.started = true;

    log(
      'info',
      `[mail] 已启动：storage=${state.store.filePath ? 'file' : 'memory'}, transport=${state.transport ? 'configured' : 'missing'}, imap=${state.imap ? 'configured' : 'missing'}, from=${state.from ? 'configured' : 'missing'}`
    );
    return { ok: true };
  }

  async function stop() {
    if (!state.started) return { ok: true, alreadyStopped: true };
    state.started = false;
    const pending = [...state.pending.values()].map((item) => item.promise);
    state.pending.clear();
    if (pending.length > 0) {
      let timer = null;
      const drainTimeout = new Promise((resolve) => {
        timer = setTimeout(resolve, 2000);
        if (typeof timer.unref === 'function') timer.unref();
      });
      await Promise.race([Promise.allSettled(pending).then(() => undefined), drainTimeout]);
      if (timer) clearTimeout(timer);
    }
    log('info', '[mail] 已停止（默认保留数据）');
    return { ok: true };
  }

  function health() {
    const transportConfigured = Boolean(state.transport && typeof state.transport.sendMail === 'function');
    const imapConfigured = Boolean(state.imap && typeof state.imap.listMessages === 'function');
    return {
      ok: state.started === true,
      reason: state.started ? null : 'stopped',
      transportConfigured,
      imapConfigured,
      transportProvider: state.transport ? (state.transport.provider || 'custom') : null,
      imapProvider: state.imap ? (state.imap.provider || 'custom') : null,
      fromConfigured: Boolean(state.from && state.from.address),
      userSendEnabled: state.userSendEnabled === true,
      storage: state.store && state.store.filePath ? 'file' : 'memory'
    };
  }

  // 供核心身份服务直接装配（与 HTTP 发信共享同一 transport/from，不经过用户发信开关）。
  async function sendVerification(input = {}) {
    if (!state.started) throw fail('mail.not_started', 'Mail 模块尚未启动', 503);
    const to = normalizeEmail(input.to);
    if (!to) throw fail('mail.invalid_input', '收件邮箱格式不正确', 400);
    const code = input.code === undefined || input.code === null ? '' : String(input.code).trim();
    if (!/^[0-9A-Za-z]{4,10}$/.test(code)) {
      throw fail('mail.invalid_input', '验证码格式不正确', 400);
    }
    requireTransport();
    const from = requireFrom();
    const ttlMinutes = verificationTtlMinutes();
    const purpose = safeHeader(input.purpose || 'verify', 40) || 'verify';
    const subject = safeHeader(input.subject || '【PagesAI】邮箱验证码', 200);
    await deliverSystemMail(from, {
      to: [to],
      subject,
      text: `您的验证码是 ${code}，${ttlMinutes} 分钟内有效。如非本人操作请忽略。`,
      html: `<p>您的验证码是 <strong>${escapeText(code)}</strong>，${ttlMinutes} 分钟内有效。</p><p>如非本人操作请忽略。</p>`,
      kind: 'verification',
      purpose
    });
    return { ok: true, status: 'accepted' };
  }

  function isAvailable() {
    return state.started === true;
  }

  function isConfigured() {
    return state.started === true
      && Boolean(state.transport && typeof state.transport.sendMail === 'function')
      && Boolean(state.from && state.from.address);
  }

  // 对 Glim 开放的能力实现（与 manifest.capabilities.tools 同名）。
  // 工具调用仍走同一套处理函数，因此权限、幂等、所有权与 HTML 净化完全一致。
  async function runTool(handler, ctx) {
    const result = await handler(ctx);
    if (result && Number.isInteger(result.status) && result.status >= 400) {
      throw new CoreError(
        (result.body && result.body.code) || 'mail.tool_failed',
        (result.body && result.body.message) || '邮件操作失败',
        { status: result.status }
      );
    }
    return result && result.body ? result.body : {};
  }

  const tools = {
    mail_list_messages(args = {}) {
      return runTool(listMessagesHandler, {
        user: args.user,
        query: { folder: args.folder, limit: args.limit, offset: args.offset }
      });
    },
    mail_read_message(args = {}) {
      return runTool(getMessageHandler, {
        user: args.user,
        params: { id: args.id !== undefined ? args.id : args.messageId },
        query: { folder: args.folder }
      });
    },
    mail_delete_message(args = {}) {
      return runTool(deleteMessageHandler, {
        user: args.user,
        params: { id: args.id !== undefined ? args.id : args.messageId },
        body: { folder: args.folder }
      });
    },
    mail_send(args = {}) {
      const body = {
        to: args.to,
        subject: args.subject,
        text: args.text,
        html: args.html,
        attachments: args.attachments,
        idempotencyKey: args.idempotencyKey
      };
      if (!body.idempotencyKey && typeof args.operationId === 'string' && args.operationId) {
        body.idempotencyKey = `tool_${args.operationId}`;
      }
      return runTool(sendHandler, { user: args.user, body });
    }
  };

  const routes = [
    { method: 'POST', path: '/api/mail/send', handler: handle(sendHandler) },
    { method: 'POST', path: '/api/mail/verification', handler: handle(verificationHandler) },
    { method: 'POST', path: '/api/mail/verification/verify', handler: handle(verificationVerifyHandler) },
    { method: 'GET', path: '/api/mail/messages', handler: handle(listMessagesHandler) },
    { method: 'DELETE', path: '/api/mail/messages', handler: handle(deleteMessagesHandler) },
    { method: 'GET', path: '/api/mail/messages/:id', handler: handle(getMessageHandler) },
    { method: 'DELETE', path: '/api/mail/messages/:id', handler: handle(deleteMessageHandler) },
    {
      method: 'GET',
      path: '/api/mail/messages/:id/attachments/:attachmentId',
      handler: handle(downloadAttachmentHandler)
    }
  ];

  const instance = {
    start,
    stop,
    health,
    routes,
    tools
  };
  // 可选集成面：核心身份服务可把本对象直接作为 mail 适配器。
  // 设为不可枚举，保证模块主接口仍严格是 start/stop/health/routes/tools。
  Object.defineProperties(instance, {
    sendVerification: { value: sendVerification, enumerable: false },
    isAvailable: { value: isAvailable, enumerable: false },
    isConfigured: { value: isConfigured, enumerable: false }
  });
  return instance;
}

const mailModule = createMailModule();
module.exports = mailModule;
Object.defineProperty(module.exports, 'createMailModule', { value: createMailModule });
Object.defineProperty(module.exports, 'ROUTE_PREFIX', { value: ROUTE_PREFIX });
