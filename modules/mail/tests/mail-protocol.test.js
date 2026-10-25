'use strict';
// Mail 真实协议测试：内置 SMTP 与 IMAP 客户端对隔离的本地假服务器收发。
// 不连接任何外部邮件服务；只验证协议实现、幂等与所有权边界。

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const moduleRoot = path.join(__dirname, '..');
const { createMailModule } = require(path.join(moduleRoot, 'server', 'index.js'));
const { createSmtpTransport } = require(path.join(moduleRoot, 'providers', 'smtp.js'));
const { createImapInbox } = require(path.join(moduleRoot, 'providers', 'imap.js'));

const quietLogger = { info() {}, warn() {}, error() {} };

function user(id = 'u1', email = 'alice@example.test') {
  return { id, username: id, email };
}

function matchPath(template, actualPath) {
  const templateParts = template.split('/').filter(Boolean);
  const actualParts = actualPath.split('/').filter(Boolean);
  if (templateParts.length !== actualParts.length) return null;
  const params = {};
  for (let index = 0; index < templateParts.length; index += 1) {
    const expected = templateParts[index];
    const actual = actualParts[index];
    if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(actual);
    else if (expected !== actual) return null;
  }
  return params;
}

async function invoke(mod, method, target, { user: currentUser = null, body = {}, query = {} } = {}) {
  const url = new URL(target, 'http://127.0.0.1');
  let matched = null;
  for (const route of mod.routes) {
    if (route.method !== method) continue;
    const params = matchPath(route.path, url.pathname);
    if (params) {
      matched = { route, params };
      break;
    }
  }
  if (!matched) throw new Error(`未找到路由 ${method} ${url.pathname}`);
  return matched.route.handler({
    req: { method, url: target, headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    res: {},
    url,
    params: matched.params,
    query: { ...Object.fromEntries(url.searchParams), ...query },
    body,
    user: currentUser
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function createFakeSmtp() {
  const received = [];
  const commands = [];
  const server = net.createServer((socket) => {
    // 客户端在 QUIT/LOGOUT 后可能立即销毁连接，服务端会收到 ECONNRESET；
    // 假服务器必须自行吞掉该错误，否则会被 node:test 计为未捕获异常。
    socket.on('error', () => {});
    socket.setEncoding('latin1');
    socket.write('220 fake-smtp ready\r\n');
    let buffer = '';
    let inData = false;
    let data = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (true) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          received.push(data.replace(/\r\n\.\./g, '\r\n.'));
          data = '';
          commands.push('DATA-BODY');
          socket.write('250 2.0.0 queued\r\n');
          continue;
        }
        const index = buffer.indexOf('\r\n');
        if (index < 0) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        commands.push(line);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) {
          socket.write('250-fake-smtp\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SIZE 10485760\r\n');
        } else if (upper.startsWith('AUTH PLAIN')) {
          socket.write('235 2.7.0 authenticated\r\n');
        } else if (upper.startsWith('AUTH LOGIN')) {
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          socket.write('250 2.1.0 ok\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          socket.write(line.includes('bad@example.test') ? '550 5.1.1 no such user\r\n' : '250 2.1.5 ok\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          commands.push('DATA');
          socket.write('354 end with .\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
          return;
        } else if (/^[A-Za-z0-9+/=]+$/.test(line)) {
          socket.write('334 UGFzc3dvcmQ6\r\n');
        } else {
          socket.write('250 ok\r\n');
        }
      }
    });
  });
  return { server, received, commands };
}

function base64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function crlf(text) {
  return text.replace(/\r?\n/g, '\r\n');
}

function buildMessage({ uid, flags = '', subject = 'Hello', from = 'Alice <alice@example.test>', to = 'Bob <bob@example.test>', raw }) {
  const content = Buffer.isBuffer(raw) ? raw : Buffer.from(crlf(raw), 'utf8');
  return {
    uid,
    flags,
    subject,
    from,
    to,
    raw: content,
    internalDate: '23-Oct-2026 03:00:00 +0000'
  };
}

function multipartMessage() {
  const plain = base64('Hello plain');
  const html = '<p>Hello =E4=B8=96=E7=95=8C</p>';
  const attachment = base64('attachment body');
  const raw = [
    'From: Alice <alice@example.test>',
    'To: Bob <bob@example.test>',
    'Subject: =?UTF-8?B?5L2g5aW9?=',
    'Date: Fri, 23 Oct 2026 03:00:00 +0000',
    'Message-ID: <m1@example.test>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="mix"',
    '',
    '--mix',
    'Content-Type: multipart/alternative; boundary="alt"',
    '',
    '--alt',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    plain,
    '--alt',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    html,
    '--alt--',
    '--mix',
    'Content-Type: text/plain; charset=utf-8; name="notes.txt"',
    'Content-Disposition: attachment; filename="notes.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    attachment,
    '--mix--',
    ''
  ].join('\r\n');
  return Buffer.from(raw, 'utf8');
}

function plainMessage() {
  return Buffer.from([
    'From: Carol <carol@example.test>',
    'To: Bob <bob@example.test>',
    'Subject: Plain only',
    'Date: Fri, 23 Oct 2026 04:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    'Second message body',
    ''
  ].join('\r\n'), 'utf8');
}

function createFakeImap(messages) {
  const commands = [];
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.setEncoding('latin1');
    socket.write('* OK fake-imap ready\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (true) {
        const index = buffer.indexOf('\r\n');
        if (index < 0) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        commands.push(line);
        const match = /^(A\d+) (.*)$/.exec(line);
        if (!match) {
          socket.write(`* BAD ${line}\r\n`);
          continue;
        }
        const tag = match[1];
        const command = match[2];
        const upper = command.toUpperCase();
        if (upper.startsWith('CAPABILITY')) {
          socket.write(`* CAPABILITY IMAP4rev1 UIDPLUS\r\n${tag} OK capability\r\n`);
        } else if (upper.startsWith('LOGIN')) {
          const quoted = /LOGIN "([^"]*)" "([^"]*)"/.exec(command);
          if (!quoted || quoted[1] !== 'alice@example.test' || quoted[2] !== 'secret') {
            socket.write(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials\r\n`);
          } else {
            socket.write(`${tag} OK logged in\r\n`);
          }
        } else if (upper.startsWith('EXAMINE') || upper.startsWith('SELECT')) {
          socket.write(`* ${messages.length} EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n${tag} OK [${upper.startsWith('EXAMINE') ? 'READ-ONLY' : 'READ-WRITE'}] selected\r\n`);
        } else if (upper.startsWith('UID SEARCH')) {
          socket.write(`* SEARCH ${messages.map((item) => item.uid).join(' ')}\r\n${tag} OK search\r\n`);
        } else if (upper.startsWith('UID FETCH')) {
          const uidMatch = /UID FETCH ([\d,]+)/i.exec(command);
          const requested = uidMatch ? uidMatch[1].split(',').map(Number) : [];
          for (const uid of requested) {
            const item = messages.find((entry) => entry.uid === uid);
            if (!item) continue;
            socket.write(
              `* 1 FETCH (UID ${item.uid} FLAGS (${item.flags}) INTERNALDATE "${item.internalDate}" RFC822.SIZE ${item.raw.length} BODY[]<0> {${item.raw.length}}\r\n`
            );
            socket.write(item.raw.toString('latin1'));
            socket.write(')\r\n');
          }
          socket.write(`${tag} OK fetch\r\n`);
        } else if (upper.startsWith('UID STORE')) {
          socket.write(`${tag} OK stored\r\n`);
        } else if (upper.startsWith('UID EXPUNGE') || upper === 'EXPUNGE') {
          socket.write(`${tag} OK expunged\r\n`);
        } else if (upper === 'LOGOUT') {
          socket.write(`* BYE bye\r\n${tag} OK logout\r\n`);
          socket.end();
          return;
        } else {
          socket.write(`${tag} OK ok\r\n`);
        }
      }
    });
  });
  return { server, commands };
}

test('SMTP 客户端完成 EHLO/AUTH/MAIL/RCPT/DATA，并正确构建 MIME', async () => {
  const fake = createFakeSmtp();
  const port = await listen(fake.server);
  try {
    const transport = createSmtpTransport({
      host: '127.0.0.1',
      port,
      secure: false,
      starttls: false,
      user: 'smtp-user',
      password: 'smtp-pass',
      timeoutMs: 5000
    });
    const info = await transport.sendMail({
      from: { name: '系统通知', address: 'no-reply@example.test' },
      to: ['bob@example.test', 'bad@example.test'],
      subject: '你好 SMTP',
      text: 'plain body',
      html: '<p>html body</p>',
      attachments: [{ filename: '报告.txt', contentType: 'text/plain', content: Buffer.from('attached') }]
    });
    assert.deepEqual(info.accepted, ['bob@example.test']);
    assert.equal(info.rejected.length, 1);
    assert.equal(fake.received.length, 1);
    const raw = fake.received[0];
    assert.match(raw, /From: =\?UTF-8\?B\?/);
    assert.match(raw, /Subject: =\?UTF-8\?B\?/);
    assert.match(raw, /Content-Type: multipart\/mixed/);
    assert.match(raw, /multipart\/alternative/);
    assert.match(raw, /filename\*=UTF-8''/);
    assert.match(raw, /Content-Transfer-Encoding: base64/);
    const plainBase64 = base64('plain body');
    assert.ok(raw.includes(plainBase64));
    assert.ok(raw.includes(base64('attached')));
    assert.ok(fake.commands.some((line) => line.startsWith('AUTH PLAIN')));
    assert.ok(fake.commands.some((line) => line.startsWith('MAIL FROM:<no-reply@example.test>')));
  } finally {
    await closeServer(fake.server);
  }
});

test('Mail 模块使用内置 SMTP：发信成功、幂等重试不重复投递', async () => {
  const fake = createFakeSmtp();
  const port = await listen(fake.server);
  const mod = createMailModule();
  try {
    await mod.start({
      config: {
        from: 'no-reply@example.test',
        userSendEnabled: true,
        transport: {
          provider: 'smtp',
          host: '127.0.0.1',
          port,
          secure: false,
          starttls: false,
          user: 'smtp-user',
          password: 'smtp-pass',
          timeoutMs: 5000
        }
      },
      logger: quietLogger
    });
    const body = {
      to: 'bob@example.test',
      subject: 'Idempotent',
      text: 'same content',
      idempotencyKey: 'key-1'
    };
    const first = await invoke(mod, 'POST', '/api/mail/send', { user: user(), body });
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'accepted');
    const second = await invoke(mod, 'POST', '/api/mail/send', { user: user(), body });
    assert.equal(second.status, 200);
    assert.equal(second.body.id, first.body.id);
    assert.equal(fake.received.length, 1);

    const conflict = await invoke(mod, 'POST', '/api/mail/send', {
      user: user(),
      body: { ...body, text: 'different' }
    });
    assert.equal(conflict.status, 409);
    assert.equal(fake.received.length, 1);
  } finally {
    await mod.stop();
    await closeServer(fake.server);
  }
});

test('IMAP 客户端解析 multipart、正文、附件与删除', async () => {
  const messages = [
    buildMessage({ uid: 101, raw: plainMessage() }),
    buildMessage({ uid: 102, flags: '\\Seen', raw: multipartMessage() })
  ];
  const fake = createFakeImap(messages);
  const port = await listen(fake.server);
  try {
    const inbox = createImapInbox({
      provider: 'imap',
      host: '127.0.0.1',
      port,
      secure: false,
      starttls: false,
      allowInsecure: true,
      user: 'alice@example.test',
      password: 'secret',
      timeoutMs: 5000
    });
    const listed = await inbox.listMessages({ user: user(), folder: 'INBOX', limit: 30, offset: 0 });
    assert.equal(listed.total, 2);
    assert.equal(listed.messages.length, 2);
    assert.equal(listed.messages[0].id, '102');
    assert.equal(listed.messages[0].subject, '你好');
    assert.equal(listed.messages[0].unread, false);
    assert.match(listed.messages[0].html, /世界/);
    assert.match(listed.messages[0].text, /Hello plain/);
    assert.ok(listed.messages[0].attachments.length >= 1);
    const attachment = listed.messages[0].attachments.find((item) => item.filename === 'notes.txt');
    assert.ok(attachment);

    const detail = await inbox.getMessage({ user: user(), folder: 'INBOX', id: '102' });
    assert.equal(detail.id, '102');
    assert.match(detail.text, /Hello plain/);

    const downloaded = await inbox.getAttachment({
      user: user(),
      folder: 'INBOX',
      messageId: '102',
      attachmentId: attachment.id
    });
    assert.equal(downloaded.filename, 'notes.txt');
    assert.equal(Buffer.from(downloaded.contentBase64, 'base64').toString('utf8'), 'attachment body');

    const page = await inbox.listMessages({ user: user(), folder: 'INBOX', limit: 1, offset: 1 });
    assert.equal(page.total, 2);
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0].id, '101');

    await inbox.deleteMessage({ user: user(), folder: 'INBOX', id: '101' });
    assert.ok(fake.commands.some((line) => line.includes('UID STORE 101 +FLAGS.SILENT')));
    assert.ok(fake.commands.some((line) => line.includes('UID EXPUNGE 101')));
  } finally {
    await closeServer(fake.server);
  }
});

test('Mail 模块使用内置 IMAP：本人收件、附件下载与跨用户隔离', async () => {
  const messages = [buildMessage({ uid: 201, raw: multipartMessage() })];
  const fake = createFakeImap(messages);
  const port = await listen(fake.server);
  const mod = createMailModule();
  try {
    await mod.start({
      config: {
        from: 'no-reply@example.test',
        imap: {
          provider: 'imap',
          host: '127.0.0.1',
          port,
          secure: false,
          starttls: false,
          allowInsecure: true,
          user: 'alice@example.test',
          password: 'secret',
          timeoutMs: 5000
        }
      },
      logger: quietLogger
    });
    const listed = await invoke(mod, 'GET', '/api/mail/messages?folder=INBOX', { user: user('u1') });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.messages.length, 1);
    assert.equal(listed.body.messages[0].id, '201');
    const attachment = listed.body.messages[0].attachments.find((item) => item.filename === 'notes.txt');

    const detail = await invoke(mod, 'GET', '/api/mail/messages/201', { user: user('u1') });
    assert.equal(detail.status, 200);
    assert.match(detail.body.message.text, /Hello plain/);

    const download = await invoke(mod, 'GET', `/api/mail/messages/201/attachments/${attachment.id}`, { user: user('u1') });
    assert.equal(download.status, 200);
    assert.equal(Buffer.from(download.body.contentBase64, 'base64').toString('utf8'), 'attachment body');

    // 另一个用户没有索引过该邮件，不能凭 ID 直接读取。
    const otherRead = await invoke(mod, 'GET', '/api/mail/messages/201', { user: user('u2') });
    assert.equal(otherRead.status, 403);
    const otherDownload = await invoke(mod, 'GET', `/api/mail/messages/201/attachments/${attachment.id}`, { user: user('u2') });
    assert.equal(otherDownload.status, 403);
  } finally {
    await mod.stop();
    await closeServer(fake.server);
  }
});
