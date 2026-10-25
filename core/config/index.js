'use strict';
// 公共核心配置（B04）。
// 依据：方案 §4.3（模块选择配置是唯一事实来源）、§5.2（邮箱注册依赖 Mail）、§6.1（数据根登记）。
//
// 规则：
//  - core-only 启动不要求模型、邮箱或任何业务根目录；
//  - 启用邮箱验证注册时，必须已安装 Mail，否则启动即失败（不允许「一个外部 SMTP」绕过 Mail 模块）；
//  - 数据根一经登记不得隐式改变（由 StorageRegistry 再校验）；
//  - 秘密字段只从环境变量读取，不写入配置对象明文日志。

const path = require('node:path');
const { CoreError, codes } = require('../errors');

const DEFAULT_DATA_ROOT = 'data';
const MIN_SESSION_TTL_MS = 5 * 60 * 1000;
const MONGODB_ENGINE = 'mongodb';

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

/**
 * 组装核心运行配置。
 * @param {object} [input]
 * @param {Record<string,string>} [input.env]
 * @param {string} [input.dataRoot] 显式数据根（优先于环境变量）
 * @param {string[]} [input.installedModules] 本次部署已安装的模块 ID 列表
 * @param {object} [input.moduleSecrets] 由部署注入的秘密引用（不落日志）
 */
function loadConfig(input = {}) {
  const env = input.env || process.env;
  const dataRoot = path.resolve(input.dataRoot || env.PAGESAI_DATA_ROOT || path.join(process.cwd(), DEFAULT_DATA_ROOT));
  const installRoot = path.resolve(input.installRoot || env.PAGESAI_INSTALL_ROOT || process.cwd());
  const installedModules = Array.isArray(input.installedModules) ? input.installedModules.slice() : String(env.PAGESAI_MODULES || '').split(',').map((s) => s.trim()).filter(Boolean);
  const databaseEngine = input.databaseEngine || env.PAGESAI_DATABASE_ENGINE || null;
  if (databaseEngine !== null && databaseEngine !== MONGODB_ENGINE) {
    throw new CoreError(codes.CONFIG_INVALID, '正式身份存储只支持显式选择 mongodb', {
      status: 500,
      details: { engine: databaseEngine }
    });
  }
  const deploymentId = input.deploymentId || env.PAGESAI_DEPLOYMENT_ID || null;
  if (databaseEngine === MONGODB_ENGINE && !deploymentId) {
    throw new CoreError(codes.CONFIG_INVALID, 'MongoDB 启动需要显式 PAGESAI_DEPLOYMENT_ID', { status: 500 });
  }

  const registration = {
    enabled: bool(env.PAGESAI_REGISTRATION_ENABLED, true),
    requireEmailVerification: bool(env.PAGESAI_EMAIL_REGISTRATION, false),
    allowedEmailDomains: (env.PAGESAI_EMAIL_DOMAINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    sessionTtlMs: Number(env.PAGESAI_SESSION_TTL_MS) > 0 ? Number(env.PAGESAI_SESSION_TTL_MS) : 7 * 24 * 3600 * 1000
  };
  if (registration.sessionTtlMs < MIN_SESSION_TTL_MS) {
    throw new CoreError(codes.CONFIG_INVALID, `会话有效期不得小于 ${MIN_SESSION_TTL_MS} ms`, { status: 500 });
  }
  if (registration.allowedEmailDomains.length === 0) registration.allowedEmailDomains = null;

  // 邮箱注册依赖 Mail：未安装 → 启动即失败（不是等到用户注册时才报错）
  if (registration.requireEmailVerification && !installedModules.includes('mail')) {
    throw new CoreError(codes.MAIL_MODULE_REQUIRED, '启用邮箱验证注册必须安装 Mail 模块', {
      status: 500,
      details: { installedModules }
    });
  }

  const config = {
    dataRoot,
    installRoot,
    installedModules,
    registration: {
      enabled: registration.enabled,
      requireEmailVerification: registration.requireEmailVerification,
      allowedEmailDomains: registration.allowedEmailDomains
    },
    sessionTtlMs: registration.sessionTtlMs,
    deploymentId,
    regions: Array.isArray(input.regions) ? input.regions : [],
    storage: Object.freeze({ ...(input.storage || {}) }),
    database: Object.freeze({
      engine: databaseEngine,
      name: env.PAGESAI_MONGO_DB || 'pagesai',
      initialize: bool(env.PAGESAI_DATABASE_INITIALIZE, false)
    }),
    bootstrapToken: env.PAGESAI_BOOTSTRAP_TOKEN || null,
    moduleConfig: Object.freeze({ ...(input.moduleConfig || {}) }),
    secrets: Object.freeze({ ...(input.moduleSecrets || {}) })
  };
  return Object.freeze({ ...config, secrets: config.secrets });
}

module.exports = { loadConfig, DEFAULT_DATA_ROOT, MIN_SESSION_TTL_MS, MONGODB_ENGINE };
