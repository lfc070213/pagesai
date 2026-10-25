'use strict';
// 口令哈希：scrypt（Node 内置 crypto），无第三方依赖。
// 存储格式：scrypt$<N>$<r>$<p>$<saltB64url>$<hashB64url>
// 约束：不保存明文；校验用定长时间比较；参数随版本可升级。

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { CoreError, codes } = require('../errors');

const scryptAsync = promisify(crypto.scrypt);

const DEFAULTS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 32, saltBytes: 16 });
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;

function assertPasswordPolicy(password) {
  if (typeof password !== 'string') {
    throw new CoreError(codes.INVALID_INPUT, '密码必须是字符串', { status: 400 });
  }
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new CoreError(codes.WEAK_PASSWORD, `密码长度必须在 ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} 之间`, { status: 400 });
  }
  if (password.trim().length === 0) {
    throw new CoreError(codes.WEAK_PASSWORD, '密码不能全为空白字符', { status: 400 });
  }
  return password;
}

async function hashPassword(password, params = {}) {
  assertPasswordPolicy(password);
  const { N, r, p, keylen, saltBytes } = { ...DEFAULTS, ...params };
  const salt = crypto.randomBytes(saltBytes);
  const derived = await scryptAsync(password.normalize('NFKC'), salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', N, r, p, salt.toString('base64url'), Buffer.from(derived).toString('base64url')].join('$');
}

/**
 * 校验口令。任何格式异常都返回 false，不抛错，避免借此探测账号状态。
 */
async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every(Number.isSafeInteger) || N < 2 || N > 1 << 20 || r < 1 || p < 1) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64url');
    expected = Buffer.from(parts[5], 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let derived;
  try {
    derived = await scryptAsync(password.normalize('NFKC'), salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
  } catch {
    return false;
  }
  const actual = Buffer.from(derived);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = { assertPasswordPolicy, hashPassword, verifyPassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, DEFAULTS };
