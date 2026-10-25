#!/usr/bin/env node
'use strict';

/**
 * 全量测试入口（P7，方案 §2.3、§13.4）
 *
 * 发现并逐个运行：
 *   - tests/** 下的测试文件；
 *   - modules/<id>/tests/** 下的测试文件。
 *
 * 每个文件单独调用 `node --test --test-reporter=tap <file>`，这样：
 *   - 一个文件崩溃或超时不会吞掉其他文件的结果；
 *   - 可以按文件汇总 pass/fail，CI 里能直接看出是哪个模块失败。
 *
 * 只使用 Node 内置模块。退出码：0 = 全部通过；1 = 有失败/无测试文件；2 = 用法错误。
 *
 * 用法：
 *   node tools/test-all.js
 *   node tools/test-all.js --json
 *   node tools/test-all.js --filter '^modules/disk/'
 *   node tools/test-all.js --file tests/integration/core-boot.test.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_TEST_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 64 * 1024 * 1024;

// 与 Node 自带测试发现规则等价的常见命名：foo.test.js、foo-test.js、foo_test.js、test-foo.js、test.js。
const TEST_FILE_RE = /^(?:test-.+|.+[._-]test|test)\.(?:js|cjs|mjs)$/i;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

class UsageError extends Error {}

function usage() {
  return `PagesAI 全量测试

用法：
  node tools/test-all.js [选项]

选项：
  --root DIR         公开版根目录，默认是本工具上一级
  --filter REGEX     只运行相对路径匹配该正则的测试文件（可重复）
  --file FILE        只运行指定测试文件（可重复；相对 --root）
  --timeout MS       单个测试文件的总超时，默认 ${DEFAULT_TIMEOUT_MS}
  --test-timeout MS  传给 node --test 的单条用例超时，默认 ${DEFAULT_TEST_TIMEOUT_MS}
  --fail-fast        第一个失败后停止
  --json             只向 stdout 输出汇总 JSON（进度与错误走 stderr）
  --list             只列出将运行的测试文件，不执行
  -h, --help         显示本帮助

扫描范围：
  tests/** 与 modules/<id>/tests/** 下的 *.test.js / *.test.cjs / *.test.mjs，
  以及 test-*.js、*-test.js、*_test.js、test.js。

退出码：0 全部通过；1 有失败或未发现测试文件；2 用法错误。
`;
}

function parseArgs(argv) {
  const options = {
    root: DEFAULT_ROOT,
    filters: [],
    files: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    testTimeoutMs: DEFAULT_TEST_TIMEOUT_MS,
    failFast: false,
    json: false,
    list: false,
    help: false
  };

  const takeValue = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new UsageError(`${flag} 缺少参数值`);
    }
    return value;
  };
  const positiveInt = (value, flag) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new UsageError(`${flag} 必须是正整数毫秒数`);
    }
    return number;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--root') {
      options.root = takeValue(i, arg);
      i += 1;
    } else if (arg.startsWith('--root=')) {
      options.root = arg.slice('--root='.length);
    } else if (arg === '--filter') {
      options.filters.push(takeValue(i, arg));
      i += 1;
    } else if (arg.startsWith('--filter=')) {
      options.filters.push(arg.slice('--filter='.length));
    } else if (arg === '--file') {
      options.files.push(takeValue(i, arg));
      i += 1;
    } else if (arg.startsWith('--file=')) {
      options.files.push(arg.slice('--file='.length));
    } else if (arg === '--timeout') {
      options.timeoutMs = positiveInt(takeValue(i, arg), arg);
      i += 1;
    } else if (arg.startsWith('--timeout=')) {
      options.timeoutMs = positiveInt(arg.slice('--timeout='.length), '--timeout');
    } else if (arg === '--test-timeout') {
      options.testTimeoutMs = positiveInt(takeValue(i, arg), arg);
      i += 1;
    } else if (arg.startsWith('--test-timeout=')) {
      options.testTimeoutMs = positiveInt(arg.slice('--test-timeout='.length), '--test-timeout');
    } else if (arg === '--fail-fast') {
      options.failFast = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--list') {
      options.list = true;
    } else {
      throw new UsageError(`未知参数：${arg}`);
    }
  }

  return options;
}

function compareUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

function walkTestFiles(root, relDir, out) {
  const absDir = path.join(root, relDir);
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => compareUtf8(a.name, b.name));
  for (const entry of entries) {
    const rel = relDir === '' ? entry.name : path.join(relDir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkTestFiles(root, rel, out);
    } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      out.push(toPosix(rel));
    }
  }
}

function discoverTestFiles(root) {
  const files = [];
  const scannedRoots = [];

  const testsDir = path.join(root, 'tests');
  if (fs.existsSync(testsDir) && fs.statSync(testsDir).isDirectory()) {
    scannedRoots.push('tests/');
    walkTestFiles(root, 'tests', files);
  }

  const modulesDir = path.join(root, 'modules');
  if (fs.existsSync(modulesDir) && fs.statSync(modulesDir).isDirectory()) {
    const modules = fs
      .readdirSync(modulesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort(compareUtf8);
    for (const id of modules) {
      const rel = path.join('modules', id, 'tests');
      if (!fs.existsSync(path.join(root, rel)) || !fs.statSync(path.join(root, rel)).isDirectory()) continue;
      scannedRoots.push(`${toPosix(rel)}/`);
      walkTestFiles(root, rel, files);
    }
  }

  return { files: [...new Set(files)].sort(compareUtf8), scannedRoots };
}

function parseTap(output) {
  const counts = { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0, cancelled: 0 };
  const seen = new Set();
  const failures = [];
  for (const line of String(output).split(/\r?\n/)) {
    const summary = /^# (tests|pass|fail|skipped|todo|cancelled) (\d+)$/.exec(line);
    if (summary) {
      counts[summary[1]] = Number(summary[2]);
      seen.add(summary[1]);
      continue;
    }
    const failed = /^not ok \d+ - (.*)$/.exec(line);
    if (failed) failures.push(failed[1].trim());
  }
  return { counts, failures, hasSummary: seen.has('tests') };
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function runOne(root, relFile, options) {
  const started = process.hrtime.bigint();
  const args = ['--test', '--test-reporter=tap'];
  if (options.testTimeoutMs > 0) args.push(`--test-timeout=${options.testTimeoutMs}`);
  args.push(relFile);

  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;

  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT';
    return {
      file: relFile,
      status: 'fail',
      durationMs,
      counts: { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0, cancelled: 0 },
      failures: [
        timedOut
          ? `文件超时（>${options.timeoutMs}ms），已强制终止`
          : `无法启动测试进程：${result.error.message}`
      ],
      timedOut,
      exitCode: null,
      stderr: ''
    };
  }

  const output = `${result.stdout || ''}`;
  const parsed = parseTap(output);
  const timedOut = result.signal === 'SIGKILL' && durationMs >= options.timeoutMs - 50;
  const failed =
    result.status !== 0 || parsed.counts.fail > 0 || !parsed.hasSummary || timedOut || result.signal !== null;

  if (failed && parsed.failures.length === 0) {
    if (timedOut) parsed.failures.push(`文件超时（>${options.timeoutMs}ms），已强制终止`);
    else if (result.signal) parsed.failures.push(`测试进程被信号 ${result.signal} 终止`);
    else if (!parsed.hasSummary) parsed.failures.push('测试进程未输出 TAP 汇总（崩溃或未发现用例）');
    else parsed.failures.push(`测试进程退出码 ${result.status}`);
  }

  return {
    file: relFile,
    status: failed ? 'fail' : 'pass',
    durationMs,
    counts: parsed.counts,
    failures: parsed.failures,
    timedOut,
    exitCode: result.status,
    stderr: `${result.stderr || ''}`.trim()
  };
}

function printHuman(summary) {
  process.stdout.write('PagesAI 全量测试\n');
  process.stdout.write(`根目录      : ${summary.root}\n`);
  process.stdout.write(`扫描范围    : ${summary.scannedRoots.join('、') || '（无）'}\n`);
  process.stdout.write(`测试文件数  : ${summary.filesTotal}\n`);
  process.stdout.write('\n');

  for (const result of summary.results) {
    const mark = result.status === 'pass' ? 'PASS' : 'FAIL';
    const counts = result.counts;
    process.stdout.write(
      `[${mark}] ${result.file}  (${counts.pass} 通过 / ${counts.fail} 失败，${formatDuration(result.durationMs)})\n`
    );
    if (result.status === 'fail') {
      for (const failure of result.failures.slice(0, 20)) {
        process.stdout.write(`        - ${failure}\n`);
      }
      if (result.failures.length > 20) process.stdout.write(`        - …另有 ${result.failures.length - 20} 条\n`);
      process.stdout.write(`        单独复跑：node --test ${result.file}\n`);
    }
  }

  const totals = summary.totals;
  process.stdout.write('\n');
  process.stdout.write(
    `汇总: 文件 ${summary.filesTotal}（通过 ${summary.filesPassed}，失败 ${summary.filesFailed}）｜` +
      `用例 ${totals.tests}（通过 ${totals.pass}，失败 ${totals.fail}，跳过 ${totals.skipped}，待办 ${totals.todo}，取消 ${totals.cancelled}）｜` +
      `耗时 ${formatDuration(summary.durationMs)}\n`
  );
  if (summary.filesFailed > 0) {
    process.stdout.write('结论: 失败。先按上面的“单独复跑”命令定位，再修对应模块或测试。\n');
  } else {
    process.stdout.write('结论: 全部通过。\n');
  }
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`[test-all] ${error.message}\n用 --help 查看用法。\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }

  const root = path.resolve(options.root);
  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch {
    process.stderr.write(`[test-all] 根目录不存在：${root}\n`);
    return 2;
  }
  if (!rootStat.isDirectory()) {
    process.stderr.write(`[test-all] 根目录不是目录：${root}\n`);
    return 2;
  }

  const discovered = discoverTestFiles(root);
  let files = discovered.files;

  if (options.files.length > 0) {
    const requested = options.files.map((file) => toPosix(path.normalize(file)).replace(/^\.\//, ''));
    const missing = requested.filter((file) => !fs.existsSync(path.join(root, file)));
    if (missing.length > 0) {
      process.stderr.write(`[test-all] 指定的测试文件不存在：${missing.join(', ')}\n`);
      return 2;
    }
    files = requested.sort(compareUtf8);
  } else if (options.filters.length > 0) {
    let regexes;
    try {
      regexes = options.filters.map((filter) => new RegExp(filter));
    } catch (error) {
      process.stderr.write(`[test-all] --filter 不是合法正则：${error.message}\n`);
      return 2;
    }
    files = files.filter((file) => regexes.some((regex) => regex.test(file)));
  }

  if (options.list) {
    for (const file of files) process.stdout.write(`${file}\n`);
    return 0;
  }

  if (files.length === 0) {
    process.stderr.write(
      `[test-all] 未发现测试文件（扫描范围：${discovered.scannedRoots.join('、') || '无'}）。\n`
    );
    return 1;
  }

  const started = process.hrtime.bigint();
  const results = [];
  let stopped = false;

  for (const [index, file] of files.entries()) {
    if (!options.json) {
      process.stdout.write(`[${index + 1}/${files.length}] 运行 ${file} …\n`);
    } else {
      process.stderr.write(`[${index + 1}/${files.length}] ${file}\n`);
    }
    const result = runOne(root, file, options);
    results.push(result);
    if (result.status === 'fail' && options.failFast) {
      stopped = true;
      break;
    }
  }

  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const totals = { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0, cancelled: 0 };
  for (const result of results) {
    for (const key of Object.keys(totals)) totals[key] += result.counts[key] || 0;
  }

  const summary = {
    ok: results.every((result) => result.status === 'pass'),
    root,
    node: process.version,
    scannedRoots: discovered.scannedRoots,
    filesTotal: files.length,
    filesRun: results.length,
    filesPassed: results.filter((result) => result.status === 'pass').length,
    filesFailed: results.filter((result) => result.status === 'fail').length,
    stopped,
    durationMs: Math.round(durationMs),
    totals,
    failures: results
      .filter((result) => result.status === 'fail')
      .map((result) => ({ file: result.file, names: result.failures })),
    results
  };

  if (options.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
  else printHuman(summary);

  return summary.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  parseTap,
  discoverTestFiles,
  main
};