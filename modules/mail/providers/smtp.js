'use strict';
// 真实 SMTP 发信适配器（Node 内置 net/tls，无第三方依赖）。
//
// 支持：
//  - 直连 TLS（secure: true，常见 465）或明文连接后 STARTTLS（常见 587）；
//  - AUTH PLAIN / AUTH LOGIN（仅在提供了 user/password 时认证）；
//  - 纯文本、HTML、multipart/alternative、带 Base64 附件的 multipart/mixed；
//  - RFC 2047 头编码、Message-ID、Date、CRLF 与 dot-stuffing；
//  - 超时、错误码与接收人逐个结果。
//
// 安全边界：
//  - 默认校验证书；不提供关闭校验的开关，隔离测试请使用明文假服务器并显式 starttls:false；
//  - 错误信息只包含阶段名与服务器响应码，不包含凭据；
//  - 每次发信独立连接，发完 QUIT；不复用连接，避免跨用户状态泄漏。

const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

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

function isAscii(text) {
  return /^[\x20-\x7e]*$/.test(text);
}

/** RFC 2047 encoded-word；纯 ASCII 原样返回。 */
function encodeWord(value) {
  const text = headerText(value);
  if (isAscii(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function encodeDisplayName(value) {
  const text = headerText(value, 120);
  if (!text) return '';
  if (!isAscii(text)) return encodeWord(text);
  return /[()<>\[\]:;@\\,."]/.test(text) ? `"${text.replace(/([\\"])/g, '\\$1')}"` : text;
}

function encodeFilename(name) {
  const text = headerText(name, 180) || 'attachment';
  if (isAscii(text)) return { plain: text.replace(/["\\]/g, '_'), extended: null };
  const fallback = text.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'attachment';
  return { plain: fallback, extended: encodeURIComponent(text) };
}

function formatAddress(from) {
  const address = headerText(from && from.address, 320);
  const name = from && from.name ? encodeDisplayName(from.name) : '';
  return name ? `${name} <${address}>` : `<${address}>`;
}

function toCrlf(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\r\n|\r|\n/g, '\r\n');
}

function base64Lines(buffer) {
  const encoded = Buffer.from(buffer).toString('base64');
  const lines = [];
  for (let index = 0; index < encoded.length; index += 76) lines.push(encoded.slice(index, index + 76));
  return lines.join('\r\n');
}

function uniqueBoundary(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function textPart(contentType, content) {
  return [
    `Content-Type: ${contentType}; charset=utf-8`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(toCrlf(content), 'utf8'))
  ].join('\r\n');
}

function attachmentPart(attachment) {
  const filename = encodeFilename(attachment.filename);
  const contentType = headerText(attachment.contentType, 200) || 'application/octet-stream';
  const disposition = filename.extended
    ? `attachment; filename="${filename.plain}"; filename*=UTF-8''${filename.extended}`
    : `attachment; filename="${filename.plain}"`;
  return [
    `Content-Type: ${contentType}; name="${filename.plain}"`,
    `Content-Disposition: ${disposition}`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(attachment.content)
  ].join('\r\n');
}

/**
 * 构建完整 MIME 报文（不含结尾 .）。
 * @param {object} message { from, to, subject, text, html, attachments, messageId, date }
 */
function buildMime(message) {
  const to = Array.isArray(message.to) ? message.to : [];
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const html = typeof message.html === 'string' ? message.html : '';
  const text = typeof message.text === 'string' ? message.text : '';

  let bodyType;
  let body;
  if (text && html) {
    const boundary = uniqueBoundary('alt');
    bodyType = `multipart/alternative; boundary="${boundary}"`;
    body = [
      `--${boundary}`,
      textPart('text/plain', text),
      `--${boundary}`,
      textPart('text/html', html),
      `--${boundary}--`
    ].join('\r\n');
  } else if (html) {
    bodyType = 'text/html; charset=utf-8';
    body = ['Content-Transfer-Encoding: base64', '', base64Lines(Buffer.from(toCrlf(html), 'utf8'))].join('\r\n');
  } else {
    bodyType = 'text/plain; charset=utf-8';
    body = ['Content-Transfer-Encoding: base64', '', base64Lines(Buffer.from(toCrlf(text), 'utf8'))].join('\r\n');
  }

  let contentType = bodyType;
  if (attachments.length > 0) {
    const boundary = uniqueBoundary('mix');
    const parts = [
      `--${boundary}`,
      `Content-Type: ${bodyType}`,
      '',
      body
    ];
    for (const attachment of attachments) {
      parts.push(`--${boundary}`, attachmentPart(attachment));
    }
    parts.push(`--${boundary}--`);
    contentType = `multipart/mixed; boundary="${boundary}"`;
    body = parts.join('\r\n');
  }

  const headers = [
    `From: ${formatAddress(message.from)}`,
    `To: ${to.map((address) => headerText(address, 320)).join(', ')}`,
    `Subject: ${encodeWord(message.subject || '(无主题)')}`,
    `Date: ${(message.date instanceof Date ? message.date : new Date()).toUTCString()}`,
    `Message-ID: ${headerText(message.messageId, 998)}`,
    'MIME-Version: 1.0',
    `Content-Type: ${contentType}`
  ];
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
}

class SmtpSession {
  constructor(socket, timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.buffer = '';
    this.queue = [];
    this.waiters = [];
    this.current = null;
    this.error = null;
    this.closed = false;
    this.handlers = null;
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    if (socket.setTimeout) socket.setTimeout(this.timeoutMs);
    const onData = (chunk) => this.onData(chunk);
    const onError = (error) => this.fail(error);
    const onClose = () => {
      if (!this.closed) this.fail(providerError('mail.smtp_connection_closed', 'SMTP 连接被服务器关闭', 502));
    };
    const onTimeout = () => this.fail(providerError('mail.smtp_timeout', 'SMTP 操作超时', 504));
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

  onData(chunk) {
    this.buffer += chunk.toString('latin1');
    while (true) {
      const index = this.buffer.indexOf('\r\n');
      if (index < 0) break;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      if (!this.current) this.current = { code: null, lines: [] };
      if (line.length > 0) this.current.lines.push(line);
      const match = /^(\d{3})([ -]|$)/.exec(line);
      if (!match) continue;
      if (this.current.code === null) this.current.code = Number(match[1]);
      if (match[2] !== '-') {
        this.queue.push({ code: this.current.code, lines: this.current.lines.slice(), text: this.current.lines.join('\n') });
        this.current = null;
        this.flush();
      }
    }
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

  read() {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve: () => {
        if (this.queue.length === 0) return reject(this.error || providerError('mail.smtp_protocol_error', 'SMTP 响应为空', 502));
        resolve(this.queue.shift());
      }, reject });
    });
  }

  async cmd(line) {
    if (this.error) throw this.error;
    this.socket.write(`${line}\r\n`);
    return this.read();
  }

  async expect(codes, stage) {
    const response = await this.read();
    if (!codes.includes(response.code)) {
      throw providerError('mail.smtp_rejected', `SMTP ${stage} 失败（${response.code}）`, 502);
    }
    return response;
  }

  async quit() {
    this.closed = true;
    try {
      this.socket.write('QUIT\r\n');
      this.detach();
      this.socket.end();
    } catch {
      // 连接已断开时忽略。
    }
    this.destroy();
  }

  destroy() {
    this.closed = true;
    this.detach();
    try {
      this.socket.on('error', () => {});
      this.socket.destroy();
    } catch {
      // 忽略销毁失败。
    }
  }
}

function openSocket(host, port, secure, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true })
      : net.connect({ host, port });
    // 服务器可能在 connect 事件后立即发送 greeting；先暂停，等会话挂上 data 监听再恢复。
    if (typeof socket.pause === 'function') socket.pause();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(providerError('mail.smtp_timeout', 'SMTP 连接超时', 504));
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
      reject(providerError('mail.smtp_connect_failed', `SMTP 连接失败: ${error.code || 'network'}`, 502));
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
      reject(providerError('mail.smtp_timeout', 'SMTP STARTTLS 超时', 504));
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
      reject(providerError('mail.smtp_tls_failed', `SMTP TLS 升级失败: ${error.code || 'network'}`, 502));
    });
  });
}

function parseCapabilities(response) {
  const capabilities = new Map();
  for (const line of response.lines.slice(1)) {
    const text = line.replace(/^\d{3}[ -]/, '').trim();
    if (!text) continue;
    const [name, ...rest] = text.split(/\s+/);
    capabilities.set(name.toUpperCase(), rest.join(' ').toUpperCase());
  }
  return capabilities;
}

function chooseAuth(capabilities) {
  const raw = capabilities.get('AUTH') || '';
  const mechanisms = new Set(raw.split(/\s+/).filter(Boolean));
  if (mechanisms.has('PLAIN')) return 'PLAIN';
  if (mechanisms.has('LOGIN')) return 'LOGIN';
  return null;
}

function dotStuff(message) {
  return message.replace(/(^|\r\n)\./g, '$1..');
}

function createSmtpTransport(config = {}) {
  const host = typeof config.host === 'string' ? config.host.trim() : '';
  if (!host) throw providerError('mail.config_invalid', 'transport.host 未配置', 500);
  const secure = config.secure === true;
  const defaultPort = secure ? 465 : 587;
  const port = config.port === undefined || config.port === null ? defaultPort : Number(config.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw providerError('mail.config_invalid', 'transport.port 非法', 500);
  }
  const timeoutMs = clampTimeout(config.timeoutMs);
  const heloName = headerText(config.heloName || 'localhost', 255) || 'localhost';
  const user = typeof config.user === 'string' ? config.user : '';
  const password = typeof config.password === 'string' ? config.password : '';
  const starttls = config.starttls !== false;
  const requireTls = config.requireTls === true;
  const maxMessageBytes = Number.isSafeInteger(config.maxMessageBytes) && config.maxMessageBytes > 0
    ? Math.min(config.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES)
    : DEFAULT_MAX_MESSAGE_BYTES;

  async function sendMail(message) {
    if (!message || typeof message !== 'object') throw providerError('mail.invalid_input', '发信参数缺失', 400);
    const from = message.from && message.from.address ? message.from : null;
    if (!from) throw providerError('mail.invalid_input', '发信人身份缺失', 400);
    const to = Array.isArray(message.to) ? message.to.filter((item) => typeof item === 'string' && item) : [];
    if (to.length === 0) throw providerError('mail.invalid_input', '收件人缺失', 400);

    const messageId = message.messageId || `<${crypto.randomUUID()}@${host}>`;
    const mime = buildMime({
      from,
      to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      attachments: message.attachments,
      messageId,
      date: new Date()
    });
    const payload = Buffer.from(mime, 'utf8');
    if (payload.length > maxMessageBytes) {
      throw providerError('mail.message_too_large', '邮件超过大小限制', 413);
    }

    const socket = await openSocket(host, port, secure, timeoutMs);
    const session = new SmtpSession(socket, timeoutMs);
    try {
      await session.expect([220], 'greeting');
      let ehlo = await session.cmd(`EHLO ${heloName}`);
      if (ehlo.code !== 250) throw providerError('mail.smtp_rejected', `SMTP EHLO 失败（${ehlo.code}）`, 502);

      let capabilities = parseCapabilities(ehlo);
      if (!secure) {
        if (capabilities.has('STARTTLS') && starttls) {
          await session.expect([220], 'STARTTLS');
          session.detach();
          const tlsSocket = await upgradeToTls(socket, host, timeoutMs);
          session.attach(tlsSocket);
          ehlo = await session.cmd(`EHLO ${heloName}`);
          if (ehlo.code !== 250) throw providerError('mail.smtp_rejected', `SMTP EHLO(TLS) 失败（${ehlo.code}）`, 502);
          capabilities = parseCapabilities(ehlo);
        } else if (requireTls) {
          throw providerError('mail.smtp_tls_unavailable', 'SMTP 服务器不支持 STARTTLS', 502);
        }
      }

      if (user || password) {
        const mechanism = chooseAuth(capabilities);
        if (!mechanism) {
          throw providerError('mail.smtp_auth_unavailable', 'SMTP 服务器未提供可用的认证方式', 502);
        }
        if (mechanism === 'PLAIN') {
          const token = Buffer.from(`\u0000${user}\u0000${password}`, 'utf8').toString('base64');
          const response = await session.cmd(`AUTH PLAIN ${token}`);
          if (response.code !== 235) {
            throw providerError('mail.smtp_auth_failed', `SMTP 认证失败（${response.code}）`, 502);
          }
        } else {
          const step1 = await session.cmd('AUTH LOGIN');
          if (step1.code !== 334) throw providerError('mail.smtp_auth_failed', `SMTP AUTH LOGIN 失败（${step1.code}）`, 502);
          const step2 = await session.cmd(Buffer.from(user, 'utf8').toString('base64'));
          if (step2.code !== 334) throw providerError('mail.smtp_auth_failed', `SMTP 用户名认证失败（${step2.code}）`, 502);
          await session.expect([235], 'AUTH LOGIN 密码');
        }
      }

      const fromLine = await session.cmd(`MAIL FROM:<${headerText(from.address, 320)}> SIZE=${payload.length}`);
      if (fromLine.code !== 250) {
        throw providerError('mail.smtp_rejected', `SMTP MAIL FROM 失败（${fromLine.code}）`, 502);
      }
      const accepted = [];
      const rejected = [];
      for (const recipient of to) {
        const response = await session.cmd(`RCPT TO:<${headerText(recipient, 320)}>`);
        if (response.code === 250 || response.code === 251) accepted.push(recipient);
        else rejected.push({ address: recipient, code: response.code });
      }
      if (accepted.length === 0) {
        throw providerError('mail.transport_rejected', 'SMTP 服务器拒绝了所有收件人', 502);
      }
      const dataResponse = await session.cmd('DATA');
      if (dataResponse.code !== 354) {
        throw providerError('mail.smtp_rejected', `SMTP DATA 失败（${dataResponse.code}）`, 502);
      }
      session.socket.write(`${dotStuff(mime)}\r\n.\r\n`);
      const done = await session.expect([250], 'DATA 完成');
      await session.quit();
      return {
        ok: true,
        accepted,
        rejected,
        messageId,
        response: done.text,
        size: payload.length
      };
    } catch (error) {
      session.destroy();
      if (error && error.code) throw error;
      throw providerError('mail.smtp_failed', 'SMTP 发信失败', 502);
    }
  }

  return {
    provider: 'smtp',
    sendMail,
    close() {}
  };
}

module.exports = {
  createSmtpTransport,
  buildMime,
  encodeWord,
  formatAddress
};
