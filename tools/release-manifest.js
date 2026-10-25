#!/usr/bin/env node
'use strict';

/**
 * 发布清单生成与校验（P7，方案 §2.3、§13.4）
 *
 * 对一个目录生成稳定、可复现的清单：
 *   {
 *     "files": [{ "path": "README.md", "sha256": "…", "bytes": 1234 }, …],
 *     "inventoryHash": "…"
 *   }
 *
 * 复现口径（任何平台、任何时间生成结果都相同）：
 *   - 路径统一为相对目录根的 POSIX 形式（/ 分隔，不含 ./）；
 *   - 文件按路径的 UTF-8 字节序升序排序；
 *   - 每个文件记录 path、sha256（小写十六进制）、bytes；
 *   - inventoryHash = sha256(concat(每条 "path\tsha256\n"))，按同一排序拼接
 *     （与 tools/export-public.js 的 inventoryHash 口径一致，只不含字节数字段）；
 *   - 清单不含生成时间、主机名、绝对路径等易变信息。
 *
 * 安全与一致性：
 *   - 只接受常规文件；遇到符号链接、设备文件等直接失败，避免清单与实际内容不一致；
 *   - 默认跳过 .git（版本库元数据不属于发布内容），其余未声明排除的文件都会进入清单；
 *   - --out 不得位于被扫描目录内部，否则清单会包含自身，无法复现；
 *   - --check 用已有清单反向校验目录，便于 CI 与发布后复核。
 *
 * 只使用 Node 内置模块；除 --out 指定文件外不写任何路径。
 *
 * 用法：
 *   node tools/release-manifest.js --dir DIR
 *   node tools/release-manifest.js --dir DIR --out FILE
 *   node tools/release-manifest.js --dir DIR --check FILE
 *   node tools/release-manifest.js --dir DIR --exclude 'docs/**' --json
 *
 * 退出码：0 成功/一致；1 校验失败或读取失败；2 用法错误。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_DIR = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['.git']);
const INVENTORY_ALGORITHM =
  "sha256(concat(sorted(path + '\\t' + sha256 + '\\n')))";

class ManifestError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'ManifestError';
    this.exitCode = exitCode;
  }
}

function usage() {
  return `发布清单生成与校验

用法：
  node tools/release-manifest.js --dir DIR [--out FILE | --check FILE] [--exclude GLOB]... [--json]
  node tools/release-manifest.js --help

参数：
  --dir DIR        要扫描的目录，默认是本工具上一级（公开版根目录）
  --out FILE       把清单写入 FILE（相对路径按当前工作目录解析）
  --check FILE     用 FILE 校验当前目录；清单不一致时退出码为 1
  --exclude GLOB   排除匹配相对路径的条目，可重复或逗号分隔；支持 **、*、?
  --json           单行 JSON 输出（便于脚本与 CI 解析）
  -h, --help       显示本帮助

输出：
  未指定 --out 时，清单 JSON 写到 stdout；指定 --out 时，stdout 输出摘要。
  --json 在指定 --out/--check 时输出单行摘要，否则输出单行清单。

清单格式：
  { "files": [{ "path", "sha256", "bytes" }], "inventoryHash": "…" }
  ${INVENTORY_ALGORITHM}

退出码：0 成功/一致；1 校验失败或读取失败；2 用法错误。
`;
}

function parseArgs(argv) {
  const options = {
    dir: DEFAULT_DIR,
    out: null,
    check: null,
    excludes: [],
    json: false,
    help: false
  };

  const takeValue = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new ManifestError(`${flag} 缺少参数值`, 2);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--dir') {
      options.dir = takeValue(i, arg);
      i += 1;
    } else if (arg.startsWith('--dir=')) {
      options.dir = arg.slice('--dir='.length);
    } else if (arg === '--out') {
      options.out = takeValue(i, arg);
      i += 1;
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length);
    } else if (arg === '--check') {
      options.check = takeValue(i, arg);
      i += 1;
    } else if (arg.startsWith('--check=')) {
      options.check = arg.slice('--check='.length);
    } else if (arg === '--exclude') {
      options.excludes.push(...splitList(takeValue(i, arg)));
      i += 1;
    } else if (arg.startsWith('--exclude=')) {
      options.excludes.push(...splitList(arg.slice('--exclude='.length)));
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg.startsWith('-')) {
      throw new ManifestError(`未知参数：${arg}`, 2);
    } else if (options.dir === DEFAULT_DIR) {
      // 兼容位置参数：node tools/release-manifest.js DIR
      options.dir = arg;
    } else {
      throw new ManifestError(`多余的参数：${arg}`, 2);
    }
  }

  if (options.help) return options;
  if (!options.dir) throw new ManifestError('--dir 不能为空', 2);
  if (options.out && options.check) {
    throw new ManifestError('--out 与 --check 不能同时使用', 2);
  }
  return options;
}

function splitList(value) {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

// 把 glob 编译成相对 POSIX 路径正则；支持 **、*、?。语义与 tools/check-imports.js 保持一致。
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

function compareUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isInside(childPath, parentPath) {
  const rel = path.relative(parentPath, childPath);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * 扫描目录并生成清单对象。
 * @param {string} dir 目录
 * @param {{ excludes?: string[] }} [options]
 * @returns {{ files: Array<{path: string, sha256: string, bytes: number}>, inventoryHash: string }}
 */
function buildManifest(dir, options = {}) {
  const root = path.resolve(dir);
  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch (error) {
    throw new ManifestError(`目录不存在或无法访问：${root}（${error.code || error.message}）`);
  }
  if (!rootStat.isDirectory()) {
    throw new ManifestError(`不是目录：${root}`);
  }

  const excludeRegexes = (options.excludes || []).map(globToRegExp);
  const isExcluded = (relPath) => excludeRegexes.some((regex) => regex.test(relPath));

  const files = [];
  const stack = [''];
  while (stack.length > 0) {
    const relDir = stack.pop();
    const absDir = relDir === '' ? root : path.join(root, ...relDir.split('/'));
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (error) {
      throw new ManifestError(`读取目录失败：${absDir}（${error.code || error.message}）`);
    }
    entries.sort((a, b) => compareUtf8(a.name, b.name));

    for (const entry of entries) {
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (/[\t\r\n]/.test(relPath)) {
        throw new ManifestError(`拒绝含制表符或换行的路径（清单行格式无法无歧义表示）：${JSON.stringify(relPath)}`);
      }
      if (entry.isSymbolicLink()) {
        throw new ManifestError(`拒绝符号链接（发布清单只接受常规文件）：${relPath}`);
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (isExcluded(relPath) || isExcluded(`${relPath}/`)) continue;
        stack.push(relPath);
        continue;
      }
      if (!entry.isFile()) {
        throw new ManifestError(`拒绝非常规文件（目录/设备/FIFO 等）：${relPath}`);
      }
      if (isExcluded(relPath)) continue;

      const absFile = path.join(absDir, entry.name);
      let buffer;
      try {
        buffer = fs.readFileSync(absFile);
      } catch (error) {
        throw new ManifestError(`读取文件失败：${relPath}（${error.code || error.message}）`);
      }
      files.push({
        path: toPosix(relPath),
        sha256: sha256Buffer(buffer),
        bytes: buffer.length
      });
    }
  }

  files.sort((a, b) => compareUtf8(a.path, b.path));

  return {
    files,
    inventoryHash: computeInventoryHash(files)
  };
}

/**
 * inventoryHash 的唯一实现：按清单顺序拼接 path\tsha256\n 后取 SHA-256。
 * 口径与 tools/export-public.js 一致；bytes 仍保留在 files[] 中供人阅读与校验。
 * @param {Array<{path: string, sha256: string, bytes: number}>} files
 */
function computeInventoryHash(files) {
  const lines = files.map((file) => `${file.path}\t${file.sha256}\n`);
  return sha256Buffer(Buffer.from(lines.join(''), 'utf8'));
}

function validateManifestShape(manifest, sourceLabel) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new ManifestError(`${sourceLabel} 不是 JSON 对象`);
  }
  if (!Array.isArray(manifest.files)) {
    throw new ManifestError(`${sourceLabel} 缺少 files 数组`);
  }
  if (typeof manifest.inventoryHash !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.inventoryHash)) {
    throw new ManifestError(`${sourceLabel} 的 inventoryHash 不是 64 位小写十六进制`);
  }
  for (const [index, file] of manifest.files.entries()) {
    if (!file || typeof file !== 'object') {
      throw new ManifestError(`${sourceLabel} files[${index}] 不是对象`);
    }
    if (typeof file.path !== 'string' || file.path === '' || file.path.startsWith('/') || file.path.includes('\\')) {
      throw new ManifestError(`${sourceLabel} files[${index}].path 必须是相对 POSIX 路径`);
    }
    if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new ManifestError(`${sourceLabel} files[${index}].sha256 不是 64 位小写十六进制`);
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new ManifestError(`${sourceLabel} files[${index}].bytes 必须是非负整数`);
    }
  }
}

function compareManifests(expected, actual) {
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

function writeAtomic(outPath, content) {
  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${outPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tempPath, content, { mode: 0o644 });
    fs.renameSync(tempPath, outPath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // 清理失败不覆盖原始错误
    }
    throw new ManifestError(`写入清单失败：${outPath}（${error.code || error.message}）`);
  }
}

function readManifest(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ManifestError(`读取清单失败：${filePath}（${error.code || error.message}）`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ManifestError(`清单不是合法 JSON：${filePath}（${error.message}）`);
  }
  validateManifestShape(parsed, filePath);
  return parsed;
}

function printSummary(summary, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return;
  }
  process.stdout.write(`目录        : ${summary.dir}\n`);
  process.stdout.write(`文件数      : ${summary.files}\n`);
  process.stdout.write(`inventoryHash: ${summary.inventoryHash}\n`);
  if (summary.out) process.stdout.write(`清单文件    : ${summary.out}\n`);
  if (summary.check) {
    process.stdout.write(`校验结果    : ${summary.ok ? '一致' : '不一致'}（${summary.check}）\n`);
    for (const problem of summary.problems || []) {
      process.stdout.write(`  - ${problem}\n`);
    }
  }
  process.stdout.write(`清单算法    : ${INVENTORY_ALGORITHM}\n`);
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`[release-manifest] ${error.message}\n用 --help 查看用法。\n`);
    return error.exitCode || 2;
  }
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }

  const dirAbs = path.resolve(options.dir);
  const manifest = buildManifest(dirAbs, { excludes: options.excludes });

  if (options.check) {
    const expected = readManifest(path.resolve(options.check));
    const problems = compareManifests(expected, manifest);
    const summary = {
      ok: problems.length === 0,
      dir: dirAbs,
      check: path.resolve(options.check),
      files: manifest.files.length,
      inventoryHash: manifest.inventoryHash,
      expectedInventoryHash: expected.inventoryHash,
      problems
    };
    printSummary(summary, options.json);
    if (problems.length > 0) {
      process.stderr.write(`[release-manifest] 校验失败：${problems.length} 处不一致\n`);
      return 1;
    }
    return 0;
  }

  const jsonText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (options.out) {
    const outAbs = path.resolve(options.out);
    if (isInside(outAbs, dirAbs)) {
      throw new ManifestError(`--out 不得位于被扫描目录内部：${outAbs}`);
    }
    writeAtomic(outAbs, jsonText);
    printSummary(
      {
        ok: true,
        dir: dirAbs,
        files: manifest.files.length,
        inventoryHash: manifest.inventoryHash,
        out: outAbs
      },
      options.json
    );
    return 0;
  }

  process.stdout.write(options.json ? `${JSON.stringify(manifest)}\n` : jsonText);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof ManifestError) {
      process.stderr.write(`[release-manifest] ${error.message}\n`);
      process.exitCode = error.exitCode;
    } else {
      process.stderr.write(`[release-manifest] 未预期错误：${error && error.stack ? error.stack : error}\n`);
      process.exitCode = 1;
    }
  }
}

module.exports = {
  INVENTORY_ALGORITHM,
  buildManifest,
  computeInventoryHash,
  compareManifests,
  validateManifestShape,
  main
};