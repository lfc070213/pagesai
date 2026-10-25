'use strict';
// Mail 模块核心测试：清单/配置契约、统一接口、发信、幂等、验证码、HTML 净化。
// 运行：node --test modules/mail/tests/*.test.js
// 测试只直接调用 route.handler(fake ctx)，不启动 HTTP。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const moduleRoot = path.join(__dirname, '..');
const pagesaiRoot = path.join(moduleRoot, '..', '..');
const { createMailModule } = require(path.join(moduleRoot, 'server', 'index.js'));
const { validateManifest } = require(path.join(pagesaiRoot, 'core', 'registry', 'manifest.js'));
const { validate } = require(path.join(pagesaiRoot, 'core', 'contracts', 'validate.js'));

const FROM = Object.freeze({ name: 'PagesAI', address: 'no-reply@example.test' });
const quietLogger = { info() {}, warn() {}, error() {} };

function user(id = 'u1', email = 'alice@example.test') {
  return { id, username: id, email };
}

function configured(transport, extra = {}) {
  return { from: FROM, userSendEnabled: true, transport, ...extra };
}

function recordingTransport() {
  const calls = [];
  return {
    calls,
    async sendMail(message) {
      calls.push(message);
      return { accepted: true, messageId: `smtp-${calls.length}` };
    }
  };
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

function findRoute(mod, method, pathname) {
  for (const route of mod.routes) {
    if (route.method !== method) continue;
    const params = matchPath(route.path, pathname);
    if (params) return { route, params };
  }
  return null;
}

async function invoke(mod, method, target, { user: currentUser = null, body = {}, query = {} } = {}) {
  const url = new URL(target, 'http://127.0.0.1');
  const matched = findRoute(mod, method, url.pathname);
  if (!matched) throw new Error(`未找到路由 ${method} ${url.pathname}`);
  const mergedQuery = { ...Object.fromEntries(url.searchParams), ...query };
  const req = {
    method,
    url: target,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' }
  };
  return matched.route.handler({
    req,
    res: {},
    url,
    params: matched.params,
    query: mergedQuery,
    body,
    user: currentUser
  });
}

async function boot(config = {}, options = {}) {
  const mod = createMailModule();
  await mod.start({ config, logger: quietLogger, ...options });
  return mod;
}

test('manifest 通过公共契约校验，config schema 接受最小配置', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'manifest.json'), 'utf8'));
  assert.doesNotThrow(() => validateManifest(manifest));
  assert.equal(manifest.id, 'mail');
  assert.equal(manifest.activation.serverEntry, 'server/index.js');
  assert.equal(manifest.activation.routePrefix, '/api/mail');
  assert.equal(manifest.config.schema, 'config.schema.json');
  assert.equal(manifest.data.namespace, 'mail');
  assert.ok(Array.isArray(manifest.capabilities.tools));

  const schema = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'config.schema.json'), 'utf8'));
  assert.equal(validate(schema, {}).valid, true);
  assert.equal(validate(schema, {
    from: 'no-reply@example.test',
    userSendEnabled: true,
    transport: { sendMail() {} },
    imap: { listMessages() {} }
  }).valid, true);
  assert.equal(validate(schema, { unexpected: true }).valid, false);
});

test('统一接口导出完整，全部路由位于 /api/mail/ 下', async () => {
  const mod = await boot({});
  try {
    assert.deepEqual(Object.keys(mod).sort(), ['health', 'routes', 'start', 'stop', 'tools']);
    for (const name of ['start', 'stop', 'health']) assert.equal(typeof mod[name], 'function');
    assert.ok(Array.isArray(mod.routes));
    assert.ok(mod.routes.length >= 6);
    assert.deepEqual(Object.keys(mod.tools).sort(), [
      'mail_delete_message',
      'mail_list_messages',
      'mail_read_message',
      'mail_send'
    ]);
    for (const route of mod.routes) {
      assert.ok(route.path.startsWith('/api/mail/'), route.path);
      assert.equal(typeof route.handler, 'function');
    }
    const health = await mod.health();
    assert.equal(health.ok, true);
    assert.equal(health.transportConfigured, false);
    assert.equal(health.imapConfigured, false);
    assert.equal(health.storage, 'memory');
  } finally {
    await mod.stop();
  }
  assert.equal((await mod.health()).ok, false);
});

test('未 start 时调用 handler 返回 503，不伪造业务结果', async () => {
  const mod = createMailModule();
  const result = await invoke(mod, 'POST', '/api/mail/send', { user: user() });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'mail.not_started');
});

test('未认证的写操作返回 403', async () => {
  const transport = recordingTransport();
  const mod = await boot(configured(transport));
  try {
    const send = await invoke(mod, 'POST', '/api/mail/send', {
      user: null,
      body: { to: 'target@example.test', text: 'hi' }
    });
    assert.equal(send.status, 403);
    assert.equal(send.body.code, 'mail.unauthenticated');

    const verification = await invoke(mod, 'POST', '/api/mail/verification', {
      user: null,
      body: { email: 'target@example.test' }
    });
    assert.equal(verification.status, 403);
    assert.equal(verification.body.code, 'mail.unauthenticated');

    const remove = await invoke(mod, 'DELETE', '/api/mail/messages/m1', { user: null });
    assert.equal(remove.status, 403);

    assert.equal(transport.calls.length, 0);
  } finally {
    await mod.stop();
  }
});

test('未配置发信适配器返回 409 mail.transport_not_configured', async () => {
  // 默认 userSendEnabled=false 时也必须先报“适配器未配置”，不能被误判成权限问题。
  const mod = await boot({ from: FROM });
  try {
    const send = await invoke(mod, 'POST', '/api/mail/send', {
      user: user(),
      body: { to: 'target@example.test', text: 'hi' }
    });
    assert.equal(send.status, 409);
    assert.equal(send.body.code, 'mail.transport_not_configured');
    assert.equal(typeof send.body.message, 'string');

    const verification = await invoke(mod, 'POST', '/api/mail/verification', {
      user: user(),
      body: { email: 'target@example.test' }
    });
    assert.equal(verification.status, 409);
    assert.equal(verification.body.code, 'mail.transport_not_configured');
  } finally {
    await mod.stop();
  }
});

test('未配置系统发件身份返回 409 mail.from_not_configured', async () => {
  const transport = recordingTransport();
  const mod = await boot({ userSendEnabled: true, transport });
  try {
    const result = await invoke(mod, 'POST', '/api/mail/send', {
      user: user(),
      body: { to: 'target@example.test', text: 'hi' }
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'mail.from_not_configured');
    assert.equal(transport.calls.length, 0);
  } finally {
    await mod.stop();
  }
});

test('用户发信权限与系统发件身份分离', async () => {
  const transport = recordingTransport();
  const mod = await boot({ from: FROM, userSendEnabled: false, transport });
  try {
    const send = await invoke(mod, 'POST', '/api/mail/send', {
      user: user(),
      body: { to: 'target@example.test', text: 'hi' }
    });
    assert.equal(send.status, 403);
    assert.equal(send.body.code, 'mail.user_send_disabled');
    assert.equal(transport.calls.length, 0);

    // 系统验证码发信不受 userSendEnabled 影响。
    const verification = await invoke(mod, 'POST', '/api/mail/verification', {
      user: user(),
      body: { email: 'target@example.test' }
    });
    assert.equal(verification.status, 200);
    assert.equal(transport.calls.length, 1);
    assert.equal(transport.calls[0].from.address, FROM.address);
    assert.match(transport.calls[0].text, /\d{6}/);
  } finally {
    await mod.stop();
  }
});

test('发信使用系统 from，净化 HTML 并区分受理与投递状态', async () => {
  const transport = recordingTransport();
  const mod = await boot(configured(transport));
  try {
    const html = [
      '<p>Hello</p>',
      '<script>alert(1)</script>',
      '<a href="javascript:alert(2)" onclick="alert(3)">bad</a>',
      '<img src="x" onerror="alert(4)">',
      '<a href="https://example.com/a?b=1">good</a>',
      '<iframe src="https://evil.example"></iframe>'
    ].join('');
    const result = await invoke(mod, 'POST', '/api/mail/send', {
      user: user(),
      body: {
        to: 'alice@example.test',
        subject: 'Hi\r\nBcc: evil@example.test',
        text: 'plain',
        html,
        idempotencyKey: 'send-1'
      }
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.status, 'accepted');
    assert.equal(result.body.transportStatus, 'accepted');
    assert.equal(result.body.deliveryStatus, 'unknown');
    assert.equal(result.body.from, FROM.address);
    assert.equal(transport.calls.length, 1);

    const sent = transport.calls[0];
    assert.deepEqual(sent.to, ['alice@example.test']);
    assert.equal(sent.from.address, FROM.address);
    assert.equal(sent.from.name, FROM.name);
    assert.equal(/[\r\n]/.test(sent.subject), false);
    assert.equal(/<script/i.test(sent.html), false);
    assert.equal(/<iframe/i.test(sent.html), false);
    assert.equal(/onerror|onclick/i.test(sent.html), false);
    assert.equal(/javascript:/i.test(sent.html), false);
    assert.match(sent.html, /<p>Hello<\/p>/);
    assert.match(sent.html, /href="https:\/\/example\.com\/a\?b=1"/);
  } finally {
    await mod.stop();
  }
});

test('用户不能伪造 from，附加发件人字段被拒绝', async () => {
  const transport = recordingTransport();
  const mod = await boot(configured(transport));
  try {
    const result = await invoke(mod, 'POST', '/api/mail/send', {
      user: user(),
      body: { from: 'evil@example.test', to: 'target@example.test', text: 'hi' }
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'mail.invalid_input');
    assert.equal(transport.calls.length, 0);
  } finally {
    await mod.stop();
  }
});

test('HTML 净化覆盖编码后的 javascript:、事件属性与危险标签', async () => {
  const transport = recordingTransport();
  const mod = await boot(configured(transport));
  try {
    const html = [
      '<a href="jav&#x61;script:alert(1)">x</a>',
      '<a href="java&#115;cript:alert(2)">x</a>',
      '<div onmouseover="alert(3)">x</div>',
      '<p style="background:url(javascript:alert(4))">x</p>',
      '<svg onload="alert(5)"></svg>',
      '<img src="https://example.com/x.png" onerror="alert(6)">'
    ].join('');
    const result = await invoke(mod, 'POST', '/api/mail/send', {
      user: user(),
      body: { to: 'target@example.test', html }
    });
    assert.equal(result.status, 200);
    const sentHtml = transport.calls[0].html;
    assert.equal(/javascript/i.test(sentHtml), false);
    assert.equal(/\son[a-z]+\s*=/i.test(sentHtml), false);
    assert.equal(/<svg/i.test(sentHtml), false);
    assert.equal(/style\s*=/i.test(sentHtml), false);
    assert.match(sentHtml, /<img src="https:\/\/example\.com\/x\.png"/);
  } finally {
    await mod.stop();
  }
});

test('幂等键重复请求不重发，返回首次结果；跨用户互不干扰', async () => {
  const transport = recordingTransport();
  const mod = await boot(configured(transport));
  try {
    const body = {
      to: 'target@example.test',
      subject: 'Subject',
      text: 'Body',
      idempotencyKey: 'idem-1'
    };
    const first = await invoke(mod, 'POST', '/api/mail/send', { user: user('u1'), body });
    const second = await invoke(mod, 'POST', '/api/mail/send', { user: user('u1'), body });
    assert.equal(first.status, 200);
    assert.deepEqual(second.body, first.body);
    assert.equal(transport.calls.length, 1);

    const conflict = await invoke(mod, 'POST', '/api/mail/send', {
      user: user('u1'),
      body: { ...body, subject: 'Changed' }
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'mail.idempotency_conflict');
    assert.equal(transport.calls.length, 1);

    const otherUser = await invoke(mod, 'POST', '/api/mail/send', { user: user('u2'), body });
    assert.equal(otherUser.status, 200);
    assert.equal(transport.calls.length, 2);
    assert.notEqual(otherUser.body.id, first.body.id);
  } finally {
    await mod.stop();
  }
});

test('并发相同幂等键只触发一次发信', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const transport = {
    async sendMail() {
      calls += 1;
      await gate;
      return { accepted: true, messageId: 'smtp-concurrent' };
    }
  };
  const mod = await boot(configured(transport));
  try {
    const body = {
      to: 'target@example.test',
      subject: 'Concurrent',
      text: 'Body',
      idempotencyKey: 'idem-concurrent'
    };
    const first = invoke(mod, 'POST', '/api/mail/send', { user: user(), body });
    const second = invoke(mod, 'POST', '/api/mail/send', { user: user(), body });
    const conflict = invoke(mod, 'POST', '/api/mail/send', {
      user: user(),
      body: { ...body, subject: 'Different' }
    });
    await new Promise((resolve) => setImmediate(resolve));
    const rejected = await conflict;
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, 'mail.idempotency_conflict');
    release();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.equal(left.status, 200);
    assert.equal(right.status, 200);
    assert.deepEqual(left.body, right.body);
  } finally {
    await mod.stop();
  }
});

test('发信适配器失败不虚报，同一幂等键返回首次失败结果', async () => {
  let calls = 0;
  const transport = {
    async sendMail() {
      calls += 1;
      throw new Error('smtp down');
    }
  };
  const mod = await boot(configured(transport));
  try {
    const body = {
      to: 'target@example.test',
      subject: 'Failure',
      text: 'Body',
      idempotencyKey: 'idem-failure'
    };
    const first = await invoke(mod, 'POST', '/api/mail/send', { user: user(), body });
    assert.equal(first.status, 502);
    assert.equal(first.body.code, 'mail.send_failed');
    assert.equal(calls, 1);

    const second = await invoke(mod, 'POST', '/api/mail/send', { user: user(), body });
    assert.equal(second.status, 502);
    assert.deepEqual(second.body, first.body);
    assert.equal(calls, 1);
  } finally {
    await mod.stop();
  }
});

test('适配器明确未接受任何收件人时返回 502，不虚报已发送', async () => {
  const transport = {
    async sendMail() {
      return { accepted: [], rejected: ['target@example.test'] };
    }
  };
  const mod = await boot(configured(transport));
  try {
    const result = await invoke(mod, 'POST', '/api/mail/send', {
      user: user(),
      body: { to: 'target@example.test', text: 'Body' }
    });
    assert.equal(result.status, 502);
    assert.equal(result.body.code, 'mail.send_failed');
  } finally {
    await mod.stop();
  }
});

test('验证码 10 分钟内最多 5 次，第 6 次返回 429', async () => {
  const transport = recordingTransport();
  const mod = await boot(configured(transport));
  try {
    const body = { email: 'limit@example.test' };
    const bodies = [];
    for (let index = 0; index < 5; index += 1) {
      const result = await invoke(mod, 'POST', '/api/mail/verification', { user: user(), body });
      assert.equal(result.status, 200);
      assert.equal('code' in result.body, false);
      bodies.push(result.body);
    }
    assert.equal(transport.calls.length, 5);
    assert.deepEqual(bodies[4], bodies[0]);

    const sixth = await invoke(mod, 'POST', '/api/mail/verification', { user: user(), body });
    assert.equal(sixth.status, 429);
    assert.equal(sixth.body.code, 'mail.verification_rate_limited');
    assert.equal(transport.calls.length, 5);
  } finally {
    await mod.stop();
  }
});

test('验证码响应不泄露收件人是否存在', async () => {
  const transport = recordingTransport();
  const mod = await boot(configured(transport));
  try {
    const known = await invoke(mod, 'POST', '/api/mail/verification', {
      user: user('u1', 'known@example.test'),
      body: { email: 'known@example.test' }
    });
    const unknown = await invoke(mod, 'POST', '/api/mail/verification', {
      user: user('u1', 'known@example.test'),
      body: { email: 'nobody@example.test' }
    });
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.deepEqual(unknown.body, known.body);
    assert.equal(JSON.stringify(known.body).includes('exist'), false);
  } finally {
    await mod.stop();
  }
});

test('验证码 10 分钟有效，错误码与过期码均被拒绝', async () => {
  let now = 1_700_000_000_000;
  const transport = recordingTransport();
  const mod = await boot(configured(transport), {
    clock: () => now,
    codeGenerator: () => '123456'
  });
  try {
    const email = 'alice@example.test';
    let result = await invoke(mod, 'POST', '/api/mail/verification', {
      user: user('u1', email),
      body: { email }
    });
    assert.equal(result.status, 200);

    result = await invoke(mod, 'POST', '/api/mail/verification/verify', {
      user: user('u1', email),
      body: { email, code: '000000' }
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'mail.verification_invalid');

    result = await invoke(mod, 'POST', '/api/mail/verification/verify', {
      user: user('u1', email),
      body: { email, code: '123456' }
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);

    result = await invoke(mod, 'POST', '/api/mail/verification', {
      user: user('u1', email),
      body: { email }
    });
    assert.equal(result.status, 200);

    now += 10 * 60 * 1000 + 1;
    result = await invoke(mod, 'POST', '/api/mail/verification/verify', {
      user: user('u1', email),
      body: { email, code: '123456' }
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'mail.verification_invalid');

    // 窗口已过，可重新发送。
    result = await invoke(mod, 'POST', '/api/mail/verification', {
      user: user('u1', email),
      body: { email }
    });
    assert.equal(result.status, 200);
  } finally {
    await mod.stop();
  }
});

test('verification.public=true 时允许注册前置流程的匿名验证码请求', async () => {
  const transport = recordingTransport();
  const mod = await boot(
    { from: FROM, transport, verification: { public: true } },
    { codeGenerator: () => '123456' }
  );
  try {
    const email = 'new-user@example.test';
    const sent = await invoke(mod, 'POST', '/api/mail/verification', {
      user: null,
      body: { email, purpose: 'register' }
    });
    assert.equal(sent.status, 200);
    assert.equal(transport.calls.length, 1);
    assert.deepEqual(transport.calls[0].to, [email]);

    const verified = await invoke(mod, 'POST', '/api/mail/verification/verify', {
      user: null,
      body: { email, code: '123456' }
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.ok, true);
  } finally {
    await mod.stop();
  }
});

test('核心身份可直接装配 sendVerification/isConfigured', async () => {
  const transport = recordingTransport();
  const mod = await boot({ from: FROM, transport });
  try {
    assert.equal(mod.isAvailable(), true);
    assert.equal(mod.isConfigured(), true);
    const result = await mod.sendVerification({
      to: 'new-user@example.test',
      code: '654321',
      purpose: 'register'
    });
    assert.equal(result.ok, true);
    assert.equal(transport.calls.length, 1);
    assert.deepEqual(transport.calls[0].to, ['new-user@example.test']);
    assert.match(transport.calls[0].text, /654321/);
  } finally {
    await mod.stop();
  }
});

test('dataFile 持久化：重启后同一幂等键不重复发信', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pagesai-mail-'));
  const dataFile = path.join(directory, 'mail.json');
  try {
    const firstTransport = recordingTransport();
    const firstModule = await boot(configured(firstTransport, { dataFile }));
    const body = {
      to: 'target@example.test',
      subject: 'Persist',
      text: 'Body',
      idempotencyKey: 'persist-1'
    };
    const first = await invoke(firstModule, 'POST', '/api/mail/send', { user: user(), body });
    assert.equal(first.status, 200);
    await firstModule.stop();
    assert.equal(fs.existsSync(dataFile), true);

    const secondTransport = recordingTransport();
    const secondModule = await boot(configured(secondTransport, { dataFile }));
    try {
      const second = await invoke(secondModule, 'POST', '/api/mail/send', { user: user(), body });
      assert.equal(second.status, 200);
      assert.deepEqual(second.body, first.body);
      assert.equal(secondTransport.calls.length, 0);
    } finally {
      await secondModule.stop();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
