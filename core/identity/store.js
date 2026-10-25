'use strict';
// 身份存储公共契约与仅供测试的内存实现。
// 正式入口使用 mongo-store.js；这里不暴露同步 Map 作为正式适配器接口。

const crypto = require('node:crypto');
const { CoreError, codes } = require('../errors');

const SESSION_COOKIE = 'pagesai_sid';

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

function normalizeUsername(username) {
  return String(username).normalize('NFKC').trim().toLowerCase();
}

function clone(value) {
  return value === null || value === undefined ? value : { ...value };
}

function conflict(message = '记录已被并发修改') {
  return new CoreError(codes.CONFLICT, message, { status: 409 });
}

function notFound(message = '用户不存在') {
  return new CoreError(codes.NOT_FOUND, message, { status: 404 });
}

function verificationKey(target, purpose) {
  return `${purpose}:${target}`;
}

/**
 * 仅供测试的异步内存适配器。
 *
 * 写事务通过进程内 Promise 锁串行执行；与 Mongo 适配器一样，调用方必须
 * 在回调内把 tx 传给每个读写方法。它不提供跨进程或重启持久性。
 */
class InMemoryIdentityStore {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.users = new Map();
    this.usernameIndex = new Map();
    this.sessions = new Map();
    this.verifications = new Map();
    this.bootstrapControl = null;
    this.writeTail = Promise.resolve();
  }

  get bootstrapDone() {
    return Boolean(this.bootstrapControl && this.bootstrapControl.closed);
  }

  async withTransaction(callback) {
    const run = async () => {
      const tx = { memory: this };
      return callback(tx);
    };
    const result = this.writeTail.then(run, run);
    this.writeTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async acquireWriteLock() {
    // withTransaction 已串行化内存写事务。
  }

  async createUser(input) {
    const usernameKey = normalizeUsername(input.username);
    if (this.usernameIndex.has(usernameKey)) {
      throw new CoreError(codes.USERNAME_TAKEN, '用户名已被占用', { status: 409 });
    }
    const timestamp = nowIso(this.clock);
    const user = {
      id: input.id || crypto.randomUUID(),
      username: input.username,
      usernameKey,
      passwordHash: input.passwordHash,
      role: input.role || 'user',
      status: input.status || 'active',
      email: input.email === undefined ? null : input.email,
      emailVerified: Boolean(input.emailVerified),
      authVersion: input.authVersion || 0,
      version: input.version || 0,
      createdAt: input.createdAt || timestamp,
      updatedAt: input.updatedAt || timestamp
    };
    if (this.users.has(user.id)) throw conflict('用户 ID 已存在');
    this.users.set(user.id, user);
    this.usernameIndex.set(usernameKey, user.id);
    return clone(user);
  }

  async getUserById(userId) {
    return clone(this.users.get(userId) || null);
  }

  async getUserByNormalizedName(username) {
    const id = this.usernameIndex.get(normalizeUsername(username));
    return clone((id && this.users.get(id)) || null);
  }

  async findById(userId, options) {
    return this.getUserById(userId, options);
  }

  async findByUsername(username, options) {
    return this.getUserByNormalizedName(username, options);
  }

  async findUserByEmail(email, status) {
    return clone([...this.users.values()].find((user) => user.email === email && (!status || user.status === status)) || null);
  }

  async listUsers() {
    return [...this.users.values()].map(clone);
  }

  async countActiveAdmins() {
    let count = 0;
    for (const user of this.users.values()) {
      if (user.role === 'admin' && user.status === 'active') count += 1;
    }
    return count;
  }

  async countAdmins(options) {
    return this.countActiveAdmins(options);
  }

  async updateUser(userId, expectedVersion, patch) {
    const user = this.users.get(userId);
    if (!user) throw notFound();
    if (user.version !== expectedVersion) throw conflict();
    const next = { ...user, ...patch };
    if (patch.username !== undefined) {
      const usernameKey = normalizeUsername(patch.username);
      const existing = this.usernameIndex.get(usernameKey);
      if (existing && existing !== userId) {
        throw new CoreError(codes.USERNAME_TAKEN, '用户名已被占用', { status: 409 });
      }
      this.usernameIndex.delete(user.usernameKey);
      next.usernameKey = usernameKey;
      this.usernameIndex.set(usernameKey, userId);
    }
    next.id = user.id;
    next.createdAt = user.createdAt;
    next.version = user.version + 1;
    next.updatedAt = nowIso(this.clock);
    this.users.set(userId, next);
    return clone(next);
  }

  async deleteUser(userId, expectedVersion) {
    const user = this.users.get(userId);
    if (!user) throw notFound();
    if (expectedVersion !== undefined && user.version !== expectedVersion) throw conflict();
    this.users.delete(userId);
    this.usernameIndex.delete(user.usernameKey);
    return true;
  }

  async createSession(session) {
    if (this.sessions.has(session.tokenHash)) throw conflict('会话已存在');
    const record = { revokedAt: null, ...session };
    this.sessions.set(record.tokenHash, record);
    return clone(record);
  }

  async getSession(tokenHash) {
    return clone(this.sessions.get(tokenHash) || null);
  }

  async findSessionByToken(token) {
    if (typeof token !== 'string' || token.length === 0) return null;
    return this.getSession(sha256(token));
  }

  async revokeSession(tokenHash, revokedAt) {
    const session = this.sessions.get(tokenHash);
    if (!session) return false;
    if (!session.revokedAt) this.sessions.set(tokenHash, { ...session, revokedAt });
    return true;
  }

  async deleteSession(token) {
    return this.revokeSession(sha256(token), nowIso(this.clock));
  }

  async revokeUserSessions(userId, revokedAt) {
    let count = 0;
    for (const [tokenHash, session] of this.sessions) {
      if (session.userId === userId && !session.revokedAt) {
        this.sessions.set(tokenHash, { ...session, revokedAt });
        count += 1;
      }
    }
    return count;
  }

  async deleteSessionsForUser(userId) {
    return this.revokeUserSessions(userId, nowIso(this.clock));
  }

  async putVerification(target, purpose, record) {
    this.verifications.set(verificationKey(target, purpose), { ...record });
    return clone(record);
  }

  async getVerification(target, purpose) {
    return clone(this.verifications.get(verificationKey(target, purpose)) || null);
  }

  async deleteVerification(target, purpose) {
    return this.verifications.delete(verificationKey(target, purpose));
  }

  async getBootstrapControl() {
    return clone(this.bootstrapControl || { id: 'admin-bootstrap', closed: false });
  }

  async closeBootstrapOnce(record) {
    if (this.bootstrapDone) return false;
    this.bootstrapControl = {
      ...(this.bootstrapControl || {}),
      ...record,
      id: 'admin-bootstrap',
      closed: true,
      closedAt: record.closedAt || nowIso(this.clock)
    };
    return true;
  }

  async close() {}
}

module.exports = {
  InMemoryIdentityStore,
  normalizeUsername,
  sha256,
  SESSION_COOKIE,
  conflict,
  notFound,
  verificationKey
};
