'use strict';
// Glim 工作区：每用户在受控根目录内的一块私有文件区。
//
// 约束：
//  - 只接受相对 POSIX 路径；拒绝绝对路径、反斜杠、`.`/`..` 段、控制字符与超长路径；
//  - 每个用户一个物理子目录（用户 ID 的 SHA-256 前缀），无法通过路径穿越读写他人文件；
//  - 写文件使用同目录临时文件 + rename，权限 0600；目录 0700；
//  - 所有读取都有大小上限，避免把大文件读进内存。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_PATH_CHARS = 512;
const MAX_COMPONENT_CHARS = 200;
const MAX_DEPTH = 8;

function fail(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.expose = true;
  return error;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function validateRelativePath(raw) {
  if (typeof raw !== 'string') throw fail('glim.workspace_invalid_path', 'path 必须是字符串');
  const value = raw.trim();
  if (!value) throw fail('glim.workspace_invalid_path', 'path 不能为空');
  if (value.length > MAX_PATH_CHARS) throw fail('glim.workspace_invalid_path', 'path 过长');
  if (value.startsWith('/') || value.includes('\\')) {
    throw fail('glim.workspace_invalid_path', '只接受相对 POSIX 路径');
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) throw fail('glim.workspace_invalid_path', 'path 含控制字符');
  const parts = value.split('/');
  if (parts.length > MAX_DEPTH) throw fail('glim.workspace_invalid_path', `路径深度不得超过 ${MAX_DEPTH} 层`);
  for (const part of parts) {
    if (!part || part === '.' || part === '..') throw fail('glim.workspace_invalid_path', 'path 含非法段');
    if (part.length > MAX_COMPONENT_CHARS) throw fail('glim.workspace_invalid_path', '路径段过长');
  }
  return parts.join('/');
}

function createWorkspace({ root, maxFileBytes, maxFiles, maxTotalBytes, logger }) {
  const base = path.resolve(root);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });

  function userDir(userId, { create = false } = {}) {
    const dir = path.join(base, sha256(userId).slice(0, 32));
    if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  function resolvePath(userId, relative, { create = false } = {}) {
    const clean = validateRelativePath(relative);
    const dir = userDir(userId, { create });
    const target = path.resolve(dir, clean);
    if (target !== dir && !target.startsWith(dir + path.sep)) {
      throw fail('glim.workspace_invalid_path', 'path 越界');
    }
    return { clean, dir, target };
  }

  function statSafe(target) {
    try {
      return fs.lstatSync(target);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  function list(userId) {
    const dir = userDir(userId);
    if (!fs.existsSync(dir)) return { files: [], totalBytes: 0 };
    const files = [];
    let totalBytes = 0;
    const walk = (absolute, prefix, depth) => {
      if (depth > MAX_DEPTH) return;
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(absolute, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          walk(full, relative, depth + 1);
        } else if (entry.isFile()) {
          const stat = fs.statSync(full);
          totalBytes += stat.size;
          files.push({
            path: relative,
            size: stat.size,
            updatedAt: stat.mtime.toISOString()
          });
        }
      }
    };
    walk(dir, '', 1);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files, totalBytes };
  }

  function read(userId, relative) {
    const { clean, target } = resolvePath(userId, relative);
    const stat = statSafe(target);
    if (!stat || !stat.isFile()) throw fail('glim.workspace_not_found', '文件不存在', 404);
    if (stat.size > maxFileBytes) throw fail('glim.workspace_too_large', '文件超过读取上限', 413);
    return { path: clean, content: fs.readFileSync(target), size: stat.size, updatedAt: stat.mtime.toISOString() };
  }

  function write(userId, relative, content) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    if (buffer.length > maxFileBytes) throw fail('glim.workspace_too_large', '文件超过写入上限', 413);
    const { clean, dir, target } = resolvePath(userId, relative, { create: true });
    const usage = list(userId);
    const existing = statSafe(target);
    const fileCount = usage.files.length + (existing ? 0 : 1);
    if (fileCount > maxFiles) throw fail('glim.workspace_quota_exceeded', '工作区文件数量已达上限', 409);
    const nextTotal = usage.totalBytes - (existing && existing.isFile() ? existing.size : 0) + buffer.length;
    if (nextTotal > maxTotalBytes) throw fail('glim.workspace_quota_exceeded', '工作区容量已达上限', 409);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.part`);
    fs.writeFileSync(temp, buffer, { mode: 0o600 });
    fs.renameSync(temp, target);
    if (dir) fs.chmodSync(dir, 0o700);
    return { path: clean, size: buffer.length, created: !existing };
  }

  function remove(userId, relative) {
    const { clean, target } = resolvePath(userId, relative);
    const stat = statSafe(target);
    if (!stat) throw fail('glim.workspace_not_found', '文件不存在', 404);
    if (stat.isDirectory()) throw fail('glim.workspace_invalid_path', '不能删除目录', 400);
    fs.unlinkSync(target);
    return { path: clean, deleted: true };
  }

  function health() {
    return { root: base, writable: fs.existsSync(base) };
  }

  if (logger) logger.info(`[glim] workspace ready root=${base}`);
  return { list, read, write, remove, health, validate: validateRelativePath };
}

module.exports = { createWorkspace, validateRelativePath, MAX_PATH_CHARS };
