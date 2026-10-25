'use strict';
// MongoDB 身份与运行时元数据适配器。
// 所有跨记录身份写入都必须使用 withTransaction；正式部署需要 replica set。

const crypto = require('node:crypto');
const { CoreError, codes } = require('../errors');
const { normalizeUsername, conflict, notFound, verificationKey } = require('./store');

const IDENTITY_SCHEMA_VERSION = 1;
const COLLECTIONS = Object.freeze({
  users: 'identity_users',
  sessions: 'identity_sessions',
  challenges: 'identity_challenges',
  controls: 'identity_controls',
  metadata: 'runtime_metadata',
  migrations: 'runtime_migrations'
});

function duplicateKey(error) {
  return Boolean(error && (error.code === 11000 || error.code === 11001));
}

function configError(message, details = null) {
  return new CoreError(codes.CONFIG_INVALID, message, { status: 500, details });
}

function sessionOf(options) {
  return options && options.tx ? options.tx.session : undefined;
}

function operationOptions(options) {
  const session = sessionOf(options);
  return session ? { session } : {};
}

function publicDocument(document) {
  if (!document) return null;
  const { _id, ...record } = document;
  return record;
}

class MongoIdentityStore {
  constructor({
    uri,
    dbName = 'pagesai',
    clock = () => Date.now(),
    client = null,
    clientOptions = {},
    mongo = null
  } = {}) {
    if (!uri && !client) throw configError('MongoDB 适配器需要连接 URI');
    this.uri = uri;
    this.dbName = dbName;
    this.clock = clock;
    this.client = client;
    this.clientOptions = { maxPoolSize: 20, ...clientOptions };
    this.mongo = mongo;
    this.ownsClient = !client;
    this.db = null;
    this.collections = null;
    this.migrated = false;
  }

  async connect() {
    if (this.db) return this.db;
    if (!this.client) {
      let MongoClient;
      try {
        ({ MongoClient } = this.mongo || require('mongodb'));
      } catch {
        throw configError('未安装 mongodb 驱动；正式启动不能回落到内存存储');
      }
      this.client = new MongoClient(this.uri, this.clientOptions);
    }
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.collections = Object.fromEntries(
      Object.entries(COLLECTIONS).map(([key, name]) => [key, this.db.collection(name)])
    );
    return this.db;
  }

  async getSchemaVersion() {
    await this.connect();
    const metadata = await this.collections.metadata.findOne({ _id: 'runtime' });
    return metadata ? metadata.schemaVersion : null;
  }

  /**
   * 校验部署身份并迁移到当前版本。
   * 空数据库只有显式 allowInitialize=true 才可登记，避免连错空库后自动服务。
   */
  async migrate({ targetVersion = IDENTITY_SCHEMA_VERSION, deploymentId, allowInitialize = false } = {}) {
    if (targetVersion !== IDENTITY_SCHEMA_VERSION) {
      throw configError('不支持的身份模式版本', { targetVersion, supportedVersion: IDENTITY_SCHEMA_VERSION });
    }
    if (typeof deploymentId !== 'string' || deploymentId.length === 0) {
      throw configError('MongoDB 启动需要 deploymentId');
    }
    await this.connect();
    const now = new Date(this.clock()).toISOString();
    let metadata = await this.collections.metadata.findOne({ _id: 'runtime' });
    if (!metadata) {
      if (!allowInitialize) {
        throw configError('数据库尚未登记部署；拒绝自动创建空生产库');
      }
      const existingCollections = await this.db.listCollections({}, { nameOnly: true }).toArray();
      if (existingCollections.length > 0) {
        throw configError('非空数据库缺少部署元数据；拒绝将其登记为当前部署');
      }
      try {
        await this.collections.metadata.insertOne({
          _id: 'runtime',
          schemaVersion: targetVersion,
          deploymentId,
          createdAt: now,
          updatedAt: now
        });
      } catch (error) {
        if (!duplicateKey(error)) throw error;
      }
      metadata = await this.collections.metadata.findOne({ _id: 'runtime' });
    }
    if (!metadata || metadata.deploymentId !== deploymentId) {
      throw configError('数据库 deploymentId 与当前部署不匹配');
    }
    if (metadata.schemaVersion > targetVersion) {
      throw configError('数据库模式版本高于当前程序支持版本', {
        databaseVersion: metadata.schemaVersion,
        supportedVersion: targetVersion
      });
    }

    // 版本 1 的事实记录、唯一键和控制记录。重复执行迁移是幂等的。
    await this.collections.users.createIndex({ usernameKey: 1 }, { unique: true, name: 'identity_username_unique' });
    await this.collections.users.createIndex({ email: 1, status: 1 }, { name: 'identity_email_status' });
    await this.collections.sessions.createIndex({ userId: 1, revokedAt: 1 }, { name: 'identity_session_user' });
    await this.collections.sessions.createIndex(
      { expiresAtDate: 1 },
      { expireAfterSeconds: 0, name: 'identity_session_expiry' }
    );
    await this.collections.challenges.createIndex(
      { expiresAtDate: 1 },
      { expireAfterSeconds: 0, name: 'identity_challenge_expiry' }
    );
    if (metadata.schemaVersion !== targetVersion) {
      await this.collections.metadata.updateOne(
        { _id: 'runtime', deploymentId },
        { $set: { schemaVersion: targetVersion, updatedAt: now } }
      );
    }
    await this.collections.migrations.updateOne(
      { _id: `identity-${targetVersion}` },
      { $setOnInsert: { version: targetVersion, deploymentId, appliedAt: now } },
      { upsert: true }
    );
    this.migrated = true;
    return { schemaVersion: targetVersion, deploymentId };
  }

  requireReady() {
    if (!this.migrated) throw configError('MongoDB 身份存储尚未完成部署校验与迁移');
  }

  async withTransaction(callback) {
    this.requireReady();
    const session = this.client.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await callback({ session });
      }, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' }
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  async acquireWriteLock({ tx } = {}) {
    this.requireReady();
    if (!tx || !tx.session) throw configError('身份写锁必须在事务内获取');
    await this.collections.controls.updateOne(
      { _id: 'identity-write-lock' },
      { $inc: { revision: 1 }, $setOnInsert: { createdAt: new Date(this.clock()).toISOString() } },
      { session: tx.session, upsert: true }
    );
  }

  async createUser(input, options = {}) {
    this.requireReady();
    const now = new Date(this.clock()).toISOString();
    const id = input.id || crypto.randomUUID();
    const user = {
      id,
      username: input.username,
      usernameKey: normalizeUsername(input.username),
      passwordHash: input.passwordHash,
      role: input.role || 'user',
      status: input.status || 'active',
      email: input.email === undefined ? null : input.email,
      emailVerified: Boolean(input.emailVerified),
      authVersion: input.authVersion || 0,
      version: input.version || 0,
      createdAt: input.createdAt || now,
      updatedAt: input.updatedAt || now
    };
    try {
      await this.collections.users.insertOne({ _id: id, ...user }, operationOptions(options));
    } catch (error) {
      if (duplicateKey(error)) {
        throw new CoreError(codes.USERNAME_TAKEN, '用户名或用户 ID 已被占用', { status: 409 });
      }
      throw error;
    }
    return { ...user };
  }

  async getUserById(userId, options = {}) {
    this.requireReady();
    const document = await this.collections.users.findOne({ _id: userId }, operationOptions(options));
    return publicDocument(document);
  }

  async getUserByNormalizedName(username, options = {}) {
    this.requireReady();
    const document = await this.collections.users.findOne(
      { usernameKey: normalizeUsername(username) },
      operationOptions(options)
    );
    return publicDocument(document);
  }

  async findById(userId, options) {
    return this.getUserById(userId, options);
  }

  async findByUsername(username, options) {
    return this.getUserByNormalizedName(username, options);
  }

  async findUserByEmail(email, status, options = {}) {
    this.requireReady();
    const filter = { email };
    if (status) filter.status = status;
    return publicDocument(await this.collections.users.findOne(filter, operationOptions(options)));
  }

  async listUsers(options = {}) {
    this.requireReady();
    const documents = await this.collections.users
      .find({}, operationOptions(options))
      .sort({ createdAt: 1, _id: 1 })
      .toArray();
    return documents.map(publicDocument);
  }

  async countActiveAdmins(options = {}) {
    this.requireReady();
    return this.collections.users.countDocuments(
      { role: 'admin', status: 'active' },
      operationOptions(options)
    );
  }

  async countAdmins(options) {
    return this.countActiveAdmins(options);
  }

  async updateUser(userId, expectedVersion, patch, options = {}) {
    this.requireReady();
    const allowed = { ...patch };
    for (const field of ['id', '_id', 'createdAt', 'version', 'usernameKey', 'updatedAt']) delete allowed[field];
    if (allowed.username !== undefined) allowed.usernameKey = normalizeUsername(allowed.username);
    let document;
    try {
      document = await this.collections.users.findOneAndUpdate(
        { _id: userId, version: expectedVersion },
        {
          $set: { ...allowed, updatedAt: new Date(this.clock()).toISOString() },
          $inc: { version: 1 }
        },
        { ...operationOptions(options), returnDocument: 'after' }
      );
    } catch (error) {
      if (duplicateKey(error)) throw new CoreError(codes.USERNAME_TAKEN, '用户名已被占用', { status: 409 });
      throw error;
    }
    if (!document) {
      const exists = await this.collections.users.findOne({ _id: userId }, operationOptions(options));
      if (!exists) throw notFound();
      throw conflict();
    }
    return publicDocument(document);
  }

  async deleteUser(userId, expectedVersion, options = {}) {
    this.requireReady();
    const filter = { _id: userId };
    if (expectedVersion !== undefined) filter.version = expectedVersion;
    const result = await this.collections.users.deleteOne(filter, operationOptions(options));
    if (result.deletedCount === 0) {
      const exists = await this.collections.users.findOne({ _id: userId }, operationOptions(options));
      if (!exists) throw notFound();
      throw conflict();
    }
    return true;
  }

  async createSession(session, options = {}) {
    this.requireReady();
    const record = { revokedAt: null, ...session };
    try {
      await this.collections.sessions.insertOne({
        _id: record.tokenHash,
        ...record,
        expiresAtDate: new Date(record.expiresAt)
      }, operationOptions(options));
    } catch (error) {
      if (duplicateKey(error)) throw conflict('会话已存在');
      throw error;
    }
    return { ...record };
  }

  async getSession(tokenHash, options = {}) {
    this.requireReady();
    const document = await this.collections.sessions.findOne({ _id: tokenHash }, operationOptions(options));
    const record = publicDocument(document);
    if (record) delete record.expiresAtDate;
    return record;
  }

  async findSessionByToken(token, options = {}) {
    if (typeof token !== 'string' || token.length === 0) return null;
    const { sha256 } = require('./store');
    return this.getSession(sha256(token), options);
  }

  async revokeSession(tokenHash, revokedAt, options = {}) {
    this.requireReady();
    const result = await this.collections.sessions.updateOne(
      { _id: tokenHash, revokedAt: null },
      { $set: { revokedAt } },
      operationOptions(options)
    );
    if (result.modifiedCount > 0) return true;
    return Boolean(await this.collections.sessions.findOne({ _id: tokenHash }, operationOptions(options)));
  }

  async deleteSession(token, options = {}) {
    const { sha256 } = require('./store');
    return this.revokeSession(sha256(token), new Date(this.clock()).toISOString(), options);
  }

  async revokeUserSessions(userId, revokedAt, options = {}) {
    this.requireReady();
    const result = await this.collections.sessions.updateMany(
      { userId, revokedAt: null },
      { $set: { revokedAt } },
      operationOptions(options)
    );
    return result.modifiedCount;
  }

  async deleteSessionsForUser(userId, options = {}) {
    return this.revokeUserSessions(userId, new Date(this.clock()).toISOString(), options);
  }

  async putVerification(target, purpose, record, options = {}) {
    this.requireReady();
    const key = verificationKey(target, purpose);
    const persisted = {
      ...record,
      target,
      purpose,
      expiresAtDate: new Date(record.expiresAt)
    };
    await this.collections.challenges.replaceOne(
      { _id: key },
      { _id: key, ...persisted },
      { ...operationOptions(options), upsert: true }
    );
    return { ...record };
  }

  async getVerification(target, purpose, options = {}) {
    this.requireReady();
    const document = await this.collections.challenges.findOne(
      { _id: verificationKey(target, purpose) },
      operationOptions(options)
    );
    if (!document) return null;
    const { _id, expiresAtDate, target: storedTarget, purpose: storedPurpose, ...record } = document;
    return record;
  }

  async deleteVerification(target, purpose, options = {}) {
    this.requireReady();
    const result = await this.collections.challenges.deleteOne(
      { _id: verificationKey(target, purpose) },
      operationOptions(options)
    );
    return result.deletedCount > 0;
  }

  async getBootstrapControl(options = {}) {
    this.requireReady();
    const document = await this.collections.controls.findOne({ _id: 'admin-bootstrap' }, operationOptions(options));
    return publicDocument(document) || { id: 'admin-bootstrap', closed: false };
  }

  async closeBootstrapOnce(record, options = {}) {
    this.requireReady();
    const result = await this.collections.controls.updateOne(
      { _id: 'admin-bootstrap', closed: { $ne: true } },
      {
        $set: { closed: true, closedAt: record.closedAt || new Date(this.clock()).toISOString() },
        $setOnInsert: { createdAt: record.createdAt || new Date(this.clock()).toISOString() }
      },
      { ...operationOptions(options), upsert: true }
    );
    return result.modifiedCount > 0 || result.upsertedCount > 0;
  }

  async close() {
    if (this.client && this.ownsClient) await this.client.close();
    this.db = null;
    this.collections = null;
    this.migrated = false;
  }
}

module.exports = { MongoIdentityStore, IDENTITY_SCHEMA_VERSION, COLLECTIONS };
