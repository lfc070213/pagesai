#!/usr/bin/env node
'use strict';
/**
 * PagesAI 备份工具（P6 运维工具）
 *
 * 方案依据：§9（备份包含数据库、各模块固定数据根、秘密材料引用与版本清单）、
 *           §16.2（升级与恢复工具）、§6.1（数据根权威记录）。
 *
 * 备份内容：
 *  - database/：数据库/状态目录快照（当前为 state/：部署标记、身份导出、迁移台账、秘密引用）；
 *  - data/<regionId>/：每个已登记存储区域的数据根；
 *  - config.snapshot.json：脱敏配置副本（config.json 本身不含秘密值）；
 *  - references.json：用户归属、区域映射、业务引用与迁移版本；
 *  - files.sha256：逐文件 sha256；manifest.json：区域树哈希与版本清单。
 *
 * 秘密材料：只记录引用（路径、是否就位），绝不复制秘密值；秘密材料独立保护。
 *
 * 约束：仅 Node 内置模块；拒绝符号链接；--dry-run 只读。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_SCHEMA_PATH = path.join(PROJECT_ROOT, 'config', 'config.schema.json');
const CORE_VALIDATE_PATH = path.join(PROJECT_ROOT, 'core', 'contracts', 'validate.js');
const CORE_REGISTRY_PATH = path.join(PROJECT_ROOT, 'core', 'storage', 'registry.js');

const PRODUCT = 'pagesai';
const BACKUP_FORMAT_VERSION = 1;

class ToolError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'ToolError';
    this.exitCode = exitCode;
  }
}

function helpText() {
  return [
    'PagesAI 备份（tools/backup.js）',
    '',
    '用法：',
    '  node tools/backup.js [--out <目录>] [--config <路径>] [--label <说明>] [--dry-run] [--json]',
    '',
    '备份内容：',
    '  database/              数据库/状态目录快照（部署标记、身份导出、迁移台账）',
    '  data/<regionId>/       每个存储区域的数据根',
    '  config.snapshot.json   配置副本（不含秘密值）',
    '  references.json        用户归属、区域映射与业务引用',
    '  files.sha256           逐文件 sha256',
    '  manifest.json          版本清单、区域树哈希、秘密材料引用',
    '',
    '选项：',
    '  --out <目录>           备份输出目录（默认 PAGESAI_BACKUP_ROOT 或 <dataRoot>/backups）',
    '  --config <路径>        配置文件（默认 <安装根>/config.json 或 PAGESAI_CONFIG）',
    '  --label <说明>         备份标签（如 pre-upgrade）',
    '  --dry-run              只统计并打印计划，不写盘',
    '  --json                 机器可读输出',
    '  --help                 显示本帮助',
    '',
    '示例：',
    '  node tools/backup.js --out /srv/pagesai-backups --label manual',
    '',
    '退出码：0 成功；1 参数/环境错误；2 契约或数据根校验失败。'
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
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function compactStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
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

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read = 0;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/** 递归收集文件与目录；拒绝符号链接与特殊文件，避免备份越界或丢内容。 */
function collectEntries(root) {
  const entries = [];
  (function walk(dir, relBase) {
    const names = fs.readdirSync(dir).sort();
    for (const name of names) {
      const abs = path.join(dir, name);
      const rel = relBase ? `${relBase}/${name}` : name;
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) {
        throw new ToolError(`发现符号链接，拒绝备份（避免越界与不一致）：${abs}`, 2);
      }
      if (stat.isDirectory()) {
        entries.push({ rel, abs, type: 'dir', mode: stat.mode & 0o777 });
        walk(abs, rel);
        continue;
      }
      if (stat.isFile()) {
        entries.push({ rel, abs, type: 'file', size: stat.size, mode: stat.mode & 0o777 });
        continue;
      }
      throw new ToolError(`不支持的文件类型，拒绝备份：${abs}`, 2);
    }
  })(root, '');
  return entries;
}

function entriesStats(entries) {
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (entry.type === 'dir') dirs += 1;
    else {
      files += 1;
      bytes += entry.size;
    }
  }
  return { files, dirs, bytes };
}

function treeHashOf(entries, fileHashes) {
  const lines = [];
  for (const entry of entries) {
    if (entry.type === 'dir') {
      lines.push(`${entry.rel}\0D`);
    } else {
      const hash = fileHashes.get(entry.rel);
      if (!hash) throw new ToolError(`计算树哈希缺少文件摘要：${entry.rel}`, 1);
      lines.push(`${entry.rel}\0F\0${hash}\0${entry.size}`);
    }
  }
  lines.sort();
  return crypto.createHash('sha256').update(`${lines.join('\n')}\n`).digest('hex');
}

function assertNoOverlap(scopes) {
  for (let i = 0; i < scopes.length; i += 1) {
    for (let j = i + 1; j < scopes.length; j += 1) {
      const a = scopes[i];
      const b = scopes[j];
      if (isInside(a.dir, b.dir) || isInside(b.dir, a.dir)) {
        throw new ToolError(`备份范围重叠：${a.label} 与 ${b.label}（请修正配置中的数据根）`, 2);
      }
    }
  }
}

function collectUsers(stateDir) {
  const file = path.join(stateDir, 'identity.json');
  if (!fs.existsSync(file)) return { present: false, users: [] };
  const raw = readJson(file, '身份快照');
  const users = Object.values(raw.users || {})
    .filter((user) => user && typeof user === 'object')
    .map((user) => ({ id: user.id, username: user.username, email: user.email || null }));
  return { present: true, users };
}

function ownerFieldName(region) {
  return (region.ownership && region.ownership.ownerField) || 'username';
}

/** 身份快照可接受的目录名：用户名、用户 ID、邮箱，以及用户 ID 的 SHA-256 前缀（Glim 工作区）。 */
function ownerKeySet(users) {
  const known = new Set();
  for (const user of users) {
    for (const value of [user.username, user.id, user.email]) {
      if (!value) continue;
      known.add(String(value));
      known.add(String(value).normalize('NFKC').trim().toLowerCase());
    }
    if (user.id) {
      const digest = crypto.createHash('sha256').update(String(user.id), 'utf8').digest('hex');
      known.add(digest);
      known.add(digest.slice(0, 32));
    }
  }
  return known;
}

/**
 * 观测按用户区域的目录，判断是否都能映射到身份快照中的用户。
 * 区域根下可能有一层固定容器目录（如 paper 的 uploads/、glim 的 workspaces/），
 * 因此除直接匹配外再向下看一层：
 *  - 容器内所有子目录都能映射 → 容器本身不算孤儿；
 *  - 容器内出现无法映射的子目录 → 按子目录名报告孤儿；
 *  - 空目录（尚无用户写入）不算证据，忽略；普通文件（如 paper.json）不参与归属。
 */
function observeOwners(root, region, users) {
  if (region.ownership.rule !== 'per-user') return { observed: [], orphan: [] };
  const known = ownerKeySet(users);
  const topLevel = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.name !== '.DS_Store' && entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const orphan = [];
  for (const name of topLevel) {
    if (known.has(name)) continue;
    const childDirs = fs
      .readdirSync(path.join(root, name), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    if (childDirs.length === 0) continue;
    orphan.push(...childDirs.filter((child) => !known.has(child)));
  }
  return { observed: topLevel, orphan: orphan.sort() };
}

function copyScope(sourceRoot, destinationRoot) {
  const entries = collectEntries(sourceRoot);
  const stats = entriesStats(entries);
  const hashes = new Map();
  fs.mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const target = path.join(destinationRoot, entry.rel);
    if (entry.type === 'dir') {
      fs.mkdirSync(target, { recursive: true, mode: entry.mode || 0o750 });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o750 });
    fs.copyFileSync(entry.abs, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, entry.mode);
    const sourceHash = sha256File(entry.abs);
    const targetHash = sha256File(target);
    if (sourceHash !== targetHash) {
      throw new ToolError(`备份复制校验失败：${entry.abs}`, 1);
    }
    hashes.set(entry.rel, targetHash);
  }
  return { entries, hashes, stats, treeHash: treeHashOf(entries, hashes) };
}

function buildManifest(context) {
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    backupId: context.backupId,
    label: context.label,
    createdAt: context.createdAt,
    product: context.config.product,
    productVersion: context.config.productVersion,
    configSchemaVersion: context.config.schemaVersion,
    source: {
      dataRoot: context.config.dataRoot,
      installRoot: context.config.installRoot,
      configPath: context.configPath
    },
    deployment: {
      deploymentId: context.config.deploymentId,
      modules: context.config.modules.slice(),
      diskVariant: context.config.disk.variant,
      registrationMode: context.config.registration.mode,
      domain: context.config.domain,
      port: context.config.port,
      publicBaseUrl: context.config.publicBaseUrl
    },
    versions: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      migrations: context.ledger.applied.map((entry) => ({
        id: entry.id,
        name: entry.name,
        signatureSha256: entry.signatureSha256
      }))
    },
    database: {
      engine: context.config.database.engine,
      relativeDir: 'database',
      files: context.database.stats.files,
      dirs: context.database.stats.dirs,
      bytes: context.database.stats.bytes,
      treeHash: context.database.treeHash
    },
    roots: context.roots.map((root) => ({
      regionId: root.region.regionId,
      module: root.region.module,
      configKey: root.region.physicalRoot.configKey,
      ownership: root.region.ownership.rule,
      relativeDir: `data/${root.region.regionId}`,
      sourcePath: root.sourcePath,
      files: root.stats.files,
      dirs: root.stats.dirs,
      bytes: root.stats.bytes,
      treeHash: root.treeHash
    })),
    counts: {
      files: context.database.stats.files + context.roots.reduce((sum, root) => sum + root.stats.files, 0),
      dirs: context.database.stats.dirs + context.roots.reduce((sum, root) => sum + root.stats.dirs, 0),
      bytes: context.database.stats.bytes + context.roots.reduce((sum, root) => sum + root.stats.bytes, 0)
    },
    secretReference: context.secretReference,
    configSnapshotSha256: context.configSnapshotSha256
  };
}

function buildReferences(context) {
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    backupId: context.backupId,
    deploymentId: context.config.deploymentId,
    generatedAt: context.createdAt,
    users: context.users.users,
    identitySnapshotPresent: context.users.present,
    storage: { ...context.config.storage },
    regions: context.roots.map((root) => ({
      regionId: root.region.regionId,
      module: root.region.module,
      configKey: root.region.physicalRoot.configKey,
      ownership: root.region.ownership.rule,
      ownerField: ownerFieldName(root.region),
      relativeDataDir: `data/${root.region.regionId}`,
      sourcePath: root.sourcePath,
      observedOwners: root.owners.observed,
      orphanOwners: root.owners.orphan
    })),
    migrations: context.ledger.applied.map((entry) => ({
      id: entry.id,
      module: entry.module,
      name: entry.name,
      signatureSha256: entry.signatureSha256,
      appliedAt: entry.appliedAt
    })),
    secretReference: context.secretReference,
    configSnapshot: 'config.snapshot.json'
  };
}

function printPlan(summary) {
  if (summary.jsonOutput) {
    const { jsonOutput, ...rest } = summary;
    process.stdout.write(`${JSON.stringify(rest, null, 2)}\n`);
    return;
  }
  const lines = [];
  lines.push(
    summary.dryRun ? 'PagesAI 备份计划（--dry-run：未写盘）' : 'PagesAI 备份完成'
  );
  lines.push('');
  lines.push(`备份目录：${summary.backupDir}`);
  lines.push(`部署标识：${summary.deploymentId}`);
  lines.push(`标签：${summary.label || '（无）'}`);
  lines.push(
    `合计：${summary.counts.files} 个文件，${summary.counts.dirs} 个目录，${formatBytes(summary.counts.bytes)}`
  );
  lines.push(
    `数据库快照：${summary.database.files} 个文件，${formatBytes(summary.database.bytes)}（engine=${summary.database.engine}）`
  );
  lines.push('存储区域：');
  for (const root of summary.roots) {
    lines.push(
      `  - ${root.regionId}：${root.files} 个文件，${formatBytes(root.bytes)}` +
        `${root.orphanOwners.length ? `（${root.orphanOwners.length} 个归属未匹配用户）` : ''}`
    );
  }
  lines.push(
    `秘密材料：仅引用 ${summary.secretReference.reference}（${summary.secretReference.present ? '就位' : '未就位'}），未复制内容`
  );
  lines.push('校验：files.sha256（逐文件）与 manifest.json（区域树哈希）');
  if (summary.externalRoots && summary.externalRoots.length > 0) {
    lines.push(
      `[提示] ${summary.externalRoots.length} 个区域位于数据根之外，恢复时需手动重定位：` +
        summary.externalRoots.join('；')
    );
  }
  if (summary.backupInsideDataRoot) {
    lines.push('[提示] 备份位于数据根内（默认）；生产环境建议用 --out 指向独立卷，避免与数据一起丢失。');
  }
  if (summary.database.engine !== 'json-store') {
    lines.push(
      `[提示] database.engine=${summary.database.engine}：本工具不能直接导出外部数据库，` +
        '请由运维把数据库转储放入备份目录的 database/ 后再归档。'
    );
  }
  if (summary.dryRun) lines.push('（--dry-run 未创建任何文件或目录。）');
  process.stdout.write(`${lines.join('\n')}\n`);
}

function main(argv) {
  const { flags, values } = parseArgs(argv, {
    booleans: ['help', 'dry-run', 'json'],
    valueFlags: ['out', 'config', 'label']
  });
  if (flags.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }

  const jsonOutput = Boolean(flags.json);
  const dryRun = Boolean(flags['dry-run']);
  const configPath = resolveConfigPath(values);
  const config = loadConfigFile(configPath);
  const stateDir = config.database.stateDir;

  if (!fs.existsSync(stateDir)) {
    throw new ToolError(`状态目录不存在：${stateDir}（先运行 tools/init.js）`, 1);
  }
  const markerPath = path.join(stateDir, 'deployment.json');
  if (!fs.existsSync(markerPath)) {
    throw new ToolError(`缺少部署标记：${markerPath}（先运行 tools/init.js）`, 1);
  }
  const marker = readJson(markerPath, '部署标记');
  if (marker.deploymentId !== config.deploymentId) {
    throw new ToolError(
      `部署标识不一致（config ${config.deploymentId} / marker ${marker.deploymentId}），拒绝备份。`,
      2
    );
  }
  if (path.resolve(marker.dataRoot) !== path.resolve(config.dataRoot)) {
    throw new ToolError(
      `部署标记记录的数据根 ${marker.dataRoot} 与配置 ${config.dataRoot} 不一致，拒绝备份。`,
      2
    );
  }

  const ledgerPath = path.join(stateDir, 'migrations.json');
  const ledger = fs.existsSync(ledgerPath)
    ? readJson(ledgerPath, '迁移台账')
    : { formatVersion: 1, applied: [] };
  if (ledger.formatVersion !== 1 || !Array.isArray(ledger.applied)) {
    throw new ToolError('迁移台账格式不受支持，拒绝备份。', 2);
  }

  const outDir = path.resolve(
    values.out || process.env.PAGESAI_BACKUP_ROOT || path.join(config.dataRoot, 'backups')
  );

  // 备份范围：状态目录（数据库快照） + 每个区域数据根。
  const scopes = [{ label: `database(${stateDir})`, dir: stateDir }];
  const rootSpecs = config.regions.map((region) => {
    const key = region.physicalRoot.configKey;
    const rootPath = config.storage[key];
    if (!rootPath) {
      throw new ToolError(`区域 ${region.regionId} 缺少物理根配置 ${key}`, 2);
    }
    return { region, sourcePath: rootPath };
  });
  for (const spec of rootSpecs) scopes.push({ label: spec.region.regionId, dir: spec.sourcePath });
  assertNoOverlap(scopes);

  for (const scope of scopes) {
    if (!fs.existsSync(scope.dir)) {
      throw new ToolError(`备份源不存在：${scope.dir}\n请先运行 node tools/upgrade.js --step migrate 补齐区域目录。`, 1);
    }
  }
  for (const scope of scopes) {
    if (isInside(scope.dir, outDir)) {
      throw new ToolError(`备份输出目录不能位于备份源内部：${outDir} ⊂ ${scope.dir}`, 1);
    }
  }
  const secretResolved = resolveSecretReference(config);
  for (const scope of scopes) {
    if (isInside(scope.dir, secretResolved)) {
      throw new ToolError(
        `秘密材料位于备份范围内，拒绝复制秘密内容：${secretResolved} ⊂ ${scope.dir}\n` +
          '请把秘密材料移出数据根（config.secrets.reference 指向独立受保护位置）。',
        2
      );
    }
  }
  const externalRoots = rootSpecs
    .filter((spec) => !isInside(config.dataRoot, spec.sourcePath))
    .map((spec) => `${spec.region.regionId} → ${spec.sourcePath}`);
  const backupInsideDataRoot = isInside(config.dataRoot, outDir);

  const createdAt = new Date();
  const backupId = `pagesai-${compactStamp(createdAt)}-${crypto.randomBytes(3).toString('hex')}`;
  const finalDir = path.join(outDir, backupId);
  const stagingDir = path.join(outDir, `.tmp-${backupId}`);

  // 统计与归属观测（只读，dry-run 也会执行）。
  const users = collectUsers(stateDir);
  const observations = [];
  let totalFiles = 0;
  let totalDirs = 0;
  let totalBytes = 0;
  for (const spec of rootSpecs) {
    const entries = collectEntries(spec.sourcePath);
    const stats = entriesStats(entries);
    totalFiles += stats.files;
    totalDirs += stats.dirs;
    totalBytes += stats.bytes;
    const owners = observeOwners(spec.sourcePath, spec.region, users.users);
    observations.push({ ...spec, entries, stats, owners });
  }
  const dbEntries = collectEntries(stateDir);
  const dbStats = entriesStats(dbEntries);
  totalFiles += dbStats.files;
  totalDirs += dbStats.dirs;
  totalBytes += dbStats.bytes;

  const secretReference = {
    mode: config.secrets.mode,
    reference: config.secrets.reference,
    resolvedPath: secretResolved,
    present: fs.existsSync(secretResolved),
    copied: false,
    note: '仅记录引用；秘密材料独立保护，备份不含秘密值。'
  };

  const planSummary = {
    ok: true,
    dryRun,
    backupId,
    backupDir: finalDir,
    label: values.label || null,
    createdAt: createdAt.toISOString(),
    deploymentId: config.deploymentId,
    counts: { files: totalFiles, dirs: totalDirs, bytes: totalBytes },
    database: { engine: config.database.engine, files: dbStats.files, bytes: dbStats.bytes },
    roots: observations.map((item) => ({
      regionId: item.region.regionId,
      files: item.stats.files,
      bytes: item.stats.bytes,
      orphanOwners: item.owners.orphan
    })),
    secretReference,
    backupInsideDataRoot,
    externalRoots,
    jsonOutput
  };

  if (dryRun) {
    printPlan(planSummary);
    return 0;
  }

  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: false, mode: 0o700 });

  const checksumLines = [];
  try {
    // 1) 数据库/状态目录
    const database = copyScope(stateDir, path.join(stagingDir, 'database'));
    for (const entry of database.entries) {
      if (entry.type === 'file') {
        checksumLines.push(`${database.hashes.get(entry.rel)}  database/${entry.rel}`);
      }
    }

    // 2) 各区域数据根
    const roots = [];
    for (const item of observations) {
      const destination = path.join(stagingDir, 'data', item.region.regionId);
      const copied = copyScope(item.sourcePath, destination);
      for (const entry of copied.entries) {
        if (entry.type === 'file') {
          checksumLines.push(`${copied.hashes.get(entry.rel)}  data/${item.region.regionId}/${entry.rel}`);
        }
      }
      roots.push({
        region: item.region,
        sourcePath: item.sourcePath,
        stats: copied.stats,
        treeHash: copied.treeHash,
        owners: item.owners
      });
    }

    // 3) 配置副本（不含秘密值；config.json 本身不保存秘密）
    const configSnapshotPath = path.join(stagingDir, 'config.snapshot.json');
    const snapshotText = `${JSON.stringify(config, null, 2)}\n`;
    fs.writeFileSync(configSnapshotPath, snapshotText, { mode: 0o600 });
    const configSnapshotSha256 = crypto.createHash('sha256').update(snapshotText).digest('hex');

    // 4) 引用清单与逐文件校验和
    const references = buildReferences({
      config,
      configPath,
      backupId,
      createdAt: createdAt.toISOString(),
      users,
      roots,
      ledger,
      secretReference
    });
    writeJsonAtomic(path.join(stagingDir, 'references.json'), references, 0o600);

    checksumLines.sort();
    fs.writeFileSync(path.join(stagingDir, 'files.sha256'), `${checksumLines.join('\n')}\n`, {
      mode: 0o600
    });

    // 5) 版本清单（最后写，作为完整性提交点）
    const manifest = buildManifest({
      config,
      configPath,
      backupId,
      label: values.label || null,
      createdAt: createdAt.toISOString(),
      ledger,
      database,
      roots,
      secretReference,
      configSnapshotSha256
    });
    writeJsonAtomic(path.join(stagingDir, 'manifest.json'), manifest, 0o600);

    fs.renameSync(stagingDir, finalDir);
  } catch (err) {
    if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }

  const summary = {
    ...planSummary,
    backupDir: finalDir,
    counts: { files: totalFiles, dirs: totalDirs, bytes: totalBytes },
    manifest: path.join(finalDir, 'manifest.json'),
    checksums: path.join(finalDir, 'files.sha256'),
    jsonOutput
  };
  printPlan(summary);
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

module.exports = {
  main,
  collectEntries,
  collectUsers,
  copyScope,
  treeHashOf,
  sha256File,
  BACKUP_FORMAT_VERSION,
};
