#!/usr/bin/env node
'use strict';

/**
 * B03 私有路径 / 导入闭包 / 未选模块依赖检查
 *
 * 对应方案：§2.3（可重复发布、包内不得引用私有工作区）、§4.2（模块清单与
 * 按需装配）、§4.3（未安装模块不导入代码）。
 *
 * 用法：
 *   node tools/check-imports.js [--root DIR] [--modules a,b,c] [--strict]
 *                               [--exclude GLOB]... [--help]
 *
 * 检查项：
 *   a) require / import 指向旧 site 源码（source/site/，public-release 之外）、
 *      本机绝对路径、相对导入逃逸出扫描根目录；另对任意行扫描本机绝对路径
 *      字面量与私有网段（100.6x / 100.8x / 100.1xx、10.129.、*.ts.net）；
 *   b) require / import 指向未选模块目录 modules/<id>/；
 *   c) 出现禁止关键字（Forum、Jupyter、undercover、kesi、shigang、resume、
 *      qoder、storage3、myc）。
 *
 * 输出：stdout 一段 JSON
 *   { filesScanned, filesExempted, filesKeywordExempted, modulesSelected,
 *     violations: [{ file, line, rule, detail }], summary }
 * 退出码：0 = 无违规；1 = 有违规；2 = 用法/环境错误。
 *
 * 默认豁免（--strict 关闭）：
 *   - 全量豁免：M0 审计证据 docs/m0/、检查器自身与其负向用例；
 *   - 仅关键字豁免：现有负向用例里的非法模块 ID 字面量。
 * 另外，Markdown 中明确表达“排除/禁止”语义的行允许点名称，避免把发布声明
 * （如“公开包不得包含 Jupyter”）误判为引用；其余正文照查。
 * 理由见 DEFAULT_EXEMPTIONS；豁免只影响本检查器，不改变被检查文件。--strict
 * 会全量扫描，用来看清审计文档里保留的发布前脱敏欠账。
 *
 * 只使用 Node 内置模块；只读，不写任何文件。
 */

const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_DIR = __dirname;
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

// 任务要求 .js/.json/.yml/.md；同时覆盖 .cjs/.mjs/.yaml 这三种等价扩展名。
const SCAN_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.json', '.yml', '.yaml', '.md']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'coverage', '.cache']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const RULES = {
  LEGACY_SOURCE: 'legacy-source',
  ABSOLUTE_PATH: 'absolute-path',
  PRIVATE_NETWORK: 'private-network',
  PATH_ESCAPE: 'path-escape',
  UNSELECTED_MODULE: 'unselected-module',
  FORBIDDEN_KEYWORD: 'forbidden-keyword'
};

// 禁止关键字：按“词首边界 + 不区分大小写”匹配，能覆盖 ForumPost、FORUM_UPLOAD_DIR、
// jupyter-routes、storage3-routes、myc-site 这类真实标识符写法。
const FORBIDDEN_KEYWORDS = ['Forum', 'Jupyter', 'undercover', 'kesi', 'shigang', 'resume', 'qoder', 'storage3', 'myc'];
const KEYWORD_PATTERN_SOURCE = `(^|[^A-Za-z0-9_])(${FORBIDDEN_KEYWORDS.map(escapeRegExp).join('|')})`;

const PRIVATE_NETWORK_PATTERNS = [
  { label: '100.6x / 100.8x / 100.1xx 私有网段', re: /\b100\.(?:6\d|8\d|1\d{2})\.\d{1,3}\.\d{1,3}\b/ },
  { label: '10.129. 校园内网', re: /\b10\.129\.\d{1,3}\.\d{1,3}\b/ },
  { label: '*.ts.net Tailnet 主机名', re: /\b(?:[A-Za-z0-9-]+\.)+ts\.net\b/i }
];

// 默认豁免：这些文件不是“引用”私有实现，而是“记录/声明/自测”这些名称。
// rules 省略 = 整个文件跳过；rules 只列 forbidden-keyword = 只放过正文里的
// 产品名，私有路径/私网地址/导入闭包仍然照查。--strict 关闭全部默认豁免。
const DEFAULT_EXEMPTIONS = [
  {
    pattern: 'tools/check-imports.js',
    reason: '检查器自身必须包含规则字面量（自引用）'
  },
  {
    pattern: 'tests/contracts/imports.test.js',
    reason: '负向用例需要内嵌违规样本（自引用）'
  },
  {
    pattern: 'tests/contracts/registry.test.js',
    reason: '现有负向用例以 jupyter 作为非法模块 ID 字面量，不是产品引用',
    rules: [RULES.FORBIDDEN_KEYWORD]
  },
  {
    pattern: 'docs/m0/**',
    reason: 'M0 审计证据按 A05 口径保留私网地址与排除产品名；发布前由脱敏/白名单流程处理'
  },
  {
    pattern: 'tools/verify-release.js',
    reason: '发布检查器本身必须定义“本机路径/私网/Tailnet/排除产品名”的检测正则，属规则字面量自引用'
  },
  {
    pattern: 'CONTRIBUTING.md',
    reason: '贡献规范必须举例说明被禁止的本机绝对路径写法（规则说明，非真实引用）'
  },
  {
    pattern: 'docs/release-checklist.md',
    reason: '发布清单逐条登记 B8（个人邮箱/本机路径）及被排除产品名，属发布证据；代码路径仍全量扫描'
  }
];

// Markdown 里的“排除声明”会合法点名被禁止的产品（例如“公开包不得包含 Jupyter”）。
// 只在这一行明确表达排除语义时放行关键字；正文若把产品名当功能/依赖引用仍会报。
const EXCLUSION_CONTEXT_RE = /不得包含|不包含|不能包含|不得出现|不得使用|不含|不导出|排除|禁止|not\s+(?:include|contain)|must\s+not|exclude[sd]?|forbidden|prohibit/i;

const IMPORT_PATTERNS = [
  { kind: 'require', re: /\brequire\s*\(\s*(['"`])([^'"`\r\n]+)\1\s*\)/g },
  { kind: 'require.resolve', re: /\brequire\.resolve\s*\(\s*(['"`])([^'"`\r\n]+)\1/g },
  { kind: 'dynamic import', re: /\bimport\s*\(\s*(['"`])([^'"`\r\n]+)\1\s*\)/g },
  { kind: 'import', re: /\bimport\s+(?:[\w*{}\s,$]+\s+from\s+)?(['"])([^'"\r\n]+)\1/g },
  { kind: 'export from', re: /\bexport\s+(?:[\w*{}\s,$]+\s+)?from\s+(['"])([^'"\r\n]+)\1/g }
];

const IGNORE_LINE_RE = /check-imports:ignore(?!-)/;
const IGNORE_NEXT_RE = /check-imports:ignore-next-line/;
const IGNORE_FILE_RE = /check-imports:ignore-file/;

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 把 glob 编译成相对路径正则；支持 **、*、?。
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
      out += escapeRegExp(ch);
    }
  }
  return new RegExp(`${out}$`);
}

function parseArgs(argv) {
  const opts = { root: DEFAULT_ROOT, modules: null, strict: false, excludes: [], help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--strict' || arg === '--no-default-exempt') {
      opts.strict = true;
    } else if (arg === '--root') {
      if (i + 1 >= argv.length) throw new UsageError('--root 缺少目录参数');
      opts.root = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--root=')) {
      opts.root = arg.slice('--root='.length);
    } else if (arg === '--modules') {
      if (i + 1 >= argv.length) throw new UsageError('--modules 缺少参数（例如 pages,mail 或 none）');
      opts.modules = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--modules=')) {
      opts.modules = arg.slice('--modules='.length);
    } else if (arg === '--exclude') {
      if (i + 1 >= argv.length) throw new UsageError('--exclude 缺少 glob 参数');
      opts.excludes.push(...splitList(argv[i + 1]));
      i += 1;
    } else if (arg.startsWith('--exclude=')) {
      opts.excludes.push(...splitList(arg.slice('--exclude='.length)));
    } else {
      throw new UsageError(`未知参数：${arg}`);
    }
  }
  return opts;
}

class UsageError extends Error {}

function splitList(value) {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function printHelp() {
  const lines = [
    'B03 私有路径 / 导入闭包 / 未选模块依赖检查',
    '',
    '用法：',
    '  node tools/check-imports.js [--root DIR] [--modules a,b,c] [--strict] [--exclude GLOB]...',
    '',
    '参数：',
    '  --root DIR        扫描根目录，默认是本检查器上一级（公开版根目录）',
    '  --modules a,b,c   本次选择安装的模块 ID；默认取 modules/ 下已存在的全部目录。',
    '                    none 或空字符串表示一个模块都未选，此时任何 modules/<id>/ 导入都算违规',
    '  --strict          关闭默认豁免，全量扫描审计文档、发布声明与检查器自身',
    '  --exclude GLOB    追加排除（可重复，也可逗号分隔），匹配相对扫描根的 POSIX 路径',
    '  --help            显示本帮助',
    '',
    '扫描范围：.js/.cjs/.mjs/.json/.yml/.yaml/.md；跳过 .git、node_modules、虚拟环境与构建产物。',
    '',
    '退出码：0 = 无违规；1 = 检出违规；2 = 用法/环境错误。',
    'stdout 只输出 JSON：{ filesScanned, filesExempted, filesKeywordExempted, modulesSelected, violations, summary }。',
    '',
    '行内豁免：在被检查行写 `check-imports:ignore`，或在上一行写',
    '`check-imports:ignore-next-line`；文件前 10 行写 `check-imports:ignore-file` 跳过整个文件。'
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function discoverModules(root) {
  const modulesDir = path.join(root, 'modules');
  let entries;
  try {
    entries = fs.readdirSync(modulesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

function resolveSelection(opts, discovered) {
  if (opts.modules === null) return discovered.slice();
  const raw = String(opts.modules).trim();
  if (raw === '' || raw.toLowerCase() === 'none') return [];
  if (raw.toLowerCase() === 'all') return discovered.slice();
  const selected = splitList(raw);
  const unknown = selected.filter((id) => !discovered.includes(id));
  if (unknown.length > 0) {
    process.stderr.write(`[check-imports] 提示：--modules 中的 ${unknown.join(', ')} 不在 modules/ 下，仍按“已选择”处理\n`);
  }
  return selected;
}

function buildExemptions(opts) {
  const list = opts.strict ? [] : DEFAULT_EXEMPTIONS.slice();
  for (const pattern of opts.excludes) {
    list.push({ pattern, reason: '命令行 --exclude' });
  }
  return list.map((item) => ({ ...item, regex: globToRegExp(item.pattern) }));
}

function isExempt(relFile, exemptions) {
  return exemptions.find((item) => item.regex.test(relFile)) || null;
}

// 文件级豁免返回 'all'；仅关键字豁免返回 'keyword'；未命中返回 null。
function exemptionMode(exemption) {
  if (!exemption) return null;
  if (!exemption.rules) return 'all';
  if (exemption.rules.includes(RULES.FORBIDDEN_KEYWORD)) return 'keyword';
  return null;
}

function walkScannableFiles(root) {
  const files = [];
  const stack = [''];
  while (stack.length > 0) {
    const relDir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(rel);
      } else if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(rel);
      }
    }
  }
  files.sort();
  return files;
}

function maskSensitive(text) {
  return String(text)
    .replace(/\/Users\/[^/\s'"`]+/g, '/Users/<user>')
    .replace(/[A-Za-z]:\\Users\\[^\\\s'"`]+/g, 'C:\\Users\\<user>')
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '***.***.***.***')
    .replace(/\b(?:[A-Za-z0-9-]+\.)+ts\.net\b/gi, '<host>.ts.net');
}

function snippet(text, limit = 160) {
  const value = String(text).trim().replace(/\s+/g, ' ');
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function addViolation(state, file, line, rule, detail) {
  const dedupe = `${file}\u0000${line}\u0000${rule}\u0000${rule === RULES.FORBIDDEN_KEYWORD ? detail : ''}`;
  if (state.seen.has(dedupe)) return;
  state.seen.add(dedupe);
  state.violations.push({ file, line, rule, detail: maskSensitive(detail) });
}

// 在（已把反斜杠归一成 / 的）一行里找 source/site 引用，允许 source/site/public-release。
function legacyMentions(line) {
  const normalized = line.replace(/\\/g, '/');
  const hits = [];
  let from = 0;
  while (from < normalized.length) {
    const index = normalized.indexOf('source/site', from);
    if (index === -1) break;
    const after = normalized.slice(index + 'source/site'.length);
    if (!after.startsWith('/public-release')) {
      hits.push(normalized.slice(Math.max(0, index - 24), index + 'source/site'.length + 32));
    }
    from = index + 'source/site'.length;
  }
  return hits;
}

function findKeywords(line) {
  const re = new RegExp(KEYWORD_PATTERN_SOURCE, 'gi');
  const found = [];
  let match;
  while ((match = re.exec(line)) !== null) {
    if (match.index === re.lastIndex) re.lastIndex += 1;
    // resume 同时是普通英文词（resumed / resumption）、方法/接口名（socket.resume()、
    // resumeTask()、/tasks/:id/resume）。只在“看起来像产品标识”时算违规：独立单词、
    // resume-server、resume.js 等；字母续写、属性访问与路径片段放行，避免把“恢复”
    // 这类正常语义当成私有产品。
    // 捕获组 1 是关键字前的分隔符（行首时为空），不是前一个字符。
    const prevChar = match[1] || '';
    const nextChar = line[match.index + match[0].length] || '';
    if (match[2].toLowerCase() === 'resume') {
      const wordContinuation = /[A-Za-z]/.test(nextChar) || nextChar === '(';
      const propertyAccess = prevChar === '.';
      const pathSegment = /[/\\]/.test(prevChar) && !/[A-Za-z0-9_-]/.test(nextChar);
      if (wordContinuation || propertyAccess || pathSegment) {
        continue;
      }
    }
    found.push(match[2]);
  }
  return found;
}

function isLegacyAbsolutePath(target) {
  const parts = target.split(path.sep);
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i] === 'source' && parts[i + 1] === 'site') {
      return parts[i + 2] !== 'public-release';
    }
  }
  return false;
}

function moduleIdOfRelative(relPath) {
  const posix = relPath.split(path.sep).join('/');
  if (!posix.startsWith('modules/')) return null;
  const rest = posix.slice('modules/'.length);
  if (rest === '') return null;
  const slash = rest.indexOf('/');
  // modules/<id> 目录本身（无尾斜杠）也算；modules/foo.js 这种文件不算模块 ID。
  if (slash === -1) return rest.includes('.') ? null : rest;
  if (slash === 0) return null;
  return rest.slice(0, slash);
}

function checkSpecifier(state, fileRel, lineNumber, spec, kind) {
  const target = String(spec).trim();
  if (target === '') return;
  if (target.startsWith('node:') || target.startsWith('data:')) return;

  if (legacyMentions(target).length > 0) {
    addViolation(state, fileRel, lineNumber, RULES.LEGACY_SOURCE, `${kind} 指向旧 site 源码区：${snippet(target)}`);
    return;
  }

  const isAbsolute = target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith('file://');
  if (isAbsolute) {
    addViolation(state, fileRel, lineNumber, RULES.ABSOLUTE_PATH, `${kind} 使用本机绝对路径：${snippet(target)}`);
    return;
  }

  // 只解析相对导入：裸包名（node:、express、@scope/pkg）属于依赖声明范围，不在此检查。
  if (!target.startsWith('.')) return;

  const absTarget = path.resolve(path.dirname(path.join(state.root, fileRel)), target);
  const relTarget = path.relative(state.root, absTarget);
  if (relTarget.startsWith('..') || path.isAbsolute(relTarget)) {
    addViolation(state, fileRel, lineNumber, RULES.PATH_ESCAPE, `${kind} 逃逸出扫描根目录：${snippet(target)}`);
    return;
  }
  if (isLegacyAbsolutePath(absTarget)) {
    addViolation(state, fileRel, lineNumber, RULES.LEGACY_SOURCE, `${kind} 指向旧 site 源码区：${snippet(target)}`);
    return;
  }
  const moduleId = moduleIdOfRelative(relTarget);
  if (moduleId && !state.selected.has(moduleId)) {
    // 未选模块自身的代码不会被装配加载，它内部/跨模块的相对导入不构成
    // “本次选择”的依赖；真正要拦的是 core（始终装配）与已选模块对未选模块的依赖。
    const importerModule = moduleIdOfRelative(fileRel);
    const importerUnselected = importerModule !== null && !state.selected.has(importerModule);
    if (!importerUnselected) {
      addViolation(
        state,
        fileRel,
        lineNumber,
        RULES.UNSELECTED_MODULE,
        `${kind} 导入未选模块 modules/${moduleId}/（本次选择：${state.selected.size > 0 ? [...state.selected].join(',') : '无'}）：${snippet(target)}`
      );
    }
  }
}

function scanLine(state, fileRel, line, lineNumber) {
  for (const pattern of PRIVATE_NETWORK_PATTERNS) {
    if (pattern.re.test(line)) {
      addViolation(state, fileRel, lineNumber, RULES.PRIVATE_NETWORK, `${pattern.label}：${snippet(line)}`);
    }
  }

  if (/\/Users\/[^/\s'"`]/.test(line) || /[A-Za-z]:\\Users\\[^\\\s'"`]/.test(line)) {
    addViolation(state, fileRel, lineNumber, RULES.ABSOLUTE_PATH, `本机绝对路径引用：${snippet(line)}`);
  }

  // source/site 只在“导入目标”里算违规：审计文档、注释和导出工具会在正文里
  // 合法地提到旧源码根，按导入闭包口径不应误报（见 scanLine 上方 checkSpecifier）。
  if (!state.skipKeyword) {
    const exclusionStatement = state.isMarkdown && EXCLUSION_CONTEXT_RE.test(line);
    if (!exclusionStatement) {
      for (const keyword of findKeywords(line)) {
        addViolation(state, fileRel, lineNumber, RULES.FORBIDDEN_KEYWORD, `出现禁止关键字：${keyword}`);
      }
    }
  }

  if (!state.jsLike) return;
  for (const pattern of IMPORT_PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags);
    let match;
    while ((match = re.exec(line)) !== null) {
      checkSpecifier(state, fileRel, lineNumber, match[2], `${pattern.kind}()`);
      if (match.index === re.lastIndex) re.lastIndex += 1;
    }
  }
}

function scanFile(state, relFile) {
  const absFile = path.join(state.root, relFile);
  let stat;
  try {
    stat = fs.statSync(absFile);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return false;

  let text;
  try {
    text = fs.readFileSync(absFile, 'utf8');
  } catch {
    return false;
  }
  if (text.includes('\u0000')) return false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM，保证首行 ^ 锚点可用

  const lines = text.split(/\r?\n/);
  if (lines.slice(0, 10).some((line) => IGNORE_FILE_RE.test(line))) return false;

  const ext = path.extname(relFile).toLowerCase();
  state.jsLike = ext === '.js' || ext === '.cjs' || ext === '.mjs';
  state.isMarkdown = ext === '.md';

  for (let i = 0; i < lines.length; i += 1) {
    if (IGNORE_LINE_RE.test(lines[i])) continue;
    if (i > 0 && IGNORE_NEXT_RE.test(lines[i - 1])) continue;
    scanLine(state, relFile, lines[i], i + 1);
  }
  return true;
}

function summarize(violations) {
  const byRule = {};
  for (const violation of violations) {
    byRule[violation.rule] = (byRule[violation.rule] || 0) + 1;
  }
  return { violationCount: violations.length, byRule };
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`[check-imports] ${error.message}\n`);
    process.stderr.write('用 --help 查看用法。\n');
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    printHelp();
    return;
  }

  const root = path.resolve(opts.root);
  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch {
    process.stderr.write(`[check-imports] 扫描根目录不存在：${root}\n`);
    process.exitCode = 2;
    return;
  }
  if (!rootStat.isDirectory()) {
    process.stderr.write(`[check-imports] 扫描根目录不是目录：${root}\n`);
    process.exitCode = 2;
    return;
  }

  const discovered = discoverModules(root);
  const selected = resolveSelection(opts, discovered);
  const exemptions = buildExemptions(opts);

  const state = {
    root,
    selected: new Set(selected),
    violations: [],
    seen: new Set(),
    jsLike: false,
    isMarkdown: false,
    skipKeyword: false
  };

  const files = walkScannableFiles(root);
  let filesScanned = 0;
  let filesExempted = 0;
  let filesKeywordExempted = 0;
  for (const relFile of files) {
    const exemption = isExempt(relFile, exemptions);
    const mode = exemptionMode(exemption);
    if (mode === 'all') {
      filesExempted += 1;
      continue;
    }
    state.skipKeyword = mode === 'keyword';
    if (scanFile(state, relFile)) {
      filesScanned += 1;
      if (state.skipKeyword) filesKeywordExempted += 1;
    }
  }

  state.violations.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0;
  });

  const result = {
    filesScanned,
    filesExempted,
    filesKeywordExempted,
    modulesSelected: selected,
    violations: state.violations,
    summary: summarize(state.violations)
  };
  if (state.violations.length > 0) process.exitCode = 1;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main(process.argv.slice(2));
