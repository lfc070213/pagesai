#!/usr/bin/env node
'use strict';
/**
 * PagesAI 升级工具（P6 运维工具）
 *
 * 方案依据：§9（检查兼容性 → 备份 → 幂等迁移 → 启动 → 验证）、§16.2（升级与恢复工具）、
 *           §6.1（拒绝隐式数据根变更）、§4.2/§4.3（模块与状态语义）。
 *
 * 顺序固定为：check → backup → migrate（幂等迁移台账）→ verify。
 * 数据模式/配置结构不兼容时立即拒绝，不备份、不迁移，并提示按备份恢复。
 *
 * 约束：
 *  - 仅使用 Node 内置模块；
 *  - 迁移幂等：已应用迁移按签名跳过；签名变化视为不兼容；
 *  - 备份通过 tools/backup.js 子进程执行，确保只有一份备份实现；
 *  - --dry-run 只读：不备份、不改台账、不建目录、不写探针文件。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_SCHEMA_PATH = path.join(PROJECT_ROOT, 'config', 'config.schema.json');
const CORE_VALIDATE_PATH = path.join(PROJECT_ROOT, 'core', 'contracts', 'validate.js');
const CORE_REGISTRY_PATH = path.join(PROJECT_ROOT, 'core', 'storage', 'registry.js');
const CORE_JSON_STORE_PATH = path.join(PROJECT_ROOT, 'core', 'storage', 'json-store.js');
const BACKUP_TOOL = path.join(__dirname, 'backup.js');

const PRODUCT = 'pagesai';
const CURRENT_CONFIG_SCHEMA = 1;
const LEDGER_FORMAT_VERSION = 1;
const STEPS = Object.freeze(['all', 'check', 'backup', 'migrate', 'verify']);

class ToolError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'ToolError';
    this.exitCode = exitCode;
  }
}

function helpText() {
  return [
    'PagesAI 升级（tools/upgrade.js）',
    '',
    '用法：',
    '  node tools/upgrade.js [--step all|check|backup|migrate|verify] [选项]',
    '',
    '流程：',
    '  check    校验配置、契约、数据根与迁移台账；不兼容立即拒绝',
    '  backup   调用 tools/backup.js 生成升级前备份（迁移前强制执行）',
    '  migrate  按迁移台账幂等执行内置迁移',
    '  verify   复核配置、台账、区域目录与可写性',
    '  默认 --step all = check → backup → migrate → verify',
    '',
    '选项：',
    '  --step <阶段>           all|check|backup|migrate|verify（默认 all）',
    '  --check                 等价于 --step check',
    '  --verify                等价于 --step verify',
    '  --config <路径>         配置文件（默认 <安装根>/config.json 或 PAGESAI_CONFIG）',
    '  --backup-out <目录>     升级前备份输出目录（默认交给 backup.js）',
    '  --skip-backup           跳过迁移前备份（不推荐，仅限已手工备份时）',
    '  --dry-run               只打印计划，不写盘',
    '  --json                  机器可读输出',
    '  --help                  显示本帮助',
    '',
    '示例：',
    '  node tools/upgrade.js --check',
    '  node tools/upgrade.js --step all --dry-run',
    '',
    '退出码：0 成功；1 参数/环境错误；2 不兼容或校验失败（按提示恢复备份）。'
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

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function signatureHash(migration) {
  return sha256(`${migration.id}|${migration.module}|${migration.signature}`);
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

function buildMarker(config, configPath, now) {
  return {
    product: PRODUCT,
    formatVersion: 1,
    deploymentId: config.deploymentId,
    dataRoot: config.dataRoot,
    installRoot: config.installRoot,
    modules: config.modules.slice(),
    diskVariant: config.disk.variant,
    registrationMode: config.registration.mode,
    storage: { ...config.storage },
    regions: config.regions.map((region) => region.regionId),
    configPath,
    createdAt: config.createdAt,
    updatedAt: now
  };
}

function loadMarker(config) {
  const markerPath = path.join(config.database.stateDir, 'deployment.json');
  if (!fs.existsSync(markerPath)) return null;
  return { markerPath, marker: readJson(markerPath, '部署标记') };
}

function loadLedger(stateDir) {
  const file = path.join(stateDir, 'migrations.json');
  if (!fs.existsSync(file)) return { formatVersion: LEDGER_FORMAT_VERSION, updatedAt: null, applied: [] };
  const raw = readJson(file, '迁移台账');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ToolError('迁移台账格式非法：应为 JSON 对象', 2);
  }
  if (raw.formatVersion !== LEDGER_FORMAT_VERSION) {
    throw new ToolError(
      `迁移台账格式版本 ${raw.formatVersion} 不受支持（本工具支持 ${LEDGER_FORMAT_VERSION}）`,
      2
    );
  }
  if (!Array.isArray(raw.applied)) throw new ToolError('迁移台账缺少 applied 数组', 2);
  return raw;
}

function diffStorage(expected, actual) {
  const keys = new Set([...Object.keys(expected || {}), ...Object.keys(actual || {})]);
  const changed = [];
  for (const key of [...keys].sort()) {
    if (expected[key] !== actual[key]) changed.push(key);
  }
  return changed;
}

function restoreHint(ctx) {
  const backupsDir = process.env.PAGESAI_BACKUP_ROOT || path.join(ctx.config.dataRoot, 'backups');
  let latest = null;
  if (fs.existsSync(backupsDir)) {
    for (const name of fs.readdirSync(backupsDir).sort()) {
      const candidate = path.join(backupsDir, name);
      if (fs.existsSync(path.join(candidate, 'manifest.json'))) latest = candidate;
    }
  }
  const backupDir = latest || '<升级前备份目录>';
  return [
    `恢复校验：node tools/restore.js --backup ${backupDir} --verify-only`,
    `执行恢复：node tools/restore.js --backup ${backupDir} --target-data-root ${ctx.config.dataRoot}`
  ];
}

/**
 * 内置迁移定义。id 采用 4 位以上数字（契约 data.migrations.id 规则）。
 * signature 一旦发布不得修改：修改会被台账签名校验识别为不兼容变更。
 */
const MIGRATIONS = Object.freeze([
  {
    id: '0001',
    module: 'core',
    name: '部署标记与配置对齐',
    signature: 'deployment-marker/v1',
    plan(ctx) {
      return [`写入/更新部署标记：${path.join(ctx.stateDir, 'deployment.json')}`];
    },
    up(ctx) {
      const markerPath = path.join(ctx.stateDir, 'deployment.json');
      writeJsonAtomic(markerPath, buildMarker(ctx.config, ctx.configPath, ctx.now()), 0o600);
      return { markerPath };
    }
  },
  {
    id: '0002',
    module: 'core',
    name: '身份冷启动快照',
    signature: 'identity-snapshot/v1',
    plan(ctx) {
      return [`确保身份快照存在：${path.join(ctx.stateDir, 'identity.json')}`];
    },
    up(ctx) {
      const file = path.join(ctx.stateDir, 'identity.json');
      if (fs.existsSync(file)) {
        const raw = readJson(file, '身份快照');
        if (!raw.users || typeof raw.users !== 'object') {
          throw new ToolError(`身份快照缺少 users 集合：${file}`, 2);
        }
        return { file, created: false };
      }
      const { JsonStore } = require(CORE_JSON_STORE_PATH);
      const store = new JsonStore({
        filePath: file,
        initial: {
          users: {},
          sessions: {},
          verifications: {},
          meta: {
            createdAt: ctx.now(),
            note: '身份冷启动导出快照；核心当前为内存实现，接入数据库适配器后由服务写入。'
          }
        }
      });
      store.save();
      return { file, created: true };
    }
  },
  {
    id: '0003',
    module: 'core',
    name: '存储区域目录',
    signature: 'region-layout/v1',
    plan(ctx) {
      const lines = [];
      for (const region of ctx.config.regions) {
        const root = ctx.config.storage[region.physicalRoot.configKey];
        lines.push(`确保区域目录：${region.regionId} → ${root}`);
      }
      return lines;
    },
    up(ctx) {
      const created = [];
      for (const region of ctx.config.regions) {
        const key = region.physicalRoot.configKey;
        const root = ctx.config.storage[key];
        if (!root) throw new ToolError(`区域 ${region.regionId} 缺少物理根配置 ${key}`, 2);
        if (!fs.existsSync(root)) {
          fs.mkdirSync(root, { recursive: true, mode: 0o750 });
          created.push(root);
        }
      }
      return { created };
    }
  },
  {
    id: '0004',
    module: 'core',
    name: '迁移台账格式',
    signature: 'migration-ledger-format/v1',
    plan() {
      return ['校验并归一迁移台账格式（formatVersion=1）'];
    },
    up(ctx) {
      const ledger = loadLedger(ctx.stateDir);
      return { applied: ledger.applied.length };
    }
  },
  {
    id: '0005',
    module: 'core',
    name: '秘密材料引用',
    signature: 'secrets-reference/v1',
    plan(ctx) {
      return [`登记秘密材料引用（不复制内容）：${path.join(ctx.stateDir, 'secrets-ref.json')}`];
    },
    up(ctx) {
      const file = path.join(ctx.stateDir, 'secrets-ref.json');
      const resolvedPath = resolveSecretReference(ctx.config);
      const record = {
        mode: ctx.config.secrets.mode,
        reference: ctx.config.secrets.reference,
        resolvedPath,
        keys: ctx.config.secrets.keys.slice(),
        present: fs.existsSync(resolvedPath),
        recordedAt: ctx.now(),
        note: '仅记录引用；秘密材料独立保护，备份与配置均不含秘密值。'
      };
      writeJsonAtomic(file, record, 0o600);
      return { file, present: record.present };
    }
  }
]);

/** 只读检查：返回不兼容项、错误、警告与台账。 */
function inspect(ctx) {
  const { config } = ctx;
  const incompatible = [];
  const errors = [];
  const warnings = [];

  if (!Number.isInteger(config.schemaVersion) || config.schemaVersion > CURRENT_CONFIG_SCHEMA) {
    incompatible.push(
      `配置结构版本 ${config.schemaVersion} 高于本工具支持的 ${CURRENT_CONFIG_SCHEMA}（代码回退不能只换回旧版本）`
    );
  }
  if (config.registration.mode === 'email' && !config.modules.includes('mail')) {
    incompatible.push('注册方式为 email，但模块清单未包含 mail（方案 §5.2 要求邮箱注册依赖 Mail）');
  }
  if (config.registration.requireEmailVerification !== (config.registration.mode === 'email')) {
    incompatible.push('registration.mode 与 registration.requireEmailVerification 不一致');
  }
  for (const region of config.regions) {
    const key = region.physicalRoot.configKey;
    if (!config.storage[key]) incompatible.push(`区域 ${region.regionId} 的物理根配置键 ${key} 在 storage 中缺失`);
  }
  const storageEntries = Object.entries(config.storage);
  for (let i = 0; i < storageEntries.length; i += 1) {
    for (let j = i + 1; j < storageEntries.length; j += 1) {
      const [keyA, pathA] = storageEntries[i];
      const [keyB, pathB] = storageEntries[j];
      const inner = (parent, child) => {
        const rel = path.relative(path.resolve(parent), path.resolve(child));
        return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
      };
      if (inner(pathA, pathB) || inner(pathB, pathA)) {
        incompatible.push(`存储区域路径重叠：${keyA} 与 ${keyB}（一个包含另一个）`);
      }
    }
  }

  if (!fs.existsSync(config.dataRoot)) {
    errors.push(`数据根不存在：${config.dataRoot}（先运行 tools/init.js）`);
  } else {
    const loaded = loadMarker(config);
    if (!loaded) {
      errors.push(`缺少部署标记：${path.join(config.database.stateDir, 'deployment.json')}`);
    } else {
      const { marker } = loaded;
      if (marker.product !== PRODUCT) incompatible.push(`部署标记不属于 PagesAI：${loaded.markerPath}`);
      if (marker.deploymentId !== config.deploymentId) {
        incompatible.push(`部署标识不一致（config ${config.deploymentId} / marker ${marker.deploymentId}）`);
      }
      if (path.resolve(marker.dataRoot) !== path.resolve(config.dataRoot)) {
        incompatible.push(`部署标记记录的数据根 ${marker.dataRoot} 与配置 ${config.dataRoot} 不一致`);
      }
      const changed = diffStorage(marker.storage, config.storage);
      if (changed.length > 0) {
        incompatible.push(
          `已登记数据根发生变化（方案 §6.1 拒绝隐式迁移）：${changed.join('、')}`
        );
      }
      if (marker.diskVariant && marker.diskVariant !== config.disk.variant) {
        warnings.push(
          `Disk 版本从 ${marker.diskVariant} 变为 ${config.disk.variant}（两版共用数据面，不移动数据）`
        );
      }
    }
  }

  let ledger = null;
  try {
    ledger = loadLedger(config.database.stateDir);
  } catch (err) {
    incompatible.push(err.message);
  }
  if (ledger) {
    const known = new Map(MIGRATIONS.map((migration) => [migration.id, migration]));
    for (const entry of ledger.applied) {
      const migration = known.get(entry.id);
      if (!migration) {
        incompatible.push(
          `迁移台账含本工具不认识的迁移 ${entry.id}（数据来自更新版本，禁止用旧工具继续）`
        );
        continue;
      }
      if (entry.signatureSha256 !== signatureHash(migration)) {
        incompatible.push(`迁移 ${entry.id} 的签名与当前定义不符（迁移定义被修改）`);
      }
      if (entry.status !== 'applied') {
        incompatible.push(`迁移 ${entry.id} 状态为 ${entry.status}，不是 applied`);
      }
    }
  }

  const missingRoots = [];
  for (const region of config.regions) {
    const root = config.storage[region.physicalRoot.configKey];
    if (root && !fs.existsSync(root)) missingRoots.push(`${region.regionId} → ${root}`);
  }
  if (missingRoots.length > 0) {
    warnings.push(`以下区域目录尚不存在（迁移 0003 会创建）：\n  - ${missingRoots.join('\n  - ')}`);
  }

  return { incompatible, errors, warnings, ledger };
}

function printInspect(result, jsonOutput) {
  if (jsonOutput) return;
  const lines = ['兼容性检查：'];
  if (result.incompatible.length === 0 && result.errors.length === 0) {
    lines.push('  [ OK ] 通过');
  }
  for (const item of result.incompatible) lines.push(`  [不兼容] ${item}`);
  for (const item of result.errors) lines.push(`  [错误] ${item}`);
  for (const item of result.warnings) lines.push(`  [提示] ${item}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

function runBackupStep(ctx, backupOut) {
  const args = [BACKUP_TOOL, '--config', ctx.configPath, '--json', '--label', `pre-upgrade-${ctx.stamp}`];
  if (backupOut) args.push('--out', backupOut);
  else if (process.env.PAGESAI_BACKUP_ROOT) args.push('--out', process.env.PAGESAI_BACKUP_ROOT);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (result.error) {
    throw new ToolError(`调用备份工具失败：${result.error.message}`, 1);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new ToolError(`升级前备份失败（退出码 ${result.status}），已停止，未执行迁移。\n${detail}`, 1);
  }
  let summary = null;
  try {
    summary = JSON.parse(result.stdout);
  } catch {
    summary = { raw: result.stdout.trim() };
  }
  return summary;
}

function applyMigrations(ctx) {
  const ledgerPath = path.join(ctx.stateDir, 'migrations.json');
  const ledger = loadLedger(ctx.stateDir);
  const appliedIds = new Set(ledger.applied.map((entry) => entry.id));
  const performed = [];
  const skipped = [];

  for (const migration of MIGRATIONS) {
    if (appliedIds.has(migration.id)) {
      skipped.push(migration.id);
      if (!ctx.jsonOutput) process.stdout.write(`  [跳过] ${migration.id} ${migration.name}（已应用）\n`);
      continue;
    }
    if (!ctx.jsonOutput) process.stdout.write(`  [执行] ${migration.id} ${migration.name} …\n`);
    let result;
    try {
      result = migration.up(ctx);
    } catch (err) {
      throw new ToolError(
        `迁移 ${migration.id}（${migration.name}）失败：${err.message}\n` +
          '已停止；未删除任何数据。修复后可直接重跑（迁移幂等），或恢复升级前备份。',
        2
      );
    }
    performed.push({ id: migration.id, name: migration.name, result });
    ledger.applied.push({
      id: migration.id,
      module: migration.module,
      name: migration.name,
      signatureSha256: signatureHash(migration),
      appliedAt: ctx.now(),
      status: 'applied'
    });
    ledger.updatedAt = ctx.now();
    writeJsonAtomic(ledgerPath, ledger, 0o600);
    appliedIds.add(migration.id);
  }
  return { performed, skipped, ledgerPath };
}

function planMigrations(ctx) {
  const ledger = loadLedger(ctx.stateDir);
  const appliedIds = new Set(ledger.applied.map((entry) => entry.id));
  const plan = [];
  for (const migration of MIGRATIONS) {
    if (appliedIds.has(migration.id)) {
      plan.push({ id: migration.id, action: 'skip', detail: '已应用' });
      continue;
    }
    plan.push({ id: migration.id, action: 'apply', detail: migration.plan(ctx) });
  }
  return plan;
}

function runVerify(ctx) {
  const problems = [];
  const details = [];
  const inspected = inspect(ctx);
  problems.push(...inspected.incompatible, ...inspected.errors);

  let ledger = null;
  try {
    ledger = loadLedger(ctx.stateDir);
  } catch (err) {
    problems.push(err.message);
  }
  if (ledger) {
    const missing = MIGRATIONS.filter((migration) => !ledger.applied.some((entry) => entry.id === migration.id));
    if (missing.length > 0) {
      if (ctx.pendingMigrationsOk) {
        details.push(`dry-run：计划应用迁移 ${missing.map((m) => m.id).join('、')}`);
      } else {
        problems.push(`迁移未全部应用：${missing.map((m) => m.id).join('、')}`);
      }
    } else {
      details.push(`迁移台账完整（${ledger.applied.length} 项）`);
    }
  }

  for (const region of ctx.config.regions) {
    const root = ctx.config.storage[region.physicalRoot.configKey];
    if (!root) {
      problems.push(`区域 ${region.regionId} 缺少物理根配置`);
      continue;
    }
    if (!fs.existsSync(root)) {
      problems.push(`区域目录不存在：${region.regionId} → ${root}`);
      continue;
    }
    details.push(`区域目录存在：${region.regionId}`);
    if (!ctx.dryRun) {
      const probe = path.join(root, `.pagesai-write-probe-${process.pid}`);
      try {
        fs.writeFileSync(probe, 'ok', { mode: 0o600 });
        fs.unlinkSync(probe);
      } catch (err) {
        problems.push(`区域不可写：${region.regionId} → ${root}（${err.message}）`);
      }
    }
  }

  const identityPath = path.join(ctx.stateDir, 'identity.json');
  if (!fs.existsSync(identityPath)) {
    problems.push(`身份快照不存在：${identityPath}`);
  } else {
    try {
      const raw = readJson(identityPath, '身份快照');
      if (!raw.users || typeof raw.users !== 'object') problems.push('身份快照缺少 users 集合');
      else details.push(`身份快照有效（${Object.keys(raw.users).length} 个用户）`);
    } catch (err) {
      problems.push(err.message);
    }
  }

  try {
    validateConfigObject(ctx.config, `配置文件（${ctx.configPath}）`);
    details.push('配置仍满足 config/config.schema.json 与 storage-region 契约');
  } catch (err) {
    problems.push(err.message);
  }

  const secretsRef = path.join(ctx.stateDir, 'secrets-ref.json');
  if (fs.existsSync(secretsRef)) {
    const record = readJson(secretsRef, '秘密材料引用');
    if (record.present !== true) {
      details.push(`秘密材料尚未就位：${record.reference}（不阻塞升级，但会在启动前失败）`);
    } else {
      details.push(`秘密材料引用已登记：${record.reference}`);
    }
  }

  return { ok: problems.length === 0, problems, details };
}

function printSummary(summary) {
  if (summary.jsonOutput) {
    const { jsonOutput, ...rest } = summary;
    process.stdout.write(`${JSON.stringify(rest, null, 2)}\n`);
    return;
  }
  const lines = [];
  lines.push(summary.ok ? '升级结果：成功' : '升级结果：失败');
  lines.push(`配置：${summary.configPath}`);
  lines.push(`数据根：${summary.dataRoot}`);
  lines.push(`阶段：${summary.step}${summary.dryRun ? '（--dry-run 未写盘）' : ''}`);
  if (summary.backup) lines.push(`升级前备份：${summary.backup.backupDir || '（未取得备份路径）'}`);
  if (summary.migrations) {
    lines.push(`已执行迁移：${summary.migrations.performed.length ? summary.migrations.performed.join('、') : '无'}`);
    lines.push(`已应用跳过：${summary.migrations.skipped.length ? summary.migrations.skipped.join('、') : '无'}`);
  }
  if (summary.verify) {
    lines.push('验证：');
    for (const line of summary.verify.details) lines.push(`  [ OK ] ${line}`);
    for (const line of summary.verify.problems) lines.push(`  [失败] ${line}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function main(argv) {
  const { flags, values } = parseArgs(argv, {
    booleans: ['help', 'dry-run', 'json', 'check', 'verify', 'skip-backup'],
    valueFlags: ['step', 'config', 'backup-out']
  });
  if (flags.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }

  const jsonOutput = Boolean(flags.json);
  const dryRun = Boolean(flags['dry-run']);
  const step = flags.check ? 'check' : flags.verify ? 'verify' : String(values.step || 'all').toLowerCase();
  if (!STEPS.includes(step)) throw new ToolError(`--step 只能是 ${STEPS.join('|')}`, 1);

  const configPath = resolveConfigPath(values);
  let config;
  try {
    config = loadConfigFile(configPath);
  } catch (err) {
    if (err instanceof ToolError && err.exitCode === 2) {
      err.message +=
        '\n\n模式不兼容：已停止，未修改任何文件、未执行迁移。\n' +
        '请按升级前备份恢复：node tools/restore.js --backup <备份目录> --verify-only';
      // --json 也必须给出可机器解析的不兼容结论，而不是只在 stderr 留一行。
      if (jsonOutput) {
        const summary = {
          ok: false,
          step,
          dryRun,
          configPath,
          check: { incompatible: [err.message], errors: [], warnings: [], ledger: null },
          jsonOutput
        };
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
        return err.exitCode;
      }
    }
    throw err;
  }
  const ctx = {
    config,
    configPath,
    stateDir: config.database.stateDir,
    dataRoot: config.dataRoot,
    dryRun,
    jsonOutput,
    pendingMigrationsOk: dryRun && (step === 'all' || step === 'migrate'),
    stamp: new Date().toISOString().replace(/[:.]/g, '-'),
    now: () => new Date().toISOString()
  };

  if (!dryRun && !jsonOutput) {
    process.stdout.write(`== PagesAI 升级（${step}）==\n配置：${configPath}\n数据根：${config.dataRoot}\n\n`);
  }

  const inspected = inspect(ctx);
  printInspect(inspected, jsonOutput);

  if (inspected.incompatible.length > 0) {
    if (!jsonOutput) {
      process.stdout.write('\n模式不兼容：已停止，未修改任何文件、未执行迁移。\n');
      for (const line of restoreHint(ctx)) process.stdout.write(`  ${line}\n`);
    }
    const summary = {
      ok: false,
      step,
      dryRun,
      configPath,
      dataRoot: config.dataRoot,
      check: inspected,
      restoreHint: restoreHint(ctx),
      jsonOutput
    };
    printSummary(summary);
    return 2;
  }
  if (inspected.errors.length > 0) {
    if (!jsonOutput) process.stdout.write('\n环境检查未通过，已停止。\n');
    printSummary({
      ok: false,
      step,
      dryRun,
      configPath,
      dataRoot: config.dataRoot,
      check: inspected,
      jsonOutput
    });
    return 1;
  }
  if (step === 'check') {
    printSummary({
      ok: true,
      step,
      dryRun,
      configPath,
      dataRoot: config.dataRoot,
      check: inspected,
      jsonOutput
    });
    return 0;
  }

  let backup = null;
  const needBackup = step === 'all' || step === 'migrate' || step === 'backup';
  if (needBackup) {
    if (flags['skip-backup'] && step !== 'backup') {
      if (!jsonOutput) process.stdout.write('\n[警告] 已按 --skip-backup 跳过升级前备份（不推荐）。\n');
    } else if (dryRun) {
      const out = values['backup-out'] || process.env.PAGESAI_BACKUP_ROOT || path.join(config.dataRoot, 'backups');
      if (!jsonOutput) {
        process.stdout.write(`\n将执行升级前备份：${path.join(BACKUP_TOOL)} --config ${configPath} --out ${out}\n`);
      }
      backup = { dryRun: true, backupDir: out };
    } else {
      if (!jsonOutput) process.stdout.write('\n[1/3] 升级前备份 …\n');
      backup = runBackupStep(ctx, values['backup-out'] ? path.resolve(values['backup-out']) : null);
      if (!jsonOutput) process.stdout.write(`[ OK ] 备份完成：${backup.backupDir || ''}\n`);
    }
  }

  if (step === 'backup') {
    printSummary({
      ok: true,
      step,
      dryRun,
      configPath,
      dataRoot: config.dataRoot,
      check: inspected,
      backup,
      jsonOutput
    });
    return 0;
  }

  let migrations = null;
  if (step === 'all' || step === 'migrate') {
    if (dryRun) {
      const plan = planMigrations(ctx);
      if (!jsonOutput) {
        process.stdout.write('\n[2/3] 迁移计划（--dry-run 不执行）：\n');
        for (const item of plan) {
          if (item.action === 'skip') {
            process.stdout.write(`  [跳过] ${item.id}\n`);
            continue;
          }
          process.stdout.write(`  [计划] ${item.id}\n`);
          for (const line of item.detail) process.stdout.write(`         ${line}\n`);
        }
      }
      migrations = { performed: [], skipped: plan.filter((p) => p.action === 'skip').map((p) => p.id), plan };
    } else {
      if (!jsonOutput) process.stdout.write('\n[2/3] 执行幂等迁移 …\n');
      const result = applyMigrations(ctx);
      migrations = {
        performed: result.performed.map((item) => item.id),
        skipped: result.skipped,
        ledger: result.ledgerPath
      };
    }
  }

  let verify = null;
  if (step === 'all' || step === 'verify') {
    if (!jsonOutput) process.stdout.write('\n[3/3] 验证 …\n');
    verify = runVerify(ctx);
    if (!jsonOutput) {
      for (const line of verify.details) process.stdout.write(`  [ OK ] ${line}\n`);
      for (const line of verify.problems) process.stdout.write(`  [失败] ${line}\n`);
    }
    if (!verify.ok) {
      if (!jsonOutput) {
        process.stdout.write('\n验证未通过，升级未完成。\n');
        for (const line of restoreHint(ctx)) process.stdout.write(`  ${line}\n`);
      }
      printSummary({
        ok: false,
        step,
        dryRun,
        configPath,
        dataRoot: config.dataRoot,
        check: inspected,
        backup,
        migrations,
        verify,
        restoreHint: restoreHint(ctx),
        jsonOutput
      });
      return 2;
    }
  }

  printSummary({
    ok: true,
    step,
    dryRun,
    configPath,
    dataRoot: config.dataRoot,
    check: inspected,
    backup,
    migrations,
    verify,
    jsonOutput
  });
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
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    reportError(err);
  }
}

module.exports = { main, MIGRATIONS, inspect, loadLedger, signatureHash };
