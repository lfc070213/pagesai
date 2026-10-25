'use strict';
// Mail 收件测试：IMAP 未配置 409、列表/详情、HTML 净化、
// 附件授权下载、跨用户 403、删除与批删。
// 测试只直接调用 route.handler(fake ctx)，不启动 HTTP。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const moduleRoot = path.join(__dirname, '..');
const { createMailModule } = require(path.join(moduleRoot, 'server', 'index.js'));

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
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return null;
    }
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
  const mergedQuery = { ...Object.fromEntries(url.searchParams), ...query };
  return matched.route.handler({
    req: { method, url: target, headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    res: {},
    url,
    params: matched.params,
    query: mergedQuery,
    body,
    user: currentUser
  });
}

async function boot(config = {}) {
  const mod = createMailModule();
  await mod.start({ config, logger: quietLogger });
  return mod;
}

function messageOne() {
  return {
    id: 'm1',
    from: { name: 'Alice', address: 'alice@example.test' },
    to: [{ name: 'Bob', address: 'bob@example.test' }],
    subject: 'Hello <b>world</b>',
    date: '2026-10-23T03:00:00.000Z',
    snippet: 'preview <script>alert(1)</script>',
    unread: true,
    html: '<p>Hello</p><script>alert(1)</script><img src="https://example.com/x.png" onerror="alert(2)"><a href="javascript:alert(3)">bad</a>',
    text: 'Hello plain',
    attachments: [
      { id: 'a1', filename: '../../report.html', contentType: 'text/html', size: 12 }
    ]
  };
}

function messageTwo() {
  return {
    id: 'm2',
    from: 'bob@example.test',
    to: 'carol@example.test',
    subject: 'Second',
    date: '2026-10-23T04:00:00.000Z',
    snippet: 'second',
    html: '<p>Second</p>',
    text: 'Second',
    attachments: []
  };
}

function createImapAdapter(initial = {}) {
  const boxes = new Map();
  for (const [userId, messages] of Object.entries(initial)) {
    boxes.set(userId, messages.map((message) => JSON.parse(JSON.stringify(message))));
  }
  const deleted = [];
  return {
    boxes,
    deleted,
    async listMessages({ user: currentUser, folder, limit, offset }) {
      assert.equal(folder, 'INBOX');
      const list = boxes.get(currentUser.id) || [];
      return { messages: list.slice(offset, offset + limit), total: list.length };
    },
    async getMessage({ user: currentUser, id }) {
      return (boxes.get(currentUser.id) || []).find((message) => message.id === id) || null;
    },
    async deleteMessage({ user: currentUser, id }) {
      deleted.push({ userId: currentUser.id, id });
      boxes.set(currentUser.id, (boxes.get(currentUser.id) || []).filter((message) => message.id !== id));
    },
    async getAttachment({ user: currentUser, messageId, attachmentId }) {
      const message = (boxes.get(currentUser.id) || []).find((item) => item.id === messageId);
      if (!message) return null;
      const attachment = (message.attachments || []).find((item) => item.id === attachmentId);
      if (!attachment) return null;
      return {
        filename: attachment.filename,
        contentType: attachment.contentType,
        contentBase64: Buffer.from(`content:${currentUser.id}:${messageId}:${attachmentId}`).toString('base64')
      };
    }
  };
}

test('未配置 IMAP 时收件接口返回 409 mail.imap_not_configured', async () => {
  const mod = await boot({});
  try {
    const unauth = await invoke(mod, 'GET', '/api/mail/messages', { user: null });
    assert.equal(unauth.status, 403);

    for (const [method, target] of [
      ['GET', '/api/mail/messages'],
      ['GET', '/api/mail/messages/m1'],
      ['DELETE', '/api/mail/messages/m1'],
      ['DELETE', '/api/mail/messages'],
      ['GET', '/api/mail/messages/m1/attachments/a1']
    ]) {
      const result = await invoke(mod, method, target, {
        user: user('u1'),
        body: method === 'DELETE' && target === '/api/mail/messages' ? { ids: ['m1'] } : {}
      });
      assert.equal(result.status, 409, `${method} ${target}`);
      assert.equal(result.body.code, 'mail.imap_not_configured', `${method} ${target}`);
    }
  } finally {
    await mod.stop();
  }
});

test('收件列表与详情归一化字段，并净化来信 HTML', async () => {
  const imap = createImapAdapter({ u1: [messageOne()], u2: [messageTwo()] });
  const mod = await boot({ imap });
  try {
    const list = await invoke(mod, 'GET', '/api/mail/messages', { user: user('u1') });
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 1);
    assert.equal(list.body.messages.length, 1);
    const summary = list.body.messages[0];
    assert.equal(summary.id, 'm1');
    assert.equal(summary.subject.includes('<'), false);
    assert.equal(summary.snippet.includes('<script'), false);
    assert.equal(summary.hasAttachments, true);
    assert.equal(typeof summary.html, 'string');
    assert.equal(/<script/i.test(summary.html), false);
    assert.equal(/onerror|javascript:/i.test(summary.html), false);
    assert.equal(summary.attachments[0].filename.includes('/'), false);
    assert.equal(summary.attachments[0].filename.includes('\\'), false);

    const detail = await invoke(mod, 'GET', '/api/mail/messages/m1', { user: user('u1') });
    assert.equal(detail.status, 200);
    const message = detail.body.message;
    assert.equal(message.id, 'm1');
    assert.equal(message.text, 'Hello plain');
    assert.equal(/<script/i.test(message.html), false);
    assert.equal(/onerror|javascript:/i.test(message.html), false);
    assert.match(message.html, /<p>Hello<\/p>/);
    assert.match(message.html, /<img src="https:\/\/example\.com\/x\.png"/);
  } finally {
    await mod.stop();
  }
});

test('跨用户读取、删除与下载附件均返回 403', async () => {
  const imap = createImapAdapter({ u1: [messageOne()], u2: [messageTwo()] });
  const mod = await boot({ imap });
  try {
    await invoke(mod, 'GET', '/api/mail/messages', { user: user('u1') });

    const detail = await invoke(mod, 'GET', '/api/mail/messages/m1', { user: user('u2') });
    assert.equal(detail.status, 403);
    assert.equal(detail.body.code, 'mail.forbidden');

    const remove = await invoke(mod, 'DELETE', '/api/mail/messages/m1', { user: user('u2') });
    assert.equal(remove.status, 403);
    assert.equal(remove.body.code, 'mail.forbidden');

    const attachment = await invoke(mod, 'GET', '/api/mail/messages/m1/attachments/a1', {
      user: user('u2')
    });
    assert.equal(attachment.status, 403);
    assert.equal(attachment.body.code, 'mail.forbidden');

    const bulk = await invoke(mod, 'DELETE', '/api/mail/messages', {
      user: user('u1'),
      body: { ids: ['m1', 'm2'] }
    });
    assert.equal(bulk.status, 404); // m2 尚未进入 u1 的索引，不越权猜测存在性
    assert.equal(imap.deleted.length, 0);

    await invoke(mod, 'GET', '/api/mail/messages', { user: user('u2') });
    const crossUserBulk = await invoke(mod, 'DELETE', '/api/mail/messages', {
      user: user('u1'),
      body: { ids: ['m1', 'm2'] }
    });
    assert.equal(crossUserBulk.status, 403);
    assert.equal(crossUserBulk.body.code, 'mail.forbidden');
    assert.equal(imap.deleted.length, 0);
  } finally {
    await mod.stop();
  }
});

test('附件下载校验授权、限制文件名并强制安全类型', async () => {
  const imap = createImapAdapter({ u1: [messageOne()] });
  const mod = await boot({ imap });
  try {
    await invoke(mod, 'GET', '/api/mail/messages', { user: user('u1') });

    const result = await invoke(mod, 'GET', '/api/mail/messages/m1/attachments/a1', {
      user: user('u1')
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.contentType, 'application/octet-stream');
    assert.equal(result.body.disposition, 'attachment');
    assert.equal(result.body.filename.includes('/'), false);
    assert.equal(result.body.filename.includes('\\'), false);
    assert.equal(Buffer.from(result.body.contentBase64, 'base64').toString('utf8'), 'content:u1:m1:a1');

    const unknownAttachment = await invoke(mod, 'GET', '/api/mail/messages/m1/attachments/a9', {
      user: user('u1')
    });
    assert.equal(unknownAttachment.status, 404);
    assert.equal(unknownAttachment.body.code, 'mail.attachment_not_found');

    const unknownMessage = await invoke(mod, 'GET', '/api/mail/messages/m9/attachments/a1', {
      user: user('u1')
    });
    assert.equal(unknownMessage.status, 404);
    assert.equal(unknownMessage.body.code, 'mail.message_not_found');
  } finally {
    await mod.stop();
  }
});

test('删除自己的邮件后索引移除，未知邮件返回 404', async () => {
  const imap = createImapAdapter({ u1: [messageOne()] });
  const mod = await boot({ imap });
  try {
    await invoke(mod, 'GET', '/api/mail/messages', { user: user('u1') });
    const removed = await invoke(mod, 'DELETE', '/api/mail/messages/m1', { user: user('u1') });
    assert.equal(removed.status, 200);
    assert.deepEqual(imap.deleted, [{ userId: 'u1', id: 'm1' }]);

    const detail = await invoke(mod, 'GET', '/api/mail/messages/m1', { user: user('u1') });
    assert.equal(detail.status, 404);
    assert.equal(detail.body.code, 'mail.message_not_found');

    const unknown = await invoke(mod, 'DELETE', '/api/mail/messages/m9', { user: user('u1') });
    assert.equal(unknown.status, 404);

    const list = await invoke(mod, 'GET', '/api/mail/messages', { user: user('u1') });
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 0);
  } finally {
    await mod.stop();
  }
});

test('DELETE /api/mail/messages 支持批量删除并先做完整授权检查', async () => {
  const imap = createImapAdapter({ u1: [messageOne()], u2: [messageTwo()] });
  const mod = await boot({ imap });
  try {
    await invoke(mod, 'GET', '/api/mail/messages', { user: user('u1') });
    await invoke(mod, 'GET', '/api/mail/messages', { user: user('u2') });

    const denied = await invoke(mod, 'DELETE', '/api/mail/messages', {
      user: user('u1'),
      body: { ids: ['m1', 'm2'] }
    });
    assert.equal(denied.status, 403);
    assert.equal(imap.deleted.length, 0);

    const removed = await invoke(mod, 'DELETE', '/api/mail/messages', {
      user: user('u1'),
      body: { ids: ['m1'] }
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.deleted, ['m1']);
    assert.deepEqual(imap.deleted, [{ userId: 'u1', id: 'm1' }]);
  } finally {
    await mod.stop();
  }
});

test('IMAP 适配器异常返回 502，不伪造空收件箱', async () => {
  const imap = {
    async listMessages() {
      throw new Error('imap down');
    }
  };
  const mod = await boot({ imap });
  try {
    const result = await invoke(mod, 'GET', '/api/mail/messages', { user: user('u1') });
    assert.equal(result.status, 502);
    assert.equal(result.body.code, 'mail.imap_error');
    assert.equal('messages' in result.body, false);
  } finally {
    await mod.stop();
  }
});

test('IMAP 返回缺少 ID 的邮件时明确报错，不生成伪造 ID', async () => {
  const imap = {
    async listMessages() {
      return { messages: [{ subject: 'missing id' }], total: 1 };
    }
  };
  const mod = await boot({ imap });
  try {
    const result = await invoke(mod, 'GET', '/api/mail/messages', { user: user('u1') });
    assert.equal(result.status, 502);
    assert.equal(result.body.code, 'mail.imap_error');
  } finally {
    await mod.stop();
  }
});
