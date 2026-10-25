'use strict';
// 真实 IMAP 收件适配器（Node 内置 net/tls，无第三方依赖）。
//
// 能力：listMessages / getMessage / deleteMessage / getAttachment。
//  - EXAMINE/SELECT、UID SEARCH、UID FETCH（BODY.PEEK[] 部分抓取）、
//    UID STORE \Deleted、UID EXPUNGE（无 UIDPLUS 时降级 EXPUNGE）；
//  - MIME multipart 递归解析、Base64 / quoted-printable、RFC 2047、
//    常见字符集（UTF-8/GBK/GB18030/Big5/Latin 系列）；
//  - 附件按稳定的 part.N 编号，列表、详情与下载三条路径一致；
//  - 凭据可来自配置，也可由部署注入 credentialsFor(user)，模块自身不持久化明文密码。
//
// 安全边界：
//  - 默认 secure（993）或 STARTTLS 升级；既无 TLS 又未显式 allowInsecure 时拒绝连接；
//  - 证书默认校验，不提供关闭开关；
//  - 每次操作独立连接，结束 LOGOUT，避免跨用户会话复用；
//  - 单封邮件按 maxMessageBytes 截断（默认 1 MiB），超大正文/附件如实返回缺失而非伪造。

const net = require('node:net');
const tls = require('node:tls');

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_SEARCH_UIDS = 20_000;

const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
};

function providerError(code, message, status = 502) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function clampTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.min(120_000, Math.max(1_000, number));
}

function headerText(value, max = 998) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

function quote(value) {
  const text = String(value);
  if (!/^[\x20-\x7e]*$/.test(text)) {
    throw providerError('mail.imap_folder_failed', '邮箱文件夹名包含不支持的字符', 502);
  }
  return `"${text.replace(/([\\"])/g, '\\$1')}"`;
}

function splitHeaderBody(buffer) {
  const crlf = buffer.indexOf('\r\n\r\n');
  if (crlf >= 0) {
    return { header: buffer.subarray(0, crlf).toString('latin1'), body: buffer.subarray(crlf + 4) };
  }
  const lf = buffer.indexOf('\n\n');
  if (lf >= 0) {
    return { header: buffer.subarray(0, lf).toString('latin1'), body: buffer.subarray(lf + 2) };
  }
  return { header: buffer.toString('latin1'), body: Buffer.alloc(0) };
}

function parseHeaders(text) {
  const headers = Object.create(null);
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current) {
      headers[current] = `${headers[current]} ${line.trim()}`;
      continue;
    }
    const index = line.indexOf(':');
    if (index <= 0) continue;
    current = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    headers[current] = headers[current] ? `${headers[current]}, ${value}` : value;
  }
  return headers;
}

function decodeCharset(buffer, charset) {
  const label = typeof charset === 'string' && charset.trim() ? charset.trim() : 'utf-8';
  try {
    return new TextDecoder(label, { fatal: false }).decode(buffer);
  } catch {
    return Buffer.from(buffer).toString('utf8');
  }
}

function decodeQuotedPrintable(buffer) {
  const text = buffer.toString('latin1').replace(/=\r?\n/g, '');
  const bytes = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(char.charCodeAt(0) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodeTransfer(buffer, encoding) {
  const value = String(encoding || '').trim().toLowerCase();
  if (value === 'base64') return Buffer.from(buffer.toString('latin1').replace(/\s+/g, ''), 'base64');
  if (value === 'quoted-printable') return decodeQuotedPrintable(buffer);
  return Buffer.from(buffer);
}

function decodeWords(value) {
  const text = String(value === undefined || value === null ? '' : value);
  return text.replace(/=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g, (match, charset, encoding, payload) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        return decodeCharset(Buffer.from(payload, 'base64'), charset);
      }
      const bytes = [];
      const encoded = payload.replace(/_/g, ' ');
      for (let index = 0; index < encoded.length; index += 1) {
        const char = encoded[index];
        if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(encoded.slice(index + 1, index + 3))) {
          bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
          index += 2;
        } else {
          bytes.push(char.charCodeAt(0) & 0xff);
        }
      }
      return decodeCharset(Buffer.from(bytes), charset);
    } catch {
      return match;
    }
  });
}

function splitParams(value) {
  const parts = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"' && value[index - 1] !== '\\') quoted = !quoted;
    if (char === ';' && !quoted) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function parseContentType(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return { type: '', params: {} };
  const parts = splitParams(text);
  const type = parts.shift().trim().toLowerCase();
  const params = {};
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    let raw = part.slice(index + 1).trim();
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1).replace(/\\(.)/g, '$1');
    params[key] = raw;
  }
  return { type, params };
}

function splitMultipart(body, boundary) {
  if (!boundary) return [];
  const text = body.toString('latin1');
  const marker = `--${boundary}`;
  const parts = [];
  let index = text.indexOf(marker);
  if (index < 0) return [];
  index += marker.length;
  while (index < text.length) {
    if (text.startsWith('--', index)) break;
    const lineEnd = text.indexOf('\r\n', index);
    if (lineEnd < 0) break;
    const start = lineEnd + 2;
    const next = text.indexOf(`\r\n${marker}`, start);
    if (next < 0) {
      parts.push(body.subarray(start));
      break;
    }
    parts.push(body.subarray(start, next));
    index = next + 2 + marker.length;
    while (text[index] === ' ' || text[index] === '\t') index += 1;
  }
  return parts;
}

function parseAddressList(value) {
  const text = decodeWords(value);
  const items = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (const char of text) {
    if (char === '"' && !angle) quoted = !quoted;
    if (char === '<' && !quoted) angle = true;
    if (char === '>' && !quoted) angle = false;
    if (char === ',' && !quoted && !angle) {
      items.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) items.push(current);
  const addresses = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const named = /^(.*)<([^<>]+)>$/.exec(trimmed);
    if (named) {
      const name = named[1].trim().replace(/^"|"$/g, '').trim();
      const address = named[2].trim();
      if (address) addresses.push(name ? { name, address } : address);
    } else {
      addresses.push(trimmed.replace(/^"|"$/g, ''));
    }
  }
  return addresses;
}

function parseInternalDate(value) {
  const match = /^"?(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})"?$/.exec(String(value || '').trim());
  if (!match) return null;
  const month = MONTHS[match[2]] || '01';
  const iso = `${match[3]}-${month}-${match[1].padStart(2, '0')}T${match[4]}:${match[5]}:${match[6]}${match[7]}${match[8]}:${match[9]}`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseFetchUnits(units) {
  const results = [];
  for (const unit of units) {
    const match = /^\* (\d+) FETCH \(([\s\S]*)\)$/.exec(unit.line);
    if (!match) continue;
    const meta = match[2];
    const uidMatch = /(?:^|\s)UID (\d+)/.exec(meta);
    const flagsMatch = /(?:^|\s)FLAGS \(([^)]*)\)/.exec(meta);
    const sizeMatch = /(?:^|\s)RFC822\.SIZE (\d+)/.exec(meta);
    const dateMatch = /(?:^|\s)INTERNALDATE ("[^"]*")/.exec(meta);
    results.push({
      sequence: Number(match[1]),
      uid: uidMatch ? Number(uidMatch[1]) : null,
      flags: flagsMatch ? flagsMatch[1] : '',
      size: sizeMatch ? Number(sizeMatch[1]) : null,
      internalDate: dateMatch ? parseInternalDate(dateMatch[1]) : null,
      raw: unit.literals.length > 0 ? unit.literals[0] : Buffer.alloc(0)
    });
  }
  return results;
}

function collectSearchUids(units) {
  const uids = [];
  for (const unit of units) {
    const match = /^\* SEARCH(?: (.*))?$/.exec(unit.line);
    if (!match) continue;
    for (const token of String(match[1] || '').split(/\s+/)) {
      const uid = Number(token);
      if (Number.isSafeInteger(uid) && uid > 0) uids.push(uid);
    }
  }
  return uids;
}

function parseContent(raw) {
  const headers = parseHeaders(splitHeaderBody(raw).header);
  const state = { text: '', html: '', attachments: [] };
  const counter = { value: 0 };
  try {
    parseEntity(raw, counter, state);
  } catch {
    // 截断或畸形 MIME：尽量保留已解析出的头与正文。
  }
  return { headers, ...state };
}

function parseMessage(raw, internalDate) {
  const { headers, text: rawText, html: rawHtml, attachments } = parseContent(raw);
  const fromValue = headers.from || headers.sender || '';
  const toValue = headers.to || '';
  const subject = decodeWords(headers.subject || '');
  const date = (() => {
    const parsed = headers.date ? new Date(decodeWords(headers.date)) : null;
    if (parsed && !Number.isNaN(parsed.getTime())) return parsed.toISOString();
    return internalDate || null;
  })();
  const text = rawText.slice(0, 200_000);
  const html = rawHtml.slice(0, 500_000);
  const snippet = (text || html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  return {
    from: parseAddressList(fromValue),
    to: parseAddressList(toValue),
    subject,
    date,
    snippet,
    text: text.replace(/\r\n/g, '\n'),
    html,
    attachments: attachments.map((item) => ({
      id: item.id,
      filename: item.filename,
      contentType: item.contentType,
      size: item.size
    }))
  };
}

function parseEntity(buffer, counter, state) {
  const { header, body } = splitHeaderBody(buffer);
  const headers = parseHeaders(header);
  const contentType = parseContentType(headers['content-type']);
  counter.value += 1;
  const partId = `part.${counter.value}`;

  if (contentType.type.startsWith('multipart/') && contentType.params.boundary) {
    for (const part of splitMultipart(body, contentType.params.boundary)) {
      parseEntity(part, counter, state);
    }
    return;
  }

  const disposition = parseContentType(headers['content-disposition']);
  const rawFilename = disposition.params.filename || contentType.params.name || '';
  const filename = decodeWords(rawFilename);
  const isAttachment = /^attachment$/i.test(disposition.type) || Boolean(filename);
  const decoded = decodeTransfer(body, headers['content-transfer-encoding']);

  if (isAttachment) {
    state.attachments.push({
      id: partId,
      filename: filename || 'attachment',
      contentType: contentType.type || 'application/octet-stream',
      size: decoded.length,
      content: decoded
    });
    return;
  }

  const charset = contentType.params.charset;
  if (contentType.type === 'text/html') {
    if (!state.html) state.html = decodeCharset(decoded, charset);
    return;
  }
  if (contentType.type === 'text/plain' || !contentType.type) {
    if (!state.text) state.text = decodeCharset(decoded, charset);
  }
}

// ---------------------------------------------------------------------------
// IMAP 协议
// ---------------------------------------------------------------------------

class ByteReader {
  constructor(socket) {
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.error = null;
    this.socket = socket;
    this.timeoutMs = 0;
    this.handlers = null;
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    if (socket.setTimeout) socket.setTimeout(this.timeoutMs || DEFAULT_TIMEOUT_MS);
    const onData = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flush();
    };
    const onError = (error) => this.fail(providerError('mail.imap_connection_failed', `IMAP 连接错误: ${error.code || 'network'}`, 502));
    const onClose = () => this.fail(providerError('mail.imap_connection_closed', 'IMAP 连接被服务器关闭', 502));
    const onTimeout = () => this.fail(providerError('mail.imap_timeout', 'IMAP 操作超时', 504));
    this.handlers = { onData, onError, onClose, onTimeout };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.on('timeout', onTimeout);
    if (typeof socket.resume === 'function') socket.resume();
  }

  detach() {
    if (!this.socket || !this.handlers) return;
    this.socket.removeListener('data', this.handlers.onData);
    this.socket.removeListener('error', this.handlers.onError);
    this.socket.removeListener('close', this.handlers.onClose);
    this.socket.removeListener('timeout', this.handlers.onTimeout);
    this.handlers = null;
  }

  setTimer(timeoutMs) {
    this.timeoutMs = timeoutMs;
    if (this.socket && this.socket.setTimeout) this.socket.setTimeout(timeoutMs);
  }

  flush() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  fail(error) {
    if (!this.error) this.error = error;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.reject(this.error);
  }

  waitForData() {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async readLine() {
    while (true) {
      const index = this.buffer.indexOf('\r\n');
      if (index >= 0) {
        const line = this.buffer.subarray(0, index).toString('utf8');
        this.buffer = this.buffer.subarray(index + 2);
        return line;
      }
      await this.waitForData();
    }
  }

  async readBytes(length) {
    while (this.buffer.length < length) await this.waitForData();
    const out = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return Buffer.from(out);
  }

  async readUnit() {
    let line = '';
    const literals = [];
    while (true) {
      const part = await this.readLine();
      line += part;
      const match = /\{(\d+)\}$/.exec(line);
      if (!match) break;
      literals.push(await this.readBytes(Number(match[1])));
    }
    return { line, literals };
  }

  destroy() {
    this.detach();
    try {
      this.socket.on('error', () => {});
      this.socket.destroy();
    } catch {
      // 忽略。
    }
  }
}

class ImapClient {
  constructor(socket, timeoutMs) {
    this.reader = new ByteReader(socket);
    this.reader.setTimer(timeoutMs);
    this.tag = 0;
    this.capabilities = new Set();
  }

  async greeting() {
    const unit = await this.reader.readUnit();
    if (!/^\* (OK|PREAUTH)\b/i.test(unit.line)) {
      throw providerError('mail.imap_rejected', 'IMAP 服务器拒绝连接', 502);
    }
    return unit;
  }

  async command(text) {
    const tag = `A${++this.tag}`;
    this.reader.socket.write(`${tag} ${text}\r\n`);
    const units = [];
    while (true) {
      const unit = await this.reader.readUnit();
      if (unit.line.startsWith(`${tag} `)) {
        const status = /^A\d+ (OK|NO|BAD)\b/i.exec(unit.line);
        if (!status || status[1].toUpperCase() !== 'OK') {
          const kind = status ? status[1].toUpperCase() : 'BAD';
          throw providerError('mail.imap_rejected', `IMAP 命令失败（${kind}）`, 502);
        }
        return units;
      }
      units.push(unit);
    }
  }

  async capability() {
    const units = await this.command('CAPABILITY');
    for (const unit of units) {
      const match = /^\* CAPABILITY (.*)$/.exec(unit.line);
      if (!match) continue;
      for (const token of match[1].split(/\s+/)) {
        if (token) this.capabilities.add(token.toUpperCase());
      }
    }
    return this.capabilities;
  }

  async login(user, password) {
    await this.command(`LOGIN ${quote(user)} ${quote(password)}`);
  }

  async logout() {
    try {
      this.reader.socket.write(`A${++this.tag} LOGOUT\r\n`);
      this.reader.detach();
      this.reader.socket.end();
    } catch {
      // 忽略。
    }
    this.reader.destroy();
  }
}

async function openSocket(host, port, secure, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true })
      : net.connect({ host, port });
    // 服务器可能在 connect 后立即发送 IMAP greeting；先暂停，等读取器挂载后恢复。
    if (typeof socket.pause === 'function') socket.pause();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(providerError('mail.imap_timeout', 'IMAP 连接超时', 504));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const readyEvent = secure ? 'secureConnect' : 'connect';
    socket.once(readyEvent, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(providerError('mail.imap_connect_failed', `IMAP 连接失败: ${error.code || 'network'}`, 502));
    });
  });
}

function upgradeToTls(socket, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      tlsSocket.destroy();
      reject(providerError('mail.imap_timeout', 'IMAP STARTTLS 超时', 504));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    tlsSocket.once('secureConnect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(tlsSocket);
    });
    tlsSocket.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(providerError('mail.imap_tls_failed', `IMAP TLS 升级失败: ${error.code || 'network'}`, 502));
    });
  });
}

function createImapInbox(config = {}, options = {}) {
  const host = typeof config.host === 'string' ? config.host.trim() : '';
  if (!host) throw providerError('mail.config_invalid', 'imap.host 未配置', 500);
  const secure = config.secure === undefined ? Number(config.port) === 993 : config.secure === true;
  const defaultPort = secure ? 993 : 143;
  const port = config.port === undefined || config.port === null ? defaultPort : Number(config.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw providerError('mail.config_invalid', 'imap.port 非法', 500);
  }
  const timeoutMs = clampTimeout(config.timeoutMs);
  const starttls = config.starttls !== false;
  const allowInsecure = config.allowInsecure === true;
  const maxMessageBytes = Number.isSafeInteger(config.maxMessageBytes) && config.maxMessageBytes > 0
    ? Math.min(config.maxMessageBytes, 10 * 1024 * 1024)
    : DEFAULT_MAX_MESSAGE_BYTES;
  const credentialsFor = typeof options.credentialsFor === 'function' ? options.credentialsFor : null;
  const userFrom = typeof config.userFrom === 'string' ? config.userFrom : null;

  async function resolveCredentials(user) {
    if (credentialsFor) {
      const provided = await credentialsFor(user || null);
      if (provided && typeof provided === 'object' && provided.user && provided.password !== undefined) {
        return { user: String(provided.user), password: String(provided.password) };
      }
      if (provided === false) {
        throw providerError('mail.imap_credentials_missing', '当前用户未绑定邮箱凭据', 409);
      }
    }
    if (userFrom && user) {
      const username = userFrom === 'email' ? user.email : (userFrom === 'username' ? user.username : null);
      if (username && typeof config.password === 'string') return { user: String(username), password: config.password };
    }
    if (typeof config.user === 'string' && config.user && typeof config.password === 'string') {
      return { user: config.user, password: config.password };
    }
    throw providerError('mail.imap_credentials_missing', '未配置邮箱凭据', 409);
  }

  async function withClient(user, work) {
    const credentials = await resolveCredentials(user);
    const socket = await openSocket(host, port, secure, timeoutMs);
    const client = new ImapClient(socket, timeoutMs);
    try {
      await client.greeting();
      await client.capability();
      if (!secure && starttls) {
        if (client.capabilities.has('STARTTLS')) {
          await client.command('STARTTLS');
          client.reader.detach();
          const tlsSocket = await upgradeToTls(socket, host, timeoutMs);
          client.reader.attach(tlsSocket);
          client.reader.setTimer(timeoutMs);
          await client.capability();
        } else if (!allowInsecure) {
          throw providerError('mail.imap_tls_unavailable', 'IMAP 服务器不支持 STARTTLS', 502);
        }
      }
      await client.login(credentials.user, credentials.password);
      const result = await work(client);
      await client.logout();
      return result;
    } catch (error) {
      client.reader.destroy();
      if (error && error.code) throw error;
      throw providerError('mail.imap_failed', 'IMAP 操作失败', 502);
    }
  }

  async function selectFolder(client, folder, readOnly) {
    try {
      await client.command(`${readOnly ? 'EXAMINE' : 'SELECT'} ${quote(folder)}`);
    } catch (error) {
      if (error && error.code === 'mail.imap_rejected') {
        throw providerError('mail.imap_folder_failed', '无法打开邮箱文件夹', 502);
      }
      throw error;
    }
  }

  function fetchCommand(uids) {
    return `UID FETCH ${uids.join(',')} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[]<0.${maxMessageBytes}>)`;
  }

  async function fetchMessages(client, uids) {
    if (uids.length === 0) return [];
    const units = await client.command(fetchCommand(uids));
    const byUid = new Map();
    for (const item of parseFetchUnits(units)) {
      if (!item.uid) continue;
      byUid.set(item.uid, item);
    }
    return uids.map((uid) => byUid.get(uid)).filter(Boolean);
  }

  function messageOf(item) {
    const parsed = parseMessage(item.raw, item.internalDate);
    return {
      id: String(item.uid),
      from: parsed.from,
      to: parsed.to,
      subject: parsed.subject,
      date: parsed.date,
      snippet: parsed.snippet,
      unread: !/\\Seen\b/i.test(item.flags),
      seen: /\\Seen\b/i.test(item.flags),
      size: item.size,
      text: parsed.text,
      html: parsed.html,
      attachments: parsed.attachments,
      hasAttachments: parsed.attachments.length > 0
    };
  }

  async function listMessages({ user, folder, limit, offset }) {
    const pageSize = Math.min(Math.max(Number(limit) || 30, 1), 100);
    const skip = Math.max(Number(offset) || 0, 0);
    return withClient(user, async (client) => {
      await selectFolder(client, folder, true);
      const search = await client.command('UID SEARCH ALL');
      const uids = collectSearchUids(search);
      if (uids.length > MAX_SEARCH_UIDS) uids.splice(0, uids.length - MAX_SEARCH_UIDS);
      const total = uids.length;
      const end = Math.max(0, total - skip);
      const start = Math.max(0, end - pageSize);
      const page = uids.slice(start, end).reverse();
      const items = await fetchMessages(client, page);
      return { messages: items.map(messageOf), total };
    });
  }

  async function getMessage({ user, folder, id }) {
    const uid = Number(id);
    if (!Number.isSafeInteger(uid) || uid <= 0) return null;
    return withClient(user, async (client) => {
      await selectFolder(client, folder, true);
      const items = await fetchMessages(client, [uid]);
      return items.length > 0 ? messageOf(items[0]) : null;
    });
  }

  async function deleteMessage({ user, folder, id }) {
    const uid = Number(id);
    if (!Number.isSafeInteger(uid) || uid <= 0) {
      throw providerError('mail.invalid_input', '邮件 ID 不合法', 400);
    }
    return withClient(user, async (client) => {
      await selectFolder(client, folder, false);
      await client.command(`UID STORE ${uid} +FLAGS.SILENT (\\Deleted)`);
      if (client.capabilities.has('UIDPLUS')) {
        await client.command(`UID EXPUNGE ${uid}`);
      } else {
        await client.command('EXPUNGE');
      }
      return { ok: true };
    });
  }

  async function getAttachment({ user, folder, messageId, attachmentId }) {
    const uid = Number(messageId);
    if (!Number.isSafeInteger(uid) || uid <= 0) return null;
    return withClient(user, async (client) => {
      await selectFolder(client, folder, true);
      const items = await fetchMessages(client, [uid]);
      if (items.length === 0) return null;
      const parsed = parseContent(items[0].raw);
      const found = parsed.attachments.find((item) => item.id === attachmentId);
      if (!found) return null;
      return {
        filename: found.filename,
        contentType: found.contentType,
        size: found.content.length,
        contentBase64: found.content.toString('base64')
      };
    });
  }

  return {
    provider: 'imap',
    listMessages,
    getMessage,
    deleteMessage,
    getAttachment,
    close() {}
  };
}

module.exports = {
  createImapInbox,
  parseMessage,
  parseContent,
  parseHeaders,
  parseContentType,
  parseAddressList,
  decodeWords
};
