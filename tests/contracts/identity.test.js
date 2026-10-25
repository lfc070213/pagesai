'use strict';
// 公共身份契约：异步适配器、注册、会话撤销、最后管理员保护。
// 运行：node --test tests/contracts/identity.test.js（仅 Node 内置模块）。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const coreRoot = path.join(__dirname, '..', '..', 'core');
const { IdentityService } = require(path.join(coreRoot, 'identity', 'service.js'));
const { InMemoryIdentityStore, sha256 } = require(path.join(coreRoot, 'identity', 'store.js'));
const { codes } = require(path.join(coreRoot, 'errors.js'));

function makeService(overrides = {}) {
  const clock = { at: Date.UTC(2026, 0, 1) };
  const store = new InMemoryIdentityStore({ clock: () => clock.at });
  const sent = [];
  const mail = {
    available: true,
    configured: true,
    isAvailable() { return this.available; },
    isConfigured() { return this.configured; },
    async sendVerification(input) { sent.push(input); }
  };
  const service = new IdentityService({ store, clock: () => clock.at, mail, ...overrides });
  return { service, store, clock, sent, mail };
}

test('默认用户名密码注册后可登录、取回自身信息、退出', async () => {
  const { service } = makeService();
  const { user, verificationRequired } = await service.register({ username: 'alice', password: 'correct horse battery' });
  assert.equal(verificationRequired, false);
  assert.equal(user.role, 'user');
  assert.equal(user.status, 'active');

  const login = await service.login({ username: 'Alice', password: 'correct horse battery' });
  assert.ok(login.token.length > 20);
  assert.equal(login.user.id, user.id);
  assert.equal((await service.authenticate(login.token)).username, 'alice');
  assert.deepEqual(await service.logout(login.token), { ok: true });
  await assert.rejects(service.authenticate(login.token), (err) => err.code === codes.SESSION_REVOKED);
});

test('口令不落明文且用户版本条件更新防止丢失写入', async () => {
  const { service, store } = makeService();
  const { user } = await service.register({ username: 'bob', password: 'a-very-good-password' });
  const stored = await store.getUserById(user.id);
  assert.match(stored.passwordHash, /^scrypt\$/);
  assert.equal(stored.passwordHash.includes('a-very-good-password'), false);
  assert.equal(stored.version, 0);
  const updated = await store.updateUser(user.id, 0, { email: 'bob@example.com' });
  assert.equal(updated.version, 1);
  await assert.rejects(store.updateUser(user.id, 0, { email: 'other@example.com' }), (err) => err.code === codes.CONFLICT);
});

test('用户名大小写不敏感唯一，弱口令被拒', async () => {
  const { service } = makeService();
  await service.register({ username: 'carol', password: 'password-1234' });
  await assert.rejects(service.register({ username: 'CAROL', password: 'password-1234' }), (err) => err.code === codes.USERNAME_TAKEN);
  await assert.rejects(service.register({ username: 'dave', password: 'short' }), (err) => err.code === codes.WEAK_PASSWORD);
  await assert.rejects(service.register({ username: 'root', password: 'password-1234' }), (err) => err.code === codes.USERNAME_RESERVED);
});

test('注册关闭后拒绝新注册，但既有账号仍可登录', async () => {
  const { service } = makeService();
  await service.register({ username: 'erin', password: 'password-1234' });
  service.configureRegistration({ enabled: false });
  await assert.rejects(service.register({ username: 'frank', password: 'password-1234' }), (err) => err.code === codes.REGISTRATION_CLOSED);
  assert.ok((await service.login({ username: 'erin', password: 'password-1234' })).token);
});

test('邮箱注册必须有 Mail 模块且已配置发信，否则明确失败', async () => {
  const noMail = makeService({ mail: null });
  noMail.service.configureRegistration({ requireEmailVerification: true });
  await assert.rejects(
    noMail.service.register({ username: 'gina', password: 'password-1234', email: 'gina@example.com' }),
    (err) => err.code === codes.MAIL_MODULE_REQUIRED
  );

  const unconfigured = makeService();
  unconfigured.mail.configured = false;
  unconfigured.service.configureRegistration({ requireEmailVerification: true });
  await assert.rejects(
    unconfigured.service.register({ username: 'gina', password: 'password-1234', email: 'gina@example.com' }),
    (err) => err.code === codes.MAIL_NOT_CONFIGURED
  );
});

test('邮箱注册：验证码正确才激活，错误码持久计入尝试次数', async () => {
  const { service, sent, store } = makeService();
  service.configureRegistration({ requireEmailVerification: true });
  const { user, verificationRequired } = await service.register({ username: 'hana', password: 'password-1234', email: 'Hana@Example.com' });
  assert.equal(verificationRequired, true);
  assert.equal(user.status, 'pending_email');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'hana@example.com');

  await assert.rejects(service.login({ username: 'hana', password: 'password-1234' }), (err) => err.code === codes.EMAIL_UNVERIFIED);
  await assert.rejects(service.verifyEmail({ email: 'hana@example.com', code: '000000' }), (err) => err.code === codes.VERIFICATION_INVALID);
  assert.equal((await store.getVerification('hana@example.com', 'register')).attempts, 1);

  const activated = await service.verifyEmail({ email: 'hana@example.com', code: sent[0].code });
  assert.equal(activated.user.status, 'active');
  assert.ok((await service.login({ username: 'hana', password: 'password-1234' })).token);
  assert.equal((await store.getUserById(user.id)).emailVerified, true);
  assert.equal(await store.getVerification('hana@example.com', 'register'), null);
});

test('邮箱注册在 Mail 故障时不激活用户也不伪造验证成功', async () => {
  const { service, store, mail } = makeService();
  service.configureRegistration({ requireEmailVerification: true });
  mail.sendVerification = async () => { throw new Error('smtp down'); };
  await assert.rejects(
    service.register({ username: 'iris', password: 'password-1234', email: 'iris@example.com' }),
    /smtp down/
  );
  const user = await store.getUserByNormalizedName('iris');
  assert.equal(user.status, 'pending_email');
  assert.equal(user.emailVerified, false);
  assert.ok(await store.getVerification('iris@example.com', 'register'));
});

test('最后管理员不可删除、停用或降级；有两名管理员时允许', async () => {
  const { service } = makeService();
  const { user: admin } = await service.bootstrapAdmin({ username: 'boss', password: 'password-1234' });
  const login = await service.login({ username: 'boss', password: 'password-1234' });

  await assert.rejects(service.deleteUser(login.token, admin.id), (err) => err.code === codes.LAST_ADMIN_PROTECTED);
  await assert.rejects(service.setStatus(login.token, admin.id, 'disabled'), (err) => err.code === codes.LAST_ADMIN_PROTECTED);
  await assert.rejects(service.setRole(login.token, admin.id, 'user'), (err) => err.code === codes.LAST_ADMIN_PROTECTED);

  const { user: plain } = await service.register({ username: 'kid', password: 'password-1234' });
  await service.setRole(login.token, plain.id, 'admin');
  assert.equal((await service.listUsers(login.token)).filter((u) => u.role === 'admin').length, 2);
  assert.equal((await service.setRole(login.token, plain.id, 'user')).user.role, 'user');
});

test('并发引导只产生一个管理员，其余请求被拒绝', async () => {
  const { service, store } = makeService();
  const results = await Promise.allSettled([
    service.bootstrapAdmin({ username: 'one', password: 'password-1234' }),
    service.bootstrapAdmin({ username: 'two', password: 'password-1234' }),
    service.bootstrapAdmin({ username: 'three', password: 'password-1234' })
  ]);
  const ok = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(rejected.length, 2);
  assert.equal(await store.countActiveAdmins(), 1);
  rejected.forEach((result) => assert.equal(result.reason.code, codes.BOOTSTRAP_CLOSED));
});

test('会话撤销：revokeAllSessions 后旧 Token 立即失效', async () => {
  const { service } = makeService();
  const { user } = await service.register({ username: 'jane', password: 'password-1234' });
  const a = await service.login({ username: 'jane', password: 'password-1234' });
  const b = await service.login({ username: 'jane', password: 'password-1234' });
  assert.ok(await service.authenticate(a.token));
  await service.revokeAllSessions(user.id);
  await assert.rejects(service.authenticate(a.token), (err) => err.code === codes.SESSION_REVOKED);
  await assert.rejects(service.authenticate(b.token), (err) => err.code === codes.SESSION_REVOKED);
});

test('会话过期与停用账号都会被拒绝，停用同时撤销全部会话', async () => {
  const { service, clock } = makeService();
  await service.register({ username: 'kyle', password: 'password-1234' });
  const login = await service.login({ username: 'kyle', password: 'password-1234' });
  clock.at += 8 * 24 * 3600 * 1000;
  await assert.rejects(service.authenticate(login.token), (err) => err.code === codes.SESSION_INVALID);

  const second = makeService();
  await second.service.bootstrapAdmin({ username: 'root2', password: 'password-1234' });
  const adminLogin = await second.service.login({ username: 'root2', password: 'password-1234' });
  const { user: other } = await second.service.register({ username: 'nina', password: 'password-1234' });
  await second.service.setRole(adminLogin.token, other.id, 'admin');
  const otherLogin = await second.service.login({ username: 'nina', password: 'password-1234' });
  await second.service.setStatus(adminLogin.token, other.id, 'disabled');
  assert.ok((await second.store.getSession(sha256(otherLogin.token))).revokedAt);
  await assert.rejects(second.service.login({ username: 'nina', password: 'password-1234' }), (err) => err.code === codes.ACCOUNT_DISABLED);
  await assert.rejects(second.service.authenticate(otherLogin.token), (err) => err.code === codes.SESSION_REVOKED);
});

test('管理员接口越权检查：普通用户调用被拒', async () => {
  const { service } = makeService();
  await service.bootstrapAdmin({ username: 'boss2', password: 'password-1234' });
  await service.register({ username: 'mike', password: 'password-1234' });
  const userLogin = await service.login({ username: 'mike', password: 'password-1234' });
  await assert.rejects(service.listUsers(userLogin.token), (err) => err.code === codes.FORBIDDEN);
  await assert.rejects(service.requireAdmin(userLogin.token), (err) => err.code === codes.FORBIDDEN);
});
