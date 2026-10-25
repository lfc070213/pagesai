'use strict';
// 公共核心统一错误类型。
// 设计约束：错误码稳定、可被 API 层映射为 HTTP 状态；不携带敏感值。
// 方案依据：§5.1（公共身份最小模型）、§5.3（跨服务统一验证）、§4.3（状态语义）。

class CoreError extends Error {
  /**
   * @param {string} code 稳定错误码（大写下划线）
   * @param {string} message 面向人的说明（可安全展示，不含秘密）
   * @param {object} [options]
   * @param {number} [options.status=400] 建议的 HTTP 状态
   * @param {object} [options.details] 结构化附加信息（不得含密码/Token）
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
    this.status = Number.isInteger(options.status) ? options.status : 400;
    this.details = options.details === undefined ? null : options.details;
    this.expose = true;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

const codes = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  USERNAME_TAKEN: 'USERNAME_TAKEN',
  USERNAME_RESERVED: 'USERNAME_RESERVED',
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  EMAIL_UNVERIFIED: 'EMAIL_UNVERIFIED',
  EMAIL_VERIFICATION_REQUIRED: 'EMAIL_VERIFICATION_REQUIRED',
  MAIL_MODULE_REQUIRED: 'MAIL_MODULE_REQUIRED',
  MAIL_NOT_CONFIGURED: 'MAIL_NOT_CONFIGURED',
  VERIFICATION_INVALID: 'VERIFICATION_INVALID',
  VERIFICATION_RATE_LIMITED: 'VERIFICATION_RATE_LIMITED',
  SESSION_INVALID: 'SESSION_INVALID',
  SESSION_REVOKED: 'SESSION_REVOKED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  BOOTSTRAP_CLOSED: 'BOOTSTRAP_CLOSED',
  LAST_ADMIN_PROTECTED: 'LAST_ADMIN_PROTECTED',
  REGISTRATION_CLOSED: 'REGISTRATION_CLOSED',
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_IMMUTABLE: 'CONFIG_IMMUTABLE',
  MODULE_NOT_INSTALLED: 'MODULE_NOT_INSTALLED',
  MODULE_NOT_READY: 'MODULE_NOT_READY',
  REGION_UNKNOWN: 'REGION_UNKNOWN',
  REGION_NOT_AUTHORIZED: 'REGION_NOT_AUTHORIZED',
  PATH_ESCAPE: 'PATH_ESCAPE',
  IMPLICIT_DATA_ROOT_CHANGE: 'IMPLICIT_DATA_ROOT_CHANGE',
  DISK_FULL: 'DISK_FULL',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  UPLOAD_STATE: 'UPLOAD_STATE',
  UPLOAD_CANCELLED: 'UPLOAD_CANCELLED',
  HASH_MISMATCH: 'HASH_MISMATCH',
  BACKUP_INVALID: 'BACKUP_INVALID',
  RESTORE_INVALID: 'RESTORE_INVALID'
});

module.exports = { CoreError, codes };
