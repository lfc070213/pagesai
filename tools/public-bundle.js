#!/usr/bin/env node
'use strict';
/**
 * 公开导出版白名单与可重复制品（C34）
 *
 * 职责：
 *   1. 按 config/public-bundle-policy.json 的 include 白名单收集文件，默认拒绝；
 *   2. deny 优先于 include，排除 .env、依赖、构建产物、数据、备份、日志、上传、
 *      Maildir、签名密钥、私有路径、docs/m0 等内部材料；
 *   3. 生成不含时间戳、绝对路径的 PUBLIC-BUNDLE-MANIFEST.json
 *      （path + SHA-256 + bytes + mode），同样输入重复运行必须逐字节一致；
 *   4. 可选生成确定性的 tar.gz（固定 mtime/uid/gid、按路径排序、gzip -n 语义），
 *      并输出归档 SHA-256；
 *   5. --check 用于 CI：用已有清单反向校验目录。
 *
 * 约束：只用 Node 内置模块；只读源目录；不联网；不写源目录。
 *
 * 用法：
 *   node tools/public-bundle.js --out /tmp/pagesai-bundle --dry-run
 *   node tools/public-bundle.js --out /tmp/pagesai-bundle
 *   node tools/public-bundle.js --out /tmp/pagesai-bundle --archive /tmp/pagesai.tar.gz
 *   node tools/public-bundle.js --check /tmp/pagesai-bundle
 *   node tools/public-bundle.js --check /tmp/pagesai-bundle --manifest /tmp/expected.json
 *
 * 退出码：0 成功/一致；1 校验或导出失败；2 参数错误。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ROOT = PROJECT_ROOT;
const DEFAULT_POLICY = path.join(PROJECT_ROOT, 'config/public-bundle-policy.json');
const MANIFEST_NAME = 'PUBLIC-BUNDLE-MANIFEST.json';
const SCHEMA_VERSION = 1;
const INVENTORY_ALGORITHM = "sha256(concat(sorted(path + '\\t' + sha256 + '\\n')))";

class BundleError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'BundleError';
    this.exitCode = exitCode;
  }
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function compareUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function isInside(childPath, parentPath) {
  const rel = path.relative(parentPath, childPath);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

// 解析可能尚不存在的输出路径的真实路径，防止通过符号链接绕开“不得写入源树”的检查。
function resolveRealTarget(targetPath) {
  let current = path.resolve(targetPath);
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...suffix);
}

function displayPath(absPath) {
  const rel = path.relative(PROJECT_ROOT, absPath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return toPosix(rel);
  return path.basename(absPath);
}

// 与 tools/release-manifest.js 相同的 glob 语义：**、*、?。
function globToRegExp(pattern) {
  const normalized = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '');
  let out = '^';
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        i += 1;
        if (normalized[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${out}$`);
}

function loadPolicy(policyPath) {
  let raw;
  try {
    raw = fs.readFileSync(policyPath, 'utf8');
  } catch (error) {
    throw new BundleError(`策略文件不可读：${policyPath}（${error.code || error.message}）`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BundleError(`策略文件不是合法 JSON：${policyPath}（${error.message}）`);
  }
  if (!parsed || parsed.schemaVersion !== 1) {
    throw new BundleError('策略文件 schemaVersion 必须为 1');
  }
  if (!Array.isArray(parsed.include) || parsed.include.length === 0) {
    throw new BundleError('策略文件 include 必须是非空数组');
  }
  if (!Array.isArray(parsed.deny)) {
    throw new BundleError('策略文件 deny 必须是数组');
  }
  const include = parsed.include.map((pattern) => {
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      throw new BundleError('include 条目必须是非空字符串');
    }
    return { pattern, regex: globToRegExp(pattern) };
  });
  const deny = parsed.deny.map((rule, index) => {
    if (!rule || typeof rule !== 'object') {
      throw new BundleError(`deny[${index}] 必须是对象`);
    }
    if (typeof rule.id !== 'string' || rule.id.trim() === '') {
      throw new BundleError(`deny[${index}].id 必须是非空字符串`);
    }
    if (typeof rule.pattern !== 'string' || rule.pattern.trim() === '') {
      throw new BundleError(`deny[${index}].pattern 必须是非空字符串`);
    }
    if (typeof rule.reason !== 'string' || rule.reason.trim() === '') {
      throw new BundleError(`deny[${index}].reason 必须是非空字符串`);
    }
    return { id: rule.id, pattern: rule.pattern, reason: rule.reason, regex: globToRegExp(rule.pattern) };
  });
  return {
    path: policyPath,
    sha256: sha256Buffer(Buffer.from(raw, 'utf8')),
    include,
    deny
  };
}

function denyHit(policy, relPath, isDir) {
  const probe = isDir ? `${relPath}/` : relPath;
  for (const rule of policy.deny) {
    if (rule.regex.test(probe)) return rule;
  }
  return null;
}

function includeHit(policy, relPath) {
  for (const rule of policy.include) {
    if (rule.regex.test(relPath)) return rule;
  }
  return null;
}

function addSample(bucket, relPath) {
  bucket.count += 1;
  if (bucket.samples.length < 12 && !bucket.samples.includes(relPath)) {
    bucket.samples.push(relPath);
  }
}

function scanSource(root, policy) {
  const files = [];
  const denied = new Map();
  const notAllowed = { count: 0, samples: [] };
  const rejected = [];
  const pending = [''];

  const recordDenied = (rule, relPath) => {
    let bucket = denied.get(rule.id);
    if (!bucket) {
      bucket = { ruleId: rule.id, pattern: rule.pattern, reason: rule.reason, count: 0, samples: [] };
      denied.set(rule.id, bucket);
    }
    addSample(bucket, relPath);
  };

  while (pending.length > 0) {
    const relDir = pending.pop();
    const absDir = relDir === '' ? root : path.join(root, ...relDir.split('/'));
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (error) {
      throw new BundleError(`读取目录失败：${displayPath(absDir)}（${error.code || error.message}）`);
    }
    entries.sort((a, b) => compareUtf8(a.name, b.name));

    for (const entry of entries) {
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (/[\t\r\n]/.test(relPath)) {
        throw new BundleError(`拒绝含制表符/换行的路径：${JSON.stringify(relPath)}`);
      }

      if (entry.isSymbolicLink()) {
        if (rejected.length < 50) rejected.push({ path: relPath, reason: '符号链接（拒绝跨树读取）' });
        else rejected.push({ path: '(more)', reason: '符号链接' });
        continue;
      }
      if (entry.isDirectory()) {
        const dirRule = denyHit(policy, relPath, true);
        if (dirRule) {
          recordDenied(dirRule, `${relPath}/`);
          continue;
        }
        pending.push(relPath);
        continue;
      }
      if (!entry.isFile()) {
        if (rejected.length < 50) rejected.push({ path: relPath, reason: '非常规文件' });
        continue;
      }

      const fileRule = denyHit(policy, relPath, false);
      if (fileRule) {
        recordDenied(fileRule, relPath);
        continue;
      }
      if (!includeHit(policy, relPath)) {
        addSample(notAllowed, relPath);
        continue;
      }

      const absFile = path.join(absDir, entry.name);
      let buffer;
      let stat;
      try {
        stat = fs.lstatSync(absFile);
        buffer = fs.readFileSync(absFile);
      } catch (error) {
        throw new BundleError(`读取文件失败：${relPath}（${error.code || error.message}）`);
      }
      // 统一权限位，避免 umask 影响清单可复现性。
      const mode = stat.mode & 0o111 ? 0o755 : 0o644;
      files.push({ path: relPath, sha256: sha256Buffer(buffer), bytes: buffer.length, mode });
    }
  }

  files.sort((a, b) => compareUtf8(a.path, b.path));

  const inventoryHash = computeInventoryHash(files);
  const deniedList = [...denied.values()].sort((a, b) => {
    if (a.ruleId !== b.ruleId) return compareUtf8(a.ruleId, b.ruleId);
    return compareUtf8(a.pattern, b.pattern);
  });

  return {
    files,
    inventoryHash,
    denied: deniedList,
    deniedCount: deniedList.reduce((sum, item) => sum + item.count, 0),
    notAllowed,
    rejected
  };
}

function computeInventoryHash(files) {
  const lines = files.map((file) => `${file.path}\t${file.sha256}\n`);
  return sha256Buffer(Buffer.from(lines.join(''), 'utf8'));
}

function buildManifest(policy, scan) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generator: 'tools/public-bundle.js',
    manifestName: MANIFEST_NAME,
    policy: {
      path: displayPath(policy.path),
      sha256: policy.sha256
    },
    inventoryAlgorithm: INVENTORY_ALGORITHM,
    inventoryHash: scan.inventoryHash,
    counts: {
      files: scan.files.length,
      bytes: scan.files.reduce((sum, file) => sum + file.bytes, 0)
    },
    include: policy.include.map((rule) => rule.pattern),
    files: scan.files
  };
}

function assertSafeRelative(relPath, label) {
  if (typeof relPath !== 'string' || relPath === '') throw new BundleError(`${label} 为空`);
  if (relPath.includes('\0')) throw new BundleError(`${label} 含 NUL 字节`);
  if (relPath.includes('\\')) throw new BundleError(`${label} 含反斜杠`);
  if (relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)) throw new BundleError(`${label} 不得为绝对路径`);
  for (const segment of relPath.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new BundleError(`${label} 含非法路径段：${relPath}`);
    }
  }
  return relPath;
}

function validateManifest(manifest, label) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new BundleError(`${label} 不是 JSON 对象`);
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) throw new BundleError(`${label} schemaVersion 不支持`);
  if (!Array.isArray(manifest.files)) throw new BundleError(`${label} 缺少 files 数组`);
  if (typeof manifest.inventoryHash !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.inventoryHash)) {
    throw new BundleError(`${label} inventoryHash 不是 64 位小写十六进制`);
  }
  const seen = new Set();
  for (const [index, file] of manifest.files.entries()) {
    if (!file || typeof file !== 'object') throw new BundleError(`${label} files[${index}] 不是对象`);
    assertSafeRelative(file.path, `${label} files[${index}].path`);
    if (seen.has(file.path)) throw new BundleError(`${label} files[${index}] 路径重复：${file.path}`);
    seen.add(file.path);
    if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new BundleError(`${label} files[${index}].sha256 非法`);
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new BundleError(`${label} files[${index}].bytes 非法`);
    }
    if (file.mode !== 0o644 && file.mode !== 0o755) {
      throw new BundleError(`${label} files[${index}].mode 必须为 0644 或 0755`);
    }
  }
}

function prepareOutDir(outAbs, { force, dryRun, rootReal }) {
  const outReal = resolveRealTarget(outAbs);
  if (outReal === path.parse(outReal).root) throw new BundleError('拒绝使用文件系统根目录作为输出目录');
  if (isInside(outReal, rootReal)) {
    throw new BundleError(`输出目录不得位于源目录内：${outAbs}。请使用 /tmp 等源树之外的目录。`);
  }
  if (isInside(rootReal, outReal)) {
    throw new BundleError(`输出目录不能是源目录的祖先：${outAbs}`);
  }
  if (dryRun) return { outAbs, outReal, cleared: false };

  if (fs.existsSync(outAbs)) {
    const stat = fs.lstatSync(outAbs);
    if (!stat.isDirectory()) throw new BundleError(`输出路径已存在且不是目录：${outAbs}`);
    const entries = fs.readdirSync(outAbs);
    if (entries.length > 0) {
      if (!force) {
        throw new BundleError(`输出目录非空：${outAbs}\n请换空目录，或确认后使用 --force（会清空该目录）。`);
      }
      for (const entry of entries) fs.rmSync(path.join(outAbs, entry), { recursive: true, force: true });
      return { outAbs, outReal, cleared: true };
    }
  } else {
    fs.mkdirSync(outAbs, { recursive: true });
  }
  return { outAbs, outReal, cleared: false };
}

function copyAtomic(sourceAbs, targetAbs, mode) {
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  const tempPath = `${targetAbs}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.copyFileSync(sourceAbs, tempPath);
  fs.chmodSync(tempPath, mode);
  fs.renameSync(tempPath, targetAbs);
}

function writeAtomic(filePath, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tempPath, content, { mode });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // 忽略清理失败
    }
    throw new BundleError(`写入失败：${filePath}（${error.code || error.message}）`);
  }
}

// ---------------------------------------------------------------------------
// 确定性 tar.gz
// ---------------------------------------------------------------------------
function splitTarName(fullName) {
  if (Buffer.byteLength(fullName) <= 100) return { name: fullName, prefix: '' };
  for (let i = fullName.length - 1; i > 0; i -= 1) {
    if (fullName[i] !== '/') continue;
    const prefix = fullName.slice(0, i);
    const name = fullName.slice(i + 1);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix };
  }
  throw new BundleError(`路径过长，ustar 无法表示：${fullName}`);
}

function writeString(buffer, value, offset, length) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) throw new BundleError(`tar 字段溢出：${value}`);
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, value, offset, length) {
  const text = value.toString(8).padStart(length - 1, '0');
  if (text.length > length - 1) throw new BundleError(`tar 八进制字段溢出：${value}`);
  writeString(buffer, `${text}\0`, offset, length);
}

function tarHeader(fullName, size, mode) {
  const { name, prefix } = splitTarName(fullName);
  const header = Buffer.alloc(512, 0);
  writeString(header, name, 0, 100);
  writeOctal(header, mode, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, size, 124, 12);
  writeOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = 0x30; // '0' 常规文件
  writeString(header, 'ustar\0', 257, 6);
  writeString(header, '00', 263, 2);
  writeString(header, 'root', 265, 32);
  writeString(header, 'root', 297, 32);
  writeOctal(header, 0, 329, 8);
  writeOctal(header, 0, 337, 8);
  if (prefix) writeString(header, prefix, 345, 155);

  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeString(header, `${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return header;
}

function buildTarGz(outAbs, manifest, prefix) {
  const normalizedPrefix = prefix ? prefix.replace(/^\/+|\/+$/g, '') : '';
  if (normalizedPrefix && (normalizedPrefix.split('/').includes('..') || normalizedPrefix.includes('\\'))) {
    throw new BundleError(`--prefix 非法：${prefix}`);
  }
  const entries = manifest.files.map((file) => ({
    path: normalizedPrefix ? `${normalizedPrefix}/${file.path}` : file.path,
    abs: path.join(outAbs, ...file.path.split('/')),
    mode: file.mode
  }));
  entries.push({
    path: normalizedPrefix ? `${normalizedPrefix}/${MANIFEST_NAME}` : MANIFEST_NAME,
    abs: path.join(outAbs, MANIFEST_NAME),
    mode: 0o644
  });
  entries.sort((a, b) => compareUtf8(a.path, b.path));

  const chunks = [];
  for (const entry of entries) {
    const content = fs.readFileSync(entry.abs);
    chunks.push(tarHeader(entry.path, content.length, entry.mode));
    chunks.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
}

// ---------------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------------
function scanDirForCheck(dirAbs) {
  const files = [];
  const problems = [];
  const stack = [''];
  while (stack.length > 0) {
    const relDir = stack.pop();
    const absDir = relDir === '' ? dirAbs : path.join(dirAbs, ...relDir.split('/'));
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (error) {
      throw new BundleError(`读取目录失败：${displayPath(absDir)}（${error.code || error.message}）`);
    }
    entries.sort((a, b) => compareUtf8(a.name, b.name));
    for (const entry of entries) {
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (relPath === MANIFEST_NAME) continue;
      if (entry.isSymbolicLink()) {
        problems.push(`符号链接不允许：${relPath}`);
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(relPath);
        continue;
      }
      if (!entry.isFile()) {
        problems.push(`非常规文件：${relPath}`);
        continue;
      }
      const absFile = path.join(absDir, entry.name);
      files.push({ path: relPath, sha256: sha256File(absFile), bytes: fs.statSync(absFile).size });
    }
  }
  files.sort((a, b) => compareUtf8(a.path, b.path));
  return { files, problems };
}

function compareWithManifest(expected, actual) {
  const problems = [];
  if (expected.inventoryHash !== actual.inventoryHash) {
    problems.push(`inventoryHash 不一致：期望 ${expected.inventoryHash}，实际 ${actual.inventoryHash}`);
  }
  const expectedByPath = new Map(expected.files.map((file) => [file.path, file]));
  const actualByPath = new Map(actual.files.map((file) => [file.path, file]));
  for (const file of expected.files) {
    const found = actualByPath.get(file.path);
    if (!found) {
      problems.push(`缺少文件：${file.path}`);
      continue;
    }
    if (found.sha256 !== file.sha256) problems.push(`内容变化：${file.path}`);
    else if (found.bytes !== file.bytes) problems.push(`字节数变化：${file.path}`);
  }
  for (const file of actual.files) {
    if (!expectedByPath.has(file.path)) problems.push(`多出文件：${file.path}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 参数与输出
// ---------------------------------------------------------------------------
const USAGE = `公开导出版白名单与可重复制品（C34）

用法：
  node tools/public-bundle.js --out DIR [--dry-run] [选项]
  node tools/public-bundle.js --check DIR [--manifest FILE] [--json]

必填（二选一）：
  --out DIR           生成导出版到 DIR（不得位于源目录内）
  --check DIR         用清单反向校验已有导出版

选项：
  --root DIR          源目录，默认是本工具上一级（公开版根目录）
  --policy FILE       白名单策略，默认 config/public-bundle-policy.json
  --manifest FILE     --check 时指定清单，默认 <DIR>/${MANIFEST_NAME}
  --archive FILE      额外生成确定性 tar.gz（含 ${MANIFEST_NAME}），并写 FILE.sha256
  --prefix NAME       归档内顶层目录名（例如 pagesai-0.1.0）
  --force             清空非空输出目录（仅用于临时目录）
  --dry-run           只扫描与报告，不写文件；--archive 也不会创建
  --json              单行 JSON 摘要
  -h, --help          显示本帮助

示例：
  node tools/public-bundle.js --out /tmp/pagesai-bundle --dry-run
  node tools/public-bundle.js --out /tmp/pagesai-bundle --archive /tmp/pagesai.tar.gz
  node tools/public-bundle.js --check /tmp/pagesai-bundle

退出码：0 成功/一致；1 校验或导出失败；2 参数错误。
`;

function parseArgs(argv) {
  const options = {
    root: DEFAULT_ROOT,
    policy: DEFAULT_POLICY,
    out: null,
    check: null,
    manifest: null,
    archive: null,
    prefix: '',
    force: false,
    dryRun: false,
    json: false,
    help: false
  };
  const takeValue = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new BundleError(`${flag} 缺少参数值`, 2);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--root':
        options.root = takeValue(i, arg);
        i += 1;
        break;
      case '--policy':
        options.policy = takeValue(i, arg);
        i += 1;
        break;
      case '--out':
        options.out = takeValue(i, arg);
        i += 1;
        break;
      case '--check':
        options.check = takeValue(i, arg);
        i += 1;
        break;
      case '--manifest':
        options.manifest = takeValue(i, arg);
        i += 1;
        break;
      case '--archive':
        options.archive = takeValue(i, arg);
        i += 1;
        break;
      case '--prefix':
        options.prefix = takeValue(i, arg);
        i += 1;
        break;
      case '--force':
        options.force = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new BundleError(`未知参数：${arg}\n\n${USAGE}`, 2);
    }
  }
  if (options.help) return options;
  if (!options.out && !options.check) throw new BundleError(`缺少 --out 或 --check\n\n${USAGE}`, 2);
  if (options.out && options.check) throw new BundleError('--out 与 --check 不能同时使用', 2);
  if (options.check && options.dryRun) throw new BundleError('--check 不能与 --dry-run 同时使用', 2);
  if (options.check && options.force) throw new BundleError('--check 不能与 --force 同时使用', 2);
  return options;
}

function printReport(summary) {
  if (summary.mode === 'check') {
    console.log('公开导出版清单校验（C34）');
    console.log(`目录        : ${summary.dir}`);
    console.log(`清单        : ${summary.manifest}`);
    console.log(`文件数      : ${summary.files}`);
    console.log(`inventoryHash: ${summary.inventoryHash}`);
    console.log(`校验结果    : ${summary.ok ? '一致' : '不一致'}`);
    for (const problem of summary.problems) console.log(`  - ${problem}`);
    return;
  }

  console.log('公开导出版白名单导出（C34）');
  console.log(`模式        : ${summary.dryRun ? 'dry-run（不写文件）' : '真实导出'}`);
  console.log(`源目录      : ${summary.root}`);
  console.log(`策略        : ${summary.policy.path}（sha256=${summary.policy.sha256}）`);
  console.log(`允许文件    : ${summary.counts.files} 个，${summary.counts.bytes} 字节`);
  console.log(`inventoryHash: ${summary.inventoryHash}`);
  if (!summary.dryRun) {
    console.log(`输出目录    : ${summary.out}`);
    console.log(`清单文件    : ${summary.manifestPath}`);
  }
  if (summary.archive) {
    console.log(`归档        : ${summary.archive.path}（sha256=${summary.archive.sha256}，${summary.archive.bytes} 字节）`);
  }
  console.log(`排除统计    : 拒绝 ${summary.deniedCount}，未列入白名单 ${summary.notAllowed.count}，非常规 ${summary.rejected.length}`);
  if (summary.denied.length > 0) {
    console.log('');
    console.log('按规则拒绝：');
    for (const item of summary.denied) {
      console.log(`  - [${item.ruleId}] ${item.count} 项：${item.reason}`);
      for (const sample of item.samples.slice(0, 5)) console.log(`      ${sample}`);
    }
  }
  if (summary.notAllowed.count > 0) {
    console.log('');
    console.log(`未列入白名单（默认拒绝，${summary.notAllowed.count} 项，抽样）：`);
    for (const sample of summary.notAllowed.samples.slice(0, 10)) console.log(`  - ${sample}`);
  }
  if (summary.rejected.length > 0) {
    console.log('');
    console.log('非常规条目：');
    for (const item of summary.rejected.slice(0, 10)) console.log(`  - ${item.path} ${item.reason}`);
  }
  console.log('');
  console.log(summary.dryRun ? '结论        : dry-run 通过。' : '结论        : 导出完成。');
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const rootAbs = path.resolve(options.root);
  if (!fs.existsSync(rootAbs) || !fs.statSync(rootAbs).isDirectory()) {
    throw new BundleError(`源目录不存在或不是目录：${options.root}`);
  }
  const rootReal = fs.realpathSync(rootAbs);

  if (options.check) {
    const dirAbs = path.resolve(options.check);
    if (!fs.existsSync(dirAbs) || !fs.statSync(dirAbs).isDirectory()) {
      throw new BundleError(`待校验目录不存在：${options.check}`);
    }
    const manifestPath = path.resolve(options.manifest || path.join(dirAbs, MANIFEST_NAME));
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      throw new BundleError(`读取清单失败：${manifestPath}（${error.code || error.message}）`);
    }
    validateManifest(manifest, manifestPath);
    const actual = scanDirForCheck(dirAbs);
    const actualHash = computeInventoryHash(actual.files);
    actual.inventoryHash = actualHash;
    const problems = [...actual.problems, ...compareWithManifest(manifest, actual)];
    const summary = {
      ok: problems.length === 0,
      mode: 'check',
      dir: displayPath(dirAbs),
      manifest: displayPath(manifestPath),
      files: actual.files.length,
      inventoryHash: actualHash,
      expectedInventoryHash: manifest.inventoryHash,
      problems
    };
    if (options.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
    else printReport(summary);
    return summary.ok ? 0 : 1;
  }

  const policy = loadPolicy(path.resolve(options.policy));
  const scan = scanSource(rootReal, policy);
  const manifest = buildManifest(policy, scan);
  const outInfo = prepareOutDir(path.resolve(options.out), {
    force: options.force,
    dryRun: options.dryRun,
    rootReal
  });

  let archiveInfo = null;
  if (!options.dryRun) {
    for (const file of scan.files) {
      const sourceAbs = path.join(rootReal, ...file.path.split('/'));
      const targetAbs = path.join(outInfo.outAbs, ...file.path.split('/'));
      copyAtomic(sourceAbs, targetAbs, file.mode);
    }
    const manifestPath = path.join(outInfo.outAbs, MANIFEST_NAME);
    writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    if (options.archive) {
      const archiveAbs = path.resolve(options.archive);
      if (isInside(resolveRealTarget(archiveAbs), outInfo.outReal)) {
        throw new BundleError(`--archive 不得位于输出目录内：${archiveAbs}`);
      }
      const archiveBuffer = buildTarGz(outInfo.outAbs, manifest, options.prefix);
      writeAtomic(archiveAbs, archiveBuffer);
      const archiveSha = sha256Buffer(archiveBuffer);
      writeAtomic(`${archiveAbs}.sha256`, `${archiveSha}  ${path.basename(archiveAbs)}\n`);
      archiveInfo = { path: displayPath(archiveAbs), sha256: archiveSha, bytes: archiveBuffer.length };
    }
  }

  const summary = {
    ok: true,
    mode: 'export',
    dryRun: options.dryRun,
    root: displayPath(rootReal),
    policy: { path: displayPath(policy.path), sha256: policy.sha256 },
    counts: manifest.counts,
    inventoryHash: manifest.inventoryHash,
    deniedCount: scan.deniedCount,
    denied: scan.denied,
    notAllowed: scan.notAllowed,
    rejected: scan.rejected,
    out: options.dryRun ? null : displayPath(outInfo.outAbs),
    manifestPath: options.dryRun ? null : displayPath(path.join(outInfo.outAbs, MANIFEST_NAME)),
    archive: archiveInfo
  };

  if (options.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
  else printReport(summary);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof BundleError) {
      process.stderr.write(`[public-bundle] ${error.message}\n`);
      process.exitCode = error.exitCode;
    } else {
      process.stderr.write(`[public-bundle] 未预期错误：${error && error.stack ? error.stack : error}\n`);
      process.exitCode = 1;
    }
  }
}

module.exports = {
  MANIFEST_NAME,
  INVENTORY_ALGORITHM,
  loadPolicy,
  scanSource,
  buildManifest,
  buildTarGz,
  computeInventoryHash,
  validateManifest,
  compareWithManifest,
  main
};
