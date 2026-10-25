'use strict';

// P1 / B03 契约测试：私有路径、导入闭包与未选模块依赖检查。
// 运行：node --test tests/contracts/imports.test.js
//
// 负向用例在临时目录里构造 4 类违规样本（私有路径、私网地址、未选模块、
// 禁止关键字），全部通过 child_process 调用真实 CLI 断言；再做干净样本
// 与“当前公开版根目录”结果的断言。

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PUBLIC_ROOT = path.resolve(__dirname, '..', '..');
const TOOL = path.join(PUBLIC_ROOT, 'tools', 'check-imports.js');

function runTool(args, options = {}) {
  const result = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: PUBLIC_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    ...options
  });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { result, json };
}

function makeTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagesai-imports-'));
  for (const [relFile, content] of Object.entries(files)) {
    const absFile = path.join(dir, relFile);
    fs.mkdirSync(path.dirname(absFile), { recursive: true });
    fs.writeFileSync(absFile, content, 'utf8');
  }
  return dir;
}

function cleanup(t, dir) {
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function findViolation(json, rule, file) {
  return json.violations.find((entry) => entry.rule === rule && entry.file === file);
}

test('负向：4 类违规样本全部检出，且不误报已选模块', (t) => {
  const dir = makeTree({
    // 1) 私有路径：旧 site 源码 + 本机绝对路径
    'src/legacy.js': [
      "'use strict';",
      "const old = require('../../../source/site/uniflourish/server/index.js');",
      'module.exports = old;'
    ].join('\n'),
    'src/absolute.js': [
      "'use strict';",
      "const secret = require('/Users/alice/private/lib.js');",
      'module.exports = secret;'
    ].join('\n'),
    // 2) 私网地址：三种任务书点名的网段/主机名
    'src/network.js': [
      "'use strict';",
      "const ali = 'http://100.80.12.34:3000/api';",
      "const pku = 'https://10.129.5.6/health';",
      "const tailnet = 'http://yc-example.tail1234.ts.net';",
      'module.exports = { ali, pku, tailnet };'
    ].join('\n'),
    // 3) 未选模块：只选择了 pages,mail，却依赖 survey
    'src/unselected.js': [
      "'use strict';",
      "module.exports = require('../modules/survey/server/index.js');"
    ].join('\n'),
    // 4) 禁止关键字：配置文件、文档与源码各一处
    'config/sample.json': '{"note":"FORUM_UPLOAD_DIR 与 jupyter-routes 不得出现在公开包"}\n',
    'config/private.yml': 'storage:\n  host: 100.100.1.2\n',
    'notes/guide.md': '# 说明\n\nJupyter 相关文件必须清理。\n',
    // docs/ 正文允许声明排除项名称（只豁免关键字，私有地址仍查）
    'docs/policy.md': '# 边界\n\n公开包不包含与 Jupyter 相关的文件。\n',
    'src/keyword.js': [
      "const product = 'resume';",
      'const resumed = true;',
      'const resumeTask = () => {};',
      'socket.resume();',
      "const route = '/api/tasks/1/resume';",
      "const legacyName = 'resume-server';",
      'module.exports = { product, resumed, resumeTask, route, legacyName };'
    ].join('\n'),
    // 已选模块之间的依赖必须放行
    'modules/pages/index.js': "module.exports = require('../mail/server/index.js');\n",
    'modules/mail/server/index.js': 'module.exports = {};\n',
    'modules/survey/server/index.js': 'module.exports = {};\n'
  });
  cleanup(t, dir);

  const { result, json } = runTool(['--root', dir, '--modules', 'pages,mail']);
  assert.equal(result.status, 1, `应检出违规并 exit 1，stderr=${result.stderr}`);
  assert.ok(json, `stdout 必须是 JSON，实际：${result.stdout}`);

  assert.ok(json.filesScanned >= 6, '应扫描到至少 6 个文件');
  assert.equal(json.summary.violationCount, json.violations.length);

  const legacy = findViolation(json, 'legacy-source', 'src/legacy.js');
  assert.ok(legacy, '应检出指向旧 site 源码的 require');
  assert.equal(legacy.line, 2);
  assert.match(legacy.detail, /source\/site/);

  const absolute = findViolation(json, 'absolute-path', 'src/absolute.js');
  assert.ok(absolute, '应检出 /Users/ 绝对路径');
  assert.equal(absolute.line, 2);

  for (const line of [2, 3, 4]) {
    const network = json.violations.find((entry) => entry.rule === 'private-network' && entry.file === 'src/network.js' && entry.line === line);
    assert.ok(network, `src/network.js:${line} 应被识别为私有网段`);
  }

  const unselected = findViolation(json, 'unselected-module', 'src/unselected.js');
  assert.ok(unselected, '应检出未选模块 modules/survey/');
  assert.match(unselected.detail, /modules\/survey\//);

  assert.ok(findViolation(json, 'forbidden-keyword', 'config/sample.json'), 'JSON 中的禁止关键字应被检出');
  assert.ok(findViolation(json, 'private-network', 'config/private.yml'), 'YAML 中的私有网段应被检出');
  assert.ok(findViolation(json, 'forbidden-keyword', 'notes/guide.md'), 'Markdown 中的禁止关键字应被检出');
  assert.ok(
    !json.violations.some((entry) => entry.file === 'docs/policy.md' && entry.rule === 'forbidden-keyword'),
    'docs/ 正文声明排除项名称时应只豁免关键字检查'
  );
  const keyword = findViolation(json, 'forbidden-keyword', 'src/keyword.js');
  assert.ok(keyword, '独立单词 resume 应被检出');
  assert.equal(keyword.line, 1);
  for (const line of [2, 3, 4, 5]) {
    assert.ok(
      !json.violations.some((entry) => entry.file === 'src/keyword.js' && entry.line === line),
      `普通英文词/方法名/路径片段（第 ${line} 行）不应被误报为私有产品 resume`
    );
  }
  assert.ok(
    json.violations.some((entry) => entry.file === 'src/keyword.js' && entry.line === 6 && entry.rule === 'forbidden-keyword'),
    'resume-server 这类产品标识写法仍应被检出'
  );

  assert.equal(
    json.violations.filter((entry) => entry.file === 'modules/pages/index.js').length,
    0,
    'pages 依赖已选的 mail 不应报未选模块'
  );

  // 输出不得回显完整私网地址与本机用户名
  const payload = JSON.stringify(json);
  assert.ok(!payload.includes('100.80.12.34'), '私网 IP 应被掩码');
  assert.ok(!payload.includes('/Users/alice'), '本机用户名应被掩码');
});

test('干净样本：仅内置模块与根目录内相对导入时退出码为 0', (t) => {
  const dir = makeTree({
    'core/app.js': [
      "'use strict';",
      "const fs = require('node:fs');",
      "const helper = require('./helper.js');",
      'module.exports = { fs, helper };'
    ].join('\n'),
    'core/helper.js': "'use strict';\nmodule.exports = 1;\n"
  });
  cleanup(t, dir);

  const { result, json } = runTool(['--root', dir]);
  assert.equal(result.status, 0, `干净样本应 exit 0，stderr=${result.stderr}`);
  assert.ok(json);
  assert.equal(json.violations.length, 0);
  assert.equal(json.filesScanned, 2);
});

test('未选模块选择：--modules none 时任何 modules/<id>/ 导入都违规', (t) => {
  const dir = makeTree({
    'core/app.js': [
      "module.exports = require('../modules/pages/server/index.js');",
      "const byDir = require('../modules/pages');",
      'module.exports = { byDir };'
    ].join('\n'),
    'modules/pages/server/index.js': 'module.exports = {};\n'
  });
  cleanup(t, dir);

  const none = runTool(['--root', dir, '--modules', 'none']);
  assert.equal(none.result.status, 1, '--modules none 时应检出未选模块导入');
  assert.ok(none.json);
  const violation = findViolation(none.json, 'unselected-module', 'core/app.js');
  assert.ok(violation);
  assert.equal(violation.line, 1);
  assert.ok(
    none.json.violations.some((entry) => entry.rule === 'unselected-module' && entry.file === 'core/app.js' && entry.line === 2),
    '直接 import 模块目录（无尾斜杠）也应算未选模块依赖'
  );

  // 默认选择 modules/ 下已存在的全部模块，同一棵树应放行
  const all = runTool(['--root', dir]);
  assert.equal(all.result.status, 0, `默认选择应放行已存在的 pages，stderr=${all.stderr}`);
  assert.ok(all.json);
  assert.deepEqual(all.json.modulesSelected, ['pages']);
  assert.equal(all.json.violations.length, 0);
});

test('import / export / 动态 import 同样纳入导入闭包检查', (t) => {
  const dir = makeTree({
    'app/esm.mjs': [
      "import legacy from '../source/site/uniflourish/server/index.js';",
      "export { thing } from '/Users/alice/module.js';",
      "const lazy = await import('../modules/survey/server/index.js');",
      'export default { legacy, thing, lazy };'
    ].join('\n'),
    'modules/survey/server/index.js': 'module.exports = {};\n',
    'modules/pages/server/index.js': 'module.exports = {};\n'
  });
  cleanup(t, dir);

  const { result, json } = runTool(['--root', dir, '--modules', 'pages']);
  assert.equal(result.status, 1, `ESM 违规应 exit 1，stderr=${result.stderr}`);
  assert.ok(json);

  assert.equal(findViolation(json, 'legacy-source', 'app/esm.mjs').line, 1);
  assert.equal(findViolation(json, 'absolute-path', 'app/esm.mjs').line, 2);
  assert.equal(findViolation(json, 'unselected-module', 'app/esm.mjs').line, 3);
});

test('相对导入逃逸根目录会被拒绝', (t) => {
  const dir = makeTree({
    'core/escape.js': "module.exports = require('../../../outside.js');\n"
  });
  cleanup(t, dir);

  const { result, json } = runTool(['--root', dir]);
  assert.equal(result.status, 1);
  assert.ok(json);
  const violation = findViolation(json, 'path-escape', 'core/escape.js');
  assert.ok(violation, '应检出逃逸根目录的相对导入');
  assert.equal(violation.line, 1);
});

test('当前公开版根目录：默认扫描无违规，--strict 只剩审计文档/声明/自引用', () => {
  const clean = runTool([]);
  assert.equal(clean.result.status, 0, `当前公开版根目录应通过，stderr=${clean.result.stderr}\nstdout=${clean.result.stdout}`);
  assert.ok(clean.json, 'stdout 必须是 JSON');
  assert.equal(clean.json.violations.length, 0);
  assert.ok(clean.json.filesScanned > 10, `应扫描到公开版源码文件，实际 ${clean.json.filesScanned}`);
  assert.ok(clean.json.filesExempted > 0, '默认应豁免审计文档等非产品引用文件');

  // 导入闭包的核心约束：一个模块都不选时，core 仍能独立成立（不 require modules/<id>/）。
  const coreOnly = runTool(['--modules', 'none']);
  assert.equal(coreOnly.result.status, 0, `core-only 应无模块依赖，stderr=${coreOnly.result.stderr}`);
  assert.ok(coreOnly.json);
  assert.equal(coreOnly.json.violations.length, 0);

  const strict = runTool(['--strict']);
  assert.ok(strict.json, '--strict 也必须输出 JSON');
  assert.equal(
    strict.result.status,
    strict.json.violations.length > 0 ? 1 : 0,
    '--strict 的退出码应与违规数一致'
  );

  // --strict 允许暴露的仅有：审计/模块文档、发布声明、两个检查器及其负向用例自引用。
  // 产品代码（core/modules/admin/config/contracts）必须干净。
  const allowed = /(?:^docs\/|^README\.md$|^CONTRIBUTING\.md$|^tests\/contracts\/(?:imports|registry)\.test\.js$|^tools\/(?:check-imports|verify-release)\.js$)/;
  for (const violation of strict.json.violations) {
    assert.match(
      violation.file,
      allowed,
      `--strict 下产品代码不应有违规：${violation.file}:${violation.line} ${violation.rule} ${violation.detail}`
    );
  }
});

test('--help 可用且不执行扫描', () => {
  const result = spawnSync(process.execPath, [TOOL, '--help'], { cwd: PUBLIC_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--modules/);
  assert.match(result.stdout, /--root/);
});

test('--root 不存在时以退出码 2 报用法错误，而不是静默通过', () => {
  const missing = path.join(os.tmpdir(), 'pagesai-imports-does-not-exist-0000');
  const result = spawnSync(process.execPath, [TOOL, '--root', missing], { cwd: PUBLIC_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /不存在/);
});
