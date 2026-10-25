'use strict';
// 公共身份服务：注册、登录、持久会话、邮箱挑战与单层管理员。
// 所有存储访问均为异步；初始化、最后管理员及停用撤销在适配器事务内完成。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { CoreError, codes } = require('../errors');
const { assertPasswordPolicy, hashPassword, verifyPassword } = require('./passwords');
const { normalizeUsername, sha256 } = require('./store');

const ROLES = Object.freeze(['user', 'admin']);
const USERNAME_MIN = 3;
const USERNAME_MAX = 32;
const DEFAULT_RESERVED = Object.freeze([
  'admin', 'administrator', 'root', 'system', 'support', 'pagesai', 'official', 'noreply'
]);
const VERIFICATION_TTL_MS = 10 * 60 * 1000;
const VERIFICATION_MAX_ATTEMPTS = 5;
const VERIFICATION_WINDOW_MS = 10 * 60 * 1000;
const VERIFICATION_MAX_PER_WINDOW = 5;

function emailKey(email) {
  return String(email).normalize('NFKC').trim().toLowerCase();
}

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const value = email.trim();
  if (value.length < 3 || value.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function assertUsernamePolicy(username, reserved) {
  if (typeof username !== 'string') throw new CoreError(codes.INVALID_INPUT, '用户名必须是字符串', { status: 400 });
  const value = username.trim();
  if (value.length < USERNAME_MIN || value.length > USERNAME_MAX) {
    throw new CoreError(codes.INVALID_INPUT, `用户名长度必须在 ${USERNAME_MIN}–${USERNAME_MAX} 之间`, { status: 400 });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/.test(value)) {
    throw new CoreError(codes.INVALID_INPUT, '用户名只能包含字母、数字、点、下划线与连字符，且不能以符号开头或结尾', { status: 400 });
  }
  if (reserved.has(normalizeUsername(value))) {
    throw new CoreError(codes.USERNAME_RESERVED, '该用户名被保留', { status: 400 });
  }
  return value;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    email: user.email,
    emailVerified: Boolean(user.emailVerified),
    createdAt: user.createdAt
  };
}

function errorResult(code, message, status) {
  return { error: new CoreError(code, message, { status }) };
}

class IdentityService {
  constructor({ store, clock = () => Date.now(), mail = null, reservedUsernames = [], snapshotPath = null } = {}) {
    if (!store) throw new CoreError(codes.INVALID_INPUT, 'identity service 需要 store', { status: 500 });
    this.store = store;
    this.clock = clock;
    this.mail = mail;
    this.reserved = new Set([...DEFAULT_RESERVED, ...reservedUsernames.map(normalizeUsername)]);
    this.snapshotPath = snapshotPath;
    this.registration = { enabled: true, requireEmailVerification: false, allowedEmailDomains: null };
    this.sessionTtlMs = 7 * 24 * 3600 * 1000;
  }

  /**
   * 身份权威数据在 MongoDB；备份/恢复工具只读文件快照。
   * 因此每次身份写操作后导出 <dataRoot>/state/identity.json（0600、原子替换），
   * 供 tools/backup.js 与 tools/restore.js 校验用户归属。导出失败不回滚已提交的身份变更，
   * 但必须显式告警，避免备份悄悄失去归属校验依据。
   */
  async writeSnapshot() {
    if (!this.snapshotPath) return null;
    try {
      const users = await this.store.listUsers();
      const payload = {
        formatVersion: 1,
        updatedAt: new Date(this.clock()).toISOString(),
        users: Object.fromEntries(users.map((user) => [user.id, {
          id: user.id,
          username: user.username,
          email: user.email || null,
          role: user.role,
          status: user.status,
          createdAt: user.createdAt
        }]))
      };
      const target = path.resolve(this.snapshotPath);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const temp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temp, target);
      return payload;
    } catch (error) {
      process.stderr.write(`[identity] 身份快照写入失败（备份归属校验将不完整）：${error && error.message ? error.message : error}\n`);
      return null;
    }
  }

  configureRegistration({ enabled, requireEmailVerification, allowedEmailDomains, sessionTtlMs } = {}) {
    if (typeof enabled === 'boolean') this.registration.enabled = enabled;
    if (typeof requireEmailVerification === 'boolean') this.registration.requireEmailVerification = requireEmailVerification;
    if (allowedEmailDomains === null || Array.isArray(allowedEmailDomains)) {
      this.registration.allowedEmailDomains = allowedEmailDomains === null ? null : allowedEmailDomains.map((domain) => String(domain).toLowerCase());
    }
    if (Number.isSafeInteger(sessionTtlMs) && sessionTtlMs > 0) this.sessionTtlMs = sessionTtlMs;
    return { ...this.registration };
  }

  mailReady() {
    if (!this.mail) return false;
    const available = typeof this.mail.isAvailable === 'function' ? this.mail.isAvailable() : Boolean(this.mail.available);
    const configured = typeof this.mail.isConfigured === 'function' ? this.mail.isConfigured() : Boolean(this.mail.configured);
    return Boolean(available && configured);
  }

  async register({ username, password, email } = {}, { ip = null } = {}) {
    if (!this.registration.enabled) {
      throw new CoreError(codes.REGISTRATION_CLOSED, '公开注册已关闭', { status: 403 });
    }
    const requireEmail = this.registration.requireEmailVerification;
    if (requireEmail) {
      if (!this.mail) throw new CoreError(codes.MAIL_MODULE_REQUIRED, '启用邮箱验证注册需要先安装 Mail 模块', { status: 409 });
      if (!this.mailReady()) throw new CoreError(codes.MAIL_NOT_CONFIGURED, 'Mail 模块尚未配置发信，无法启用邮箱验证注册', { status: 409 });
      if (!isValidEmail(email)) throw new CoreError(codes.INVALID_INPUT, '邮箱格式不正确', { status: 400 });
      const domains = this.registration.allowedEmailDomains;
      if (Array.isArray(domains) && domains.length > 0) {
        const domain = emailKey(email).split('@')[1];
        if (!domains.includes(domain)) throw new CoreError(codes.INVALID_INPUT, '该邮箱域名不允许注册', { status: 400 });
      }
    }
    const name = assertUsernamePolicy(username, this.reserved);
    assertPasswordPolicy(password);
    if (await this.store.getUserByNormalizedName(name)) {
      throw new CoreError(codes.USERNAME_TAKEN, '用户名已被占用', { status: 409 });
    }

    const passwordHash = await hashPassword(password);
    const user = await this.store.createUser({
      username: name,
      passwordHash,
      role: 'user',
      email: requireEmail ? emailKey(email) : null,
      emailVerified: !requireEmail,
      status: requireEmail ? 'pending_email' : 'active'
    });
    await this.writeSnapshot();
    if (requireEmail) {
      await this.issueVerification(user.email, 'register', { ip });
      return { user: publicUser(user), verificationRequired: true };
    }
    return { user: publicUser(user), verificationRequired: false };
  }

  async issueVerification(target, purpose, { ip = null } = {}) {
    if (!this.mailReady()) throw new CoreError(codes.MAIL_NOT_CONFIGURED, 'Mail 模块尚未配置发信', { status: 409 });
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const record = await this.store.withTransaction(async (tx) => {
      const existing = await this.store.getVerification(target, purpose, { tx });
      const now = this.clock();
      const windowStart = existing && Number.isFinite(existing.windowStart) ? existing.windowStart : now;
      const sent = existing && Number.isFinite(existing.sent) ? existing.sent : 0;
      if (now - windowStart < VERIFICATION_WINDOW_MS && sent >= VERIFICATION_MAX_PER_WINDOW) {
        throw new CoreError(codes.VERIFICATION_RATE_LIMITED, '验证码发送过于频繁，请稍后再试', { status: 429 });
      }
      const next = {
        codeHash: sha256(code),
        expiresAt: now + VERIFICATION_TTL_MS,
        attempts: 0,
        sent: now - windowStart < VERIFICATION_WINDOW_MS ? sent + 1 : 1,
        windowStart: now - windowStart < VERIFICATION_WINDOW_MS ? windowStart : now,
        ip
      };
      await this.store.putVerification(target, purpose, next, { tx });
      return next;
    });
    // 发信失败不会把挑战标成已验证；持久挑战保留，便于明确重试与审计。
    await this.mail.sendVerification({ to: target, code, purpose });
    return { sent: true, expiresInSeconds: Math.floor(VERIFICATION_TTL_MS / 1000), expiresAt: record.expiresAt };
  }

  async verifyEmail({ email, code } = {}) {
    if (!isValidEmail(email)) throw new CoreError(codes.INVALID_INPUT, '邮箱格式不正确', { status: 400 });
    const target = emailKey(email);
    const outcome = await this.store.withTransaction(async (tx) => {
      const record = await this.store.getVerification(target, 'register', { tx });
      if (!record) return errorResult(codes.VERIFICATION_INVALID, '验证码无效或已过期', 400);
      if (this.clock() > record.expiresAt) {
        await this.store.deleteVerification(target, 'register', { tx });
        return errorResult(codes.VERIFICATION_INVALID, '验证码无效或已过期', 400);
      }
      if (record.attempts >= VERIFICATION_MAX_ATTEMPTS) {
        await this.store.deleteVerification(target, 'register', { tx });
        return errorResult(codes.VERIFICATION_RATE_LIMITED, '验证码尝试次数过多，请重新获取', 429);
      }
      const next = { ...record, attempts: record.attempts + 1 };
      const provided = sha256(String(code || ''));
      const expected = Buffer.from(record.codeHash);
      const actual = Buffer.from(provided);
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        await this.store.putVerification(target, 'register', next, { tx });
        return errorResult(codes.VERIFICATION_INVALID, '验证码无效或已过期', 400);
      }
      const user = await this.store.findUserByEmail(target, 'pending_email', { tx });
      if (!user) return errorResult(codes.NOT_FOUND, '待验证账号不存在', 404);
      const updated = await this.store.updateUser(user.id, user.version, { emailVerified: true, status: 'active' }, { tx });
      await this.store.deleteVerification(target, 'register', { tx });
      return { user: updated };
    });
    if (outcome.error) throw outcome.error;
    await this.writeSnapshot();
    return { user: publicUser(outcome.user) };
  }

  async login({ username, password } = {}) {
    const user = await this.store.getUserByNormalizedName(String(username || ''));
    if (!user) throw new CoreError(codes.INVALID_CREDENTIALS, '用户名或密码错误', { status: 401 });
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) throw new CoreError(codes.INVALID_CREDENTIALS, '用户名或密码错误', { status: 401 });
    if (user.status === 'disabled') throw new CoreError(codes.ACCOUNT_DISABLED, '账号已被停用', { status: 403 });
    if (user.status === 'pending_email') throw new CoreError(codes.EMAIL_UNVERIFIED, '邮箱尚未验证', { status: 403 });
    const token = crypto.randomBytes(32).toString('base64url');
    const createdAt = new Date(this.clock()).toISOString();
    const expiresAt = new Date(this.clock() + this.sessionTtlMs).toISOString();
    const session = await this.store.createSession({
      tokenHash: sha256(token),
      userId: user.id,
      authVersion: user.authVersion,
      createdAt,
      expiresAt,
      revokedAt: null
    });
    return { user: publicUser(user), token, expiresAt: session.expiresAt };
  }

  async authenticate(token, { tx } = {}) {
    if (typeof token !== 'string' || token.length === 0) {
      throw new CoreError(codes.SESSION_INVALID, '会话无效', { status: 401 });
    }
    const tokenHash = sha256(token);
    const session = await this.store.getSession(tokenHash, { tx });
    if (!session) throw new CoreError(codes.SESSION_INVALID, '会话无效', { status: 401 });
    if (session.revokedAt) throw new CoreError(codes.SESSION_REVOKED, '会话已被撤销', { status: 401 });
    if (this.clock() > Date.parse(session.expiresAt)) {
      await this.store.revokeSession(tokenHash, new Date(this.clock()).toISOString(), { tx });
      throw new CoreError(codes.SESSION_INVALID, '会话已过期', { status: 401 });
    }
    const user = await this.store.getUserById(session.userId, { tx });
    if (!user) throw new CoreError(codes.SESSION_INVALID, '会话无效', { status: 401 });
    if (user.status === 'disabled') throw new CoreError(codes.ACCOUNT_DISABLED, '账号已被停用', { status: 403 });
    if (session.authVersion !== user.authVersion) throw new CoreError(codes.SESSION_REVOKED, '会话已被撤销', { status: 401 });
    return publicUser(user);
  }

  async logout(token) {
    const removed = await this.store.revokeSession(sha256(token), new Date(this.clock()).toISOString());
    if (!removed) throw new CoreError(codes.SESSION_INVALID, '会话无效', { status: 401 });
    return { ok: true };
  }

  async revokeAllSessions(userId) {
    return this.store.withTransaction(async (tx) => {
      const user = await this.store.getUserById(userId, { tx });
      if (!user) throw new CoreError(codes.NOT_FOUND, '用户不存在', { status: 404 });
      await this.store.updateUser(userId, user.version, { authVersion: user.authVersion + 1 }, { tx });
      await this.store.revokeUserSessions(userId, new Date(this.clock()).toISOString(), { tx });
      return { ok: true };
    });
  }

  async requireAdmin(token, { tx } = {}) {
    const user = await this.authenticate(token, { tx });
    if (user.role !== 'admin') throw new CoreError(codes.FORBIDDEN, '需要管理员权限', { status: 403 });
    return user;
  }

  async bootstrapAdmin({ username, password } = {}) {
    const name = assertUsernamePolicy(username, this.reserved);
    assertPasswordPolicy(password);
    const passwordHash = await hashPassword(password);
    const user = await this.store.withTransaction(async (tx) => {
      await this.store.acquireWriteLock({ tx });
      const control = await this.store.getBootstrapControl({ tx });
      const admins = await this.store.countActiveAdmins({ tx });
      if (control.closed || admins > 0) {
        throw new CoreError(codes.BOOTSTRAP_CLOSED, '管理员引导已关闭', { status: 409 });
      }
      if (await this.store.getUserByNormalizedName(name, { tx })) {
        throw new CoreError(codes.USERNAME_TAKEN, '用户名已被占用', { status: 409 });
      }
      const closed = await this.store.closeBootstrapOnce({ closedAt: new Date(this.clock()).toISOString() }, { tx });
      if (!closed) throw new CoreError(codes.BOOTSTRAP_CLOSED, '管理员引导已关闭', { status: 409 });
      return this.store.createUser({
        username: name,
        passwordHash,
        role: 'admin',
        emailVerified: true,
        status: 'active'
      }, { tx });
    });
    await this.writeSnapshot();
    return { user: publicUser(user) };
  }

  async listUsers(token) {
    return this.store.withTransaction(async (tx) => {
      await this.requireAdmin(token, { tx });
      const users = await this.store.listUsers({ tx });
      return users.map(publicUser);
    });
  }

  async setRole(token, userId, role) {
    if (!ROLES.includes(role)) throw new CoreError(codes.INVALID_INPUT, '角色只能是 user 或 admin', { status: 400 });
    const updated = await this.store.withTransaction(async (tx) => {
      await this.store.acquireWriteLock({ tx });
      await this.requireAdmin(token, { tx });
      const target = await this.store.getUserById(userId, { tx });
      if (!target) throw new CoreError(codes.NOT_FOUND, '用户不存在', { status: 404 });
      if (target.role === 'admin' && role !== 'admin' && await this.store.countActiveAdmins({ tx }) <= 1) {
        throw new CoreError(codes.LAST_ADMIN_PROTECTED, '不能降级最后一名有效管理员', { status: 409 });
      }
      return this.store.updateUser(userId, target.version, { role }, { tx });
    });
    await this.writeSnapshot();
    return { user: publicUser(updated) };
  }

  async setStatus(token, userId, status) {
    if (!['active', 'disabled'].includes(status)) throw new CoreError(codes.INVALID_INPUT, '状态无效', { status: 400 });
    const revokedAt = new Date(this.clock()).toISOString();
    const updated = await this.store.withTransaction(async (tx) => {
      await this.store.acquireWriteLock({ tx });
      await this.requireAdmin(token, { tx });
      const target = await this.store.getUserById(userId, { tx });
      if (!target) throw new CoreError(codes.NOT_FOUND, '用户不存在', { status: 404 });
      if (target.role === 'admin' && status === 'disabled' && await this.store.countActiveAdmins({ tx }) <= 1) {
        throw new CoreError(codes.LAST_ADMIN_PROTECTED, '不能停用最后一名有效管理员', { status: 409 });
      }
      const patch = status === 'disabled' && target.status !== 'disabled'
        ? { status, authVersion: target.authVersion + 1 }
        : { status };
      const next = await this.store.updateUser(userId, target.version, patch, { tx });
      if (status === 'disabled') await this.store.revokeUserSessions(userId, revokedAt, { tx });
      return next;
    });
    await this.writeSnapshot();
    return { user: publicUser(updated) };
  }

  async deleteUser(token, userId) {
    await this.store.withTransaction(async (tx) => {
      await this.store.acquireWriteLock({ tx });
      await this.requireAdmin(token, { tx });
      const target = await this.store.getUserById(userId, { tx });
      if (!target) throw new CoreError(codes.NOT_FOUND, '用户不存在', { status: 404 });
      if (target.role === 'admin' && await this.store.countActiveAdmins({ tx }) <= 1) {
        throw new CoreError(codes.LAST_ADMIN_PROTECTED, '不能删除最后一名有效管理员', { status: 409 });
      }
      await this.store.deleteUser(userId, target.version, { tx });
      await this.store.revokeUserSessions(userId, new Date(this.clock()).toISOString(), { tx });
    });
    await this.writeSnapshot();
    return { ok: true };
  }
}

module.exports = {
  IdentityService,
  ROLES,
  assertUsernamePolicy,
  isValidEmail,
  publicUser,
  USERNAME_MIN,
  USERNAME_MAX,
  VERIFICATION_TTL_MS
};
