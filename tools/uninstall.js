#!/usr/bin/env node
'use strict';
/**
 * PagesAI 卸载工具（P6 运维工具）
 *
 * 方案依据：§9（停用和卸载默认保留数据；永久删除数据是独立维护操作，执行前必须列出实际范围）、
 *           §16.2（默认保留数据的卸载流程）。
 *
 * 默认行为（不带 --purge）：
 *  - 保留数据根、全部存储区域与数据库快照；
 *  - 写入 state/uninstall-record.json 记录卸载时间与保留范围；
 *  - 把 config.json 移入数据根 state/ 下保存（可用 --keep-config 原地保留），不删除任何数据。
 *
 * --purge 行为：
 *  - 先打印实际删除范围（目录、文件数、字节数、未登记内容）；
 *  - 交互式二次确认（非交互环境必须显式 --yes）；
 *  - 只删除数据根与生成的 config.json；秘密材料与外部数据库转储永不自动删除；
 *  - 客户端的本地文件、已退出账号与设备撤销不在本工具范围内，永远不会被删除。
 *
 * --dry-run 只读：打印范围与计划，不写盘、不删除。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_SCHEMA_PATH = path.join(PROJECT_ROOT, 'config', 'config.schema.json');
const CORE_VALIDATE_PATH = path.join(PROJECT_ROOT, 'core', 'contracts', 'validate.js');
const CORE_REGISTRY_PATH = path.join(PROJECT_ROOT, 'core', 'storage', 'registry.js');

const PRODUCT = 'pagesai';
const LEGACY_DATA_ROOTS = Object.freeze([
  '/data',
  '/home/ubuntu/glim',
  '/srv/uniflourish',
  '/opt/uniflourish',
  '/var/lib/uniflourish'
]);

class ToolError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'ToolError';
    this.exitCode = exitCode;
  }
}

function helpText() {
  return [
    'PagesAI 卸载（tools/uninstall.js）',
    '',
    '用法：',
    '  node tools/uninstall.js [--config <路径>] [--purge] [选项]',
    '',
    '默认（不带 --purge）：',
    '  - 保留数据根与所有模块数据，只记录卸载状态；',
    '  - config.json 移入 <dataRoot>/state/config.removed-<时间>.json 保存（--keep-config 则原地保留）。',
    '',
    '--purge（永久删除，独立维护操作）：',
    '  - 先打印实际删除范围（目录、文件数、字节数、未登记内容）；',
    '  - 交互式二次确认；非交互环境必须加 --yes；',
    '  - 只删除数据根与生成的 config.json，秘密材料与外部数据库转储不会自动删除。',
    '',
    '选项：',
    '  --config <路径>       配置文件（默认 <安装根>/config.json 或 PAGESAI_CONFIG）',
    '  --purge               永久删除数据（默认保留）',
    '  --keep-config         卸载时不移动 config.json',
    '  --yes                 非交互确认（等价于完成两次确认，仅在明确知道范围时使用）',
    '  --dry-run             只打印范围与计划，不写盘、不删除',
    '  --json                机器可读输出',
    '  --help                显示本帮助',
    '',
    '示例：',
    '  node tools/uninstall.js                       # 停用并保留数据',
    '  node tools/uninstall.js --purge --dry-run     # 先查看永久删除范围',
    '  node tools/uninstall.js --purge               # 打印范围并二次确认后删除',
    '',
    '退出码：0 成功；1 参数/环境错误或取消；2 数据根校验失败（拒绝删除）。'
  ].join('\n');
}

function parseArgs(argv, { booleans, valueFlags }) {
  const flags = {};
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new ToolError(`无法识别的参数：${arg}（用 --help 查看用法）`, 1);
    let name = arg.slice(2);
    let value = null;
    const eq = name.indexOf('=');
    if (eq >= 0) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (booleans.includes(name)) {
      if (value !== null) throw new ToolError(`选项 --${name} 不需要取值`, 1);
      flags[name] = true;
      continue;
    }
    if (valueFlags.includes(name)) {
      if (value === null) {
        i += 1;
        value = argv[i];
      }
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new ToolError(`选项 --${name} 需要一个值`, 1);
      }
      values[name] = value;
      continue;
    }
    throw new ToolError(`未知选项 --${name}（用 --help 查看用法）`, 1);
  }
  return { flags, values };
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ToolError(`${label} 不可读或不是合法 JSON：${file}\n${err.message}`, 1);
  }
}

function writeJsonAtomic(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function validateConfigObject(config, label) {
  const schema = readJson(CONFIG_SCHEMA_PATH, 'config schema');
  const { validate } = require(CORE_VALIDATE_PATH);
  const result = validate(schema, config);
  if (!result.valid) {
    const lines = result.errors.map((e) => `  - ${e.path}: ${e.message}`);
    throw new ToolError(`${label} 不符合 config/config.schema.json：\n${lines.join('\n')}`, 2);
  }
  const { validateRegion } = require(CORE_REGISTRY_PATH);
  for (const region of config.regions) {
    try {
      validateRegion(region);
    } catch (err) {
      throw new ToolError(`${label} 的区域声明 ${region.regionId} 不符合 storage-region 契约：${err.message}`, 2);
    }
  }
  return config;
}

function loadConfigFile(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new ToolError(`配置文件不存在：${configPath}\n请先运行：node tools/init.js --data-root <路径>`, 1);
  }
  const config = readJson(configPath, '配置文件');
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new ToolError(`配置文件必须是 JSON 对象：${configPath}`, 2);
  }
  if (config.product !== PRODUCT) {
    throw new ToolError(`配置文件不是 PagesAI 配置（product=${config.product}）：${configPath}`, 2);
  }
  return validateConfigObject(config, `配置文件（${configPath}）`);
}

function resolveConfigPath(values) {
  if (values.config) return path.resolve(values.config);
  if (process.env.PAGESAI_CONFIG) return path.resolve(process.env.PAGESAI_CONFIG);
  return path.join(PROJECT_ROOT, 'config.json');
}

function resolveSecretReference(config) {
  const reference = config.secrets.reference;
  return path.isAbsolute(reference) ? reference : path.resolve(config.installRoot, reference);
}

/** 递归统计；不跟随符号链接（只记录数量），避免越界。 */
function statScope(root) {
  const result = { files: 0, dirs: 0, bytes: 0, symlinks: 0 };
  if (!fs.existsSync(root)) return result;
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) {
        result.symlinks += 1;
        continue;
      }
      if (stat.isDirectory()) {
        result.dirs += 1;
        walk(abs);
        continue;
      }
      if (stat.isFile()) {
        result.files += 1;
        result.bytes += stat.size;
      }
    }
  })(root);
  return result;
}

function topLevelEntries(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((name) => name !== '.DS_Store').sort();
}

function knownTopLevel(config) {
  const known = new Set();
  for (const value of Object.values(config.storage)) {
    const rel = path.relative(config.dataRoot, path.resolve(value));
    if (rel && !rel.startsWith('..')) known.add(rel.split(path.sep)[0]);
  }
  const stateRel = path.relative(config.dataRoot, path.resolve(config.database.stateDir));
  if (stateRel && !stateRel.startsWith('..')) known.add(stateRel.split(path.sep)[0]);
  return known;
}

function assertPurgeSafe(config, configPath) {
  const dataRoot = path.resolve(config.dataRoot);
  if (dataRoot === path.parse(dataRoot).root) throw new ToolError('拒绝删除：数据根是文件系统根目录', 2);
  if (dataRoot === path.resolve(os.homedir())) throw new ToolError('拒绝删除：数据根是用户主目录', 2);
  for (const legacy of LEGACY_DATA_ROOTS) {
    if (isInside(legacy, dataRoot)) {
      throw new ToolError(`拒绝删除：数据根位于旧平台/现网根 ${legacy} 之下（${dataRoot}）`, 2);
    }
  }
  if (isInside(dataRoot, PROJECT_ROOT)) {
    throw new ToolError('拒绝删除：安装源码目录位于数据根内，删除会破坏代码', 2);
  }
  if (dataRoot === PROJECT_ROOT) throw new ToolError('拒绝删除：数据根就是安装目录', 2);
  if (configPath === dataRoot) throw new ToolError('拒绝删除：配置文件路径等于数据根', 2);
}

function safeMove(source, destination) {
  try {
    fs.renameSync(source, destination);
    return 'rename';
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
  fs.unlinkSync(source);
  return 'copy';
}

/**
 * 读取一行确认。stdin 提前结束（管道 EOF、终端关闭）返回 null，
 * 由调用方按「取消」处理，绝不把未确认当成默认删除。
 */
async function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.on('close', () => {
      if (!answered) resolve(null);
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

function printScope(scope, jsonOutput) {
  if (jsonOutput) return;
  const lines = [];
  lines.push('卸载范围：');
  lines.push(`  数据根：${scope.dataRoot}`);
  lines.push(
    `    文件 ${scope.stats.files} 个，目录 ${scope.stats.dirs} 个，${formatBytes(scope.stats.bytes)}` +
      (scope.stats.symlinks ? `，符号链接 ${scope.stats.symlinks} 个（不跟随）` : '')
  );
  if (scope.unknownTopLevel.length > 0) {
    lines.push(`    未登记的顶层内容（会随数据根一并处理）：${scope.unknownTopLevel.join('、')}`);
  }
  lines.push(`  配置文件：${scope.configPath}`);
  lines.push(`  秘密材料引用：${scope.secrets.reference}（${scope.secrets.present ? '存在' : '不存在'}，不自动删除）`);
  if (scope.databaseSnapshotNote) lines.push(`  外部数据库：${scope.databaseSnapshotNote}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printRetainSummary(scope, jsonOutput) {
  if (jsonOutput) return;
  const lines = [];
  lines.push('');
  lines.push('已停用（默认保留数据）：');
  lines.push(`  保留数据根：${scope.dataRoot}（${scope.stats.files} 个文件，${formatBytes(scope.stats.bytes)}）`);
  lines.push(`  保留状态目录：${scope.stateDir}`);
  if (scope.configMovedTo) lines.push(`  配置已保存到：${scope.configMovedTo}（未删除）`);
  else lines.push(`  配置原地保留：${scope.configPath}`);
  lines.push('  客户端本地文件、已退出账号与设备撤销均不在此工具范围内，不会被删除。');
  lines.push('');
  lines.push('如需永久删除数据（独立维护操作）：');
  if (scope.configMovedTo) {
    lines.push(`  node tools/uninstall.js --config ${scope.configMovedTo} --purge --dry-run`);
    lines.push(`  node tools/uninstall.js --config ${scope.configMovedTo} --purge`);
  } else {
    lines.push('  node tools/uninstall.js --purge --dry-run   # 先查看实际删除范围');
    lines.push('  node tools/uninstall.js --purge             # 打印范围并二次确认后删除');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printPurgeSummary(scope, jsonOutput) {
  if (jsonOutput) return;
  const lines = [];
  lines.push('');
  lines.push('永久删除范围（--purge）：');
  lines.push(`  1. 数据根：${scope.dataRoot}`);
  lines.push(
    `     文件 ${scope.stats.files} 个，目录 ${scope.stats.dirs} 个，${formatBytes(scope.stats.bytes)}` +
      (scope.stats.symlinks ? `，符号链接 ${scope.stats.symlinks} 个` : '')
  );
  if (scope.unknownTopLevel.length > 0) {
    lines.push(`     未登记顶层内容：${scope.unknownTopLevel.join('、')}`);
  }
  lines.push(`  2. 配置文件：${scope.configPath}`);
  lines.push('不会自动删除（请人工处理）：');
  lines.push(`  - 秘密材料：${scope.secrets.reference}`);
  if (scope.databaseSnapshotNote) lines.push(`  - 外部数据库：${scope.databaseSnapshotNote}`);
  lines.push('  - 客户端的本地文件、已退出账号与设备撤销');
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printSummary(summary) {
  if (summary.jsonOutput) {
    const { jsonOutput, ...rest } = summary;
    process.stdout.write(`${JSON.stringify(rest, null, 2)}\n`);
    return;
  }
  const lines = [];
  if (summary.cancelled) lines.push('卸载结果：已取消（未删除任何数据）');
  else if (summary.dryRun && summary.requestedPurge) lines.push('卸载结果：--purge 计划（--dry-run 未删除）');
  else if (summary.dryRun) lines.push('卸载结果：计划停用并保留数据（--dry-run 未写盘）');
  else if (summary.purged) lines.push('卸载结果：已永久删除');
  else lines.push('卸载结果：已停用（数据保留）');
  lines.push(`数据根：${summary.dataRoot}`);
  lines.push(`配置文件：${summary.configPath}`);
  if (summary.configMovedTo) lines.push(`配置保存位置：${summary.configMovedTo}`);
  if (summary.purged) lines.push(`已删除：${summary.deleted.join('；')}`);
  if (summary.dryRun) lines.push('模式：--dry-run 未写盘、未删除');
  if (summary.cancelled) lines.push('已取消：未删除任何数据');
  process.stdout.write(`${lines.join('\n')}\n`);
}

function buildScope(config, configPath) {
  const stats = statScope(config.dataRoot);
  const known = knownTopLevel(config);
  const unknownTopLevel = topLevelEntries(config.dataRoot).filter((name) => !known.has(name));
  const secretResolved = resolveSecretReference(config);
  const databaseSnapshotNote =
    config.database.engine === 'mongodb'
      ? `engine=mongodb，转储需由运维单独保存（${config.database.snapshotNote || '未提供说明'}）`
      : null;
  return {
    dataRoot: config.dataRoot,
    stateDir: config.database.stateDir,
    configPath,
    stats,
    unknownTopLevel,
    secrets: {
      reference: config.secrets.reference,
      resolvedPath: secretResolved,
      present: fs.existsSync(secretResolved)
    },
    databaseSnapshotNote
  };
}

async function main(argv) {
  const { flags, values } = parseArgs(argv, {
    booleans: ['help', 'dry-run', 'json', 'purge', 'yes', 'keep-config'],
    valueFlags: ['config']
  });
  if (flags.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }

  const jsonOutput = Boolean(flags.json);
  const dryRun = Boolean(flags['dry-run']);
  const purge = Boolean(flags.purge);
  const configPath = resolveConfigPath(values);
  const config = loadConfigFile(configPath);

  const markerPath = path.join(config.database.stateDir, 'deployment.json');
  if (fs.existsSync(markerPath)) {
    const marker = readJson(markerPath, '部署标记');
    if (marker.deploymentId !== config.deploymentId) {
      throw new ToolError(
        `部署标识不一致（config ${config.deploymentId} / marker ${marker.deploymentId}），拒绝继续。`,
        2
      );
    }
    if (path.resolve(marker.dataRoot) !== path.resolve(config.dataRoot)) {
      throw new ToolError(
        `部署标记记录的数据根 ${marker.dataRoot} 与配置 ${config.dataRoot} 不一致，拒绝继续。`,
        2
      );
    }
  } else if (!dryRun && !(purge && !fs.existsSync(config.dataRoot))) {
    throw new ToolError(`缺少部署标记：${markerPath}，拒绝卸载未知目录。`, 2);
  }

  const scope = buildScope(config, configPath);

  if (!jsonOutput) {
    process.stdout.write('== PagesAI 卸载 ==\n');
    if (dryRun) process.stdout.write('（--dry-run：不写盘、不删除）\n');
    process.stdout.write('\n');
  }
  printScope(scope, jsonOutput);

  if (!dryRun && !jsonOutput) {
    process.stdout.write(
      '\n默认卸载只停用并保留数据；永久删除需要显式 --purge。\n'
    );
  }

  // ---- 默认：停用并保留 ----
  if (!purge) {
    if (dryRun) {
      if (!jsonOutput) {
        process.stdout.write('\n计划（--dry-run 不写盘）：\n');
        process.stdout.write(`  - 写入卸载记录：${path.join(config.database.stateDir, 'uninstall-record.json')}\n`);
        process.stdout.write(
          flags['keep-config']
            ? '  - 保留 config.json 原地\n'
            : `  - 把 config.json 移入 ${path.join(config.database.stateDir, 'config.removed-<时间>.json')} 保存\n`
        );
        process.stdout.write('  - 不删除任何数据\n');
      }
      printSummary({
        ok: true,
        purged: false,
        requestedPurge: false,
        dryRun,
        dataRoot: config.dataRoot,
        configPath,
        configMovedTo: null,
        jsonOutput
      });
      return 0;
    }

    const now = new Date().toISOString();
    const recordPath = path.join(config.database.stateDir, 'uninstall-record.json');
    writeJsonAtomic(
      recordPath,
      {
        product: PRODUCT,
        deploymentId: config.deploymentId,
        uninstalledAt: now,
        dataRoot: config.dataRoot,
        modules: config.modules.slice(),
        keptRegions: config.regions.map((region) => region.regionId),
        configPath,
        note: '默认卸载保留全部数据；永久删除需显式 --purge 并二次确认。'
      },
      0o600
    );

    let configMovedTo = null;
    if (!flags['keep-config']) {
      const stamp = now.replace(/[:.]/g, '-');
      configMovedTo = path.join(config.database.stateDir, `config.removed-${stamp}.json`);
      safeMove(configPath, configMovedTo);
    }

    const summary = {
      ok: true,
      purged: false,
      requestedPurge: false,
      dryRun,
      dataRoot: config.dataRoot,
      configPath,
      configMovedTo,
      recordPath,
      retained: { files: scope.stats.files, bytes: scope.stats.bytes },
      jsonOutput
    };
    printRetainSummary({ ...scope, configMovedTo }, jsonOutput);
    printSummary(summary);
    return 0;
  }

  // ---- --purge：永久删除 ----
  assertPurgeSafe(config, configPath);
  printPurgeSummary(scope, jsonOutput);

  if (dryRun) {
    if (!jsonOutput) {
      process.stdout.write('\n（--dry-run：未删除任何数据。）\n');
    }
    printSummary({
      ok: true,
      purged: false,
      requestedPurge: true,
      dryRun: true,
      dataRoot: config.dataRoot,
      configPath,
      deleted: [],
      jsonOutput
    });
    return 0;
  }

  // 二次确认：交互式两次，非交互必须 --yes。
  if (flags.yes) {
    if (!jsonOutput) process.stdout.write('\n已通过 --yes 完成二次确认（请在明确知道范围时使用）。\n');
  } else if (!process.stdin.isTTY) {
    throw new ToolError(
      '非交互环境不能永久删除数据：请在终端交互确认，或显式加 --yes（先运行 --purge --dry-run 查看范围）。',
      1
    );
  } else {
    const first = await ask('确认永久删除以上范围？输入 yes 继续：');
    if (first === null || String(first).trim().toLowerCase() !== 'yes') {
      if (!jsonOutput) process.stdout.write('\n已取消：未删除任何数据。\n');
      printSummary({
        ok: false,
        cancelled: true,
        purged: false,
        requestedPurge: true,
        dryRun,
        dataRoot: config.dataRoot,
        configPath,
        deleted: [],
        jsonOutput
      });
      return 1;
    }
    const expected = path.basename(config.dataRoot);
    const second = await ask(`再次确认：输入数据根目录名 "${expected}" 继续：`);
    if (second === null || String(second).trim() !== expected) {
      if (!jsonOutput) process.stdout.write('\n已取消：未删除任何数据。\n');
      printSummary({
        ok: false,
        cancelled: true,
        purged: false,
        requestedPurge: true,
        dryRun,
        dataRoot: config.dataRoot,
        configPath,
        deleted: [],
        jsonOutput
      });
      return 1;
    }
  }

  // 删除前再次校验（避免确认期间配置/标记被改）。
  assertPurgeSafe(config, configPath);
  const deleted = [];
  const missing = [];
  if (fs.existsSync(config.dataRoot)) {
    fs.rmSync(config.dataRoot, { recursive: true, force: false });
    deleted.push(config.dataRoot);
  } else {
    missing.push(config.dataRoot);
  }
  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
    deleted.push(configPath);
  }

  const summary = {
    ok: true,
    purged: true,
    requestedPurge: true,
    dryRun,
    dataRoot: config.dataRoot,
    configPath,
    deleted,
    missing,
    secrets: scope.secrets,
    jsonOutput
  };
  if (!jsonOutput) {
    process.stdout.write('\n已永久删除：\n');
    for (const item of deleted) process.stdout.write(`  - ${item}\n`);
    for (const item of missing) process.stdout.write(`  - ${item}（已不存在，跳过）\n`);
    process.stdout.write(
      `\n未删除秘密材料：${scope.secrets.reference}（请人工处理）；客户端本地文件不受影响。\n`
    );
  }
  printSummary(summary);
  return 0;
}

function reportError(err) {
  if (err instanceof ToolError) {
    process.stderr.write(`[错误] ${err.message}\n`);
    process.exitCode = err.exitCode;
    return;
  }
  const detail = err && err.stack ? err.stack : String(err);
  process.stderr.write(`[内部错误] ${detail}\n`);
  process.exitCode = 1;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(reportError);
}

module.exports = { main, statsScope: statScope };
