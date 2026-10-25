#!/usr/bin/env node
'use strict';
/**
 * PagesAI 恢复工具（P6 运维工具）
 *
 * 方案依据：§9（恢复演练必须校验用户归属、文件哈希与业务引用，不只检查数据库能启动）、
 *           §16.2（升级与恢复工具）、§6.1（数据根显式登记）。
 *
 * 成功判定（三者缺一不可）：
 *  1. 用户归属：按用户区域的一级目录必须能映射到身份快照中的用户名或用户 ID；
 *  2. 文件哈希：files.sha256 逐文件 sha256 与区域树哈希全部匹配；
 *  3. 业务引用：区域 ↔ 配置键 ↔ 数据目录、部署标识、迁移台账与版本清单互相一致。
 *
 * 默认保留数据：
 *  - 目标数据根非空时必须显式 --replace-existing，旧数据整体改名保留、不删除；
 *  - 恢复先写入 staging，校验通过后才切换，失败时目标数据根保持原样；
 *  - 备份只含秘密材料引用，恢复不复制秘密值。
 *
 * --verify-only 只校验不写盘；--dry-run 同样只读。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_SCHEMA_PATH = path.join(PROJECT_ROOT, 'config', 'config.schema.json');
const CORE_VALIDATE_PATH = path.join(PROJECT_ROOT, 'core', 'contracts', 'validate.js');
const UPGRADE_PATH = path.join(__dirname, 'upgrade.js');

const PRODUCT = 'pagesai';
const SUPPORTED_BACKUP_FORMAT = 1;
const SUPPORTED_CONFIG_SCHEMA = 1;
const LEGACY_DATA_ROOTS = Object.freeze([
  '/data',
  '/home/ubuntu/glim',
  '/srv/uniflourish',
  '/opt/uniflourish',
  '/var/lib/uniflourish'
]);
const TOP_LEVEL_ALLOWED = new Set([
  'manifest.json',
  'references.json',
  'files.sha256',
  'config.snapshot.json',
  'database',
  'data'
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
    'PagesAI 恢复（tools/restore.js）',
    '',
    '用法：',
    '  node tools/restore.js --backup <目录> [--target-data-root <目录>] [选项]',
    '',
    '恢复前必须全部通过的校验：',
    '  - 备份清单格式与版本（来自更新版本的备份会被拒绝）',
    '  - files.sha256 逐文件哈希 + manifest.json 区域树哈希',
    '  - 用户归属（按用户区域的一级目录 ↔ 身份快照）',
    '  - 业务引用（区域 ↔ 配置键 ↔ 数据目录、部署标识、迁移台账）',
    '',
    '选项：',
    '  --backup <目录>               备份目录（tools/backup.js 的产物）',
    '  --target-data-root <目录>     恢复到的新数据根（非 --verify-only 时必填）',
    '  --config <路径>               参照的现有配置（可选，用于目标兼容性检查）',
    '  --verify-only                 只校验备份与目标条件，不写盘',
    '  --replace-existing            目标数据根非空时，改名保留旧数据后恢复',
    '  --allow-orphans               允许无法映射到用户的孤儿目录（不推荐；默认判定失败）',
    '  --allow-data-root-in-install  允许目标位于安装目录内（不推荐）',
    '  --dry-run                     只打印校验结果与计划，不写盘',
    '  --json                        机器可读输出',
    '  --help                        显示本帮助',
    '',
    '示例：',
    '  node tools/restore.js --backup /srv/pagesai-backups/pagesai-20261023T030912Z-dea0f7 --verify-only',
    '  node tools/restore.js --backup /srv/pagesai-backups/<id> --target-data-root /srv/pagesai-data-restored',
    '',
    '退出码：0 校验通过/恢复成功；1 参数或环境错误；2 校验失败（未写入任何数据）。'
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
    throw new ToolError(`${label} 不可读或不是合法 JSON：${file}\n${err.message}`, 2);
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

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
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

function assertAbsolute(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new ToolError(`${label} 不能为空`, 1);
  if (!path.isAbsolute(value)) throw new ToolError(`${label} 必须是绝对路径：${value}`, 1);
  return path.resolve(value);
}

function assertRestoreTarget(targetValue, { backupDir, allowInInstall }) {
  const resolved = assertAbsolute(targetValue, '--target-data-root');
  if (resolved === path.parse(resolved).root) throw new ToolError('目标数据根不能是文件系统根目录', 1);
  if (resolved === path.resolve(require('node:os').homedir())) {
    throw new ToolError('目标数据根不能是用户主目录', 1);
  }
  for (const legacy of LEGACY_DATA_ROOTS) {
    if (isInside(legacy, resolved)) {
      throw new ToolError(`目标数据根位于旧平台/现网根 ${legacy} 之下，拒绝恢复：${resolved}`, 2);
    }
  }
  if (!allowInInstall && isInside(PROJECT_ROOT, resolved)) {
    throw new ToolError(
      `目标数据根不得位于安装目录内：${resolved}\n如确需如此，加 --allow-data-root-in-install。`,
      1
    );
  }
  if (isInside(backupDir, resolved) || isInside(resolved, backupDir)) {
    throw new ToolError(`目标数据根与备份目录不能相互包含：${resolved} ↔ ${backupDir}`, 1);
  }
  return resolved;
}

function validateConfigObject(config, label) {
  const schema = readJson(CONFIG_SCHEMA_PATH, 'config schema');
  const { validate } = require(CORE_VALIDATE_PATH);
  const result = validate(schema, config);
  if (!result.valid) {
    const lines = result.errors.map((e) => `  - ${e.path}: ${e.message}`);
    throw new ToolError(`${label} 不符合 config/config.schema.json：\n${lines.join('\n')}`, 2);
  }
  return config;
}

/** 递归树哈希：目录 D、文件 F+sha256+size；与 tools/backup.js 的算法一致。 */
function treeHashOfDirectory(root) {
  const lines = [];
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  (function walk(dir, relBase) {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const rel = relBase ? `${relBase}/${name}` : name;
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) throw new ToolError(`发现符号链接，拒绝继续：${abs}`, 2);
      if (stat.isDirectory()) {
        dirs += 1;
        lines.push(`${rel}\0D`);
        walk(abs, rel);
        continue;
      }
      if (stat.isFile()) {
        files += 1;
        bytes += stat.size;
        lines.push(`${rel}\0F\0${sha256File(abs)}\0${stat.size}`);
        continue;
      }
      throw new ToolError(`不支持的文件类型，拒绝继续：${abs}`, 2);
    }
  })(root, '');
  lines.sort();
  return {
    treeHash: sha256(`${lines.join('\n')}\n`),
    files,
    dirs,
    bytes
  };
}

function collectEntries(root) {
  const entries = [];
  (function walk(dir, relBase) {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const rel = relBase ? `${relBase}/${name}` : name;
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) throw new ToolError(`发现符号链接，拒绝继续：${abs}`, 2);
      if (stat.isDirectory()) {
        entries.push({ rel, abs, type: 'dir', mode: stat.mode & 0o777 });
        walk(abs, rel);
        continue;
      }
      if (stat.isFile()) {
        entries.push({ rel, abs, type: 'file', size: stat.size, mode: stat.mode & 0o777 });
        continue;
      }
      throw new ToolError(`不支持的文件类型，拒绝继续：${abs}`, 2);
    }
  })(root, '');
  return entries;
}

function readChecksums(backupDir) {
  const file = path.join(backupDir, 'files.sha256');
  if (!fs.existsSync(file)) throw new ToolError('备份缺少 files.sha256', 2);
  const map = new Map();
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) throw new ToolError(`files.sha256 行格式非法：${line.slice(0, 80)}`, 2);
    const rel = match[2];
    const segments = rel.split('/');
    if (path.isAbsolute(rel) || segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
      throw new ToolError(`files.sha256 含非法路径（拒绝越界）：${rel}`, 2);
    }
    if (map.has(rel)) throw new ToolError(`files.sha256 存在重复条目：${rel}`, 2);
    map.set(rel, match[1]);
  }
  return map;
}

function copyTreeVerified(sourceRoot, destinationRoot) {
  const entries = collectEntries(sourceRoot);
  let files = 0;
  let bytes = 0;
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
    if (sha256File(entry.abs) !== sha256File(target)) {
      throw new ToolError(`恢复复制校验失败：${entry.abs}`, 2);
    }
    files += 1;
    bytes += entry.size;
  }
  return { files, bytes };
}


/**
 * 校验恢复后的状态目录：
 *  - 除 deployment.json（允许重写 dataRoot/storage）外，其余状态文件必须与备份逐文件摘要一致；
 *  - deployment.json 必须指向目标数据根与同一部署；
 *  - config.restored.json 必须存在且满足配置契约。
 */
function verifyStateAgainstBackup(stateDir, checksums, expectedDataRoot, expectedDeploymentId) {
  const problems = [];
  let files = 0;
  let bytes = 0;
  for (const [rel, expected] of checksums) {
    if (!rel.startsWith('database/')) continue;
    const inner = rel.slice('database/'.length);
    const abs = path.join(stateDir, inner);
    if (inner === 'deployment.json') continue;
    if (!fs.existsSync(abs)) {
      problems.push(`缺少状态文件：${inner}`);
      continue;
    }
    if (sha256File(abs) !== expected) problems.push(`状态文件摘要不符：${inner}`);
    const stat = fs.lstatSync(abs);
    files += 1;
    bytes += stat.size;
  }
  const deploymentPath = path.join(stateDir, 'deployment.json');
  if (!fs.existsSync(deploymentPath)) {
    problems.push('缺少重写后的 deployment.json');
  } else {
    try {
      const marker = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
      if (expectedDataRoot && marker.dataRoot !== expectedDataRoot) {
        problems.push('deployment.json 的 dataRoot 未指向目标数据根');
      }
      if (expectedDeploymentId && marker.deploymentId !== expectedDeploymentId) {
        problems.push('deployment.json 的部署标识与备份不一致');
      }
    } catch (err) {
      problems.push(`deployment.json 不可读：${err.message}`);
    }
    const stat = fs.lstatSync(deploymentPath);
    files += 1;
    bytes += stat.size;
  }
  const configPath = path.join(stateDir, 'config.restored.json');
  if (!fs.existsSync(configPath)) {
    problems.push('缺少 config.restored.json');
  } else {
    try {
      validateConfigObject(JSON.parse(fs.readFileSync(configPath, 'utf8')), 'config.restored.json');
    } catch (err) {
      problems.push(err.message);
    }
  }
  return { problems, files, bytes };
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
 * 观测按用户区域的目录并判定孤儿。
 * 区域根下可能有一层固定容器目录（如 paper 的 uploads/、glim 的 workspaces/）：
 * 容器内全部子目录可映射时容器本身合法；出现无法映射的子目录时按子目录名报告；
 * 空目录与普通文件不参与归属判定。判定口径必须与 tools/backup.js 的 references.json 一致。
 */
function observeOwned(scopeRoot, known) {
  if (!fs.existsSync(scopeRoot)) return { observed: [], orphan: [] };
  const observed = fs
    .readdirSync(scopeRoot, { withFileTypes: true })
    .filter((entry) => entry.name !== '.DS_Store' && entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const orphan = [];
  for (const name of observed) {
    if (known.has(name)) continue;
    const childDirs = fs
      .readdirSync(path.join(scopeRoot, name), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    if (childDirs.length === 0) continue;
    orphan.push(...childDirs.filter((child) => !known.has(child)));
  }
  return { observed, orphan: orphan.sort() };
}

function checkOwnership(scopeRoot, region, users) {
  if (region.ownership !== 'per-user') return { observed: [], orphan: [], skipped: true };
  return { ...observeOwned(scopeRoot, ownerKeySet(users)), skipped: false };
}

function relStoragePaths(snapshot) {
  const dataRoot = path.resolve(snapshot.dataRoot);
  const mapping = new Map();
  for (const [key, value] of Object.entries(snapshot.storage)) {
    const abs = path.resolve(value);
    const rel = path.relative(dataRoot, abs);
    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new ToolError(
        `配置键 ${key} 的物理根不在原数据根内，无法自动重定位：${value}（原数据根 ${dataRoot}）`,
        2
      );
    }
    mapping.set(key, rel);
  }
  const stateRel = path.relative(dataRoot, path.resolve(snapshot.database.stateDir));
  if (stateRel === '' || stateRel === '..' || stateRel.startsWith(`..${path.sep}`) || path.isAbsolute(stateRel)) {
    throw new ToolError(
      `数据库状态目录不在原数据根内，无法自动重定位：${snapshot.database.stateDir}`,
      2
    );
  }
  return { mapping, stateRel };
}

function verifyBackup(backupDir, { allowOrphans }) {
  const checks = [];
  const problems = [];
  const add = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    if (!ok) problems.push(`${name}：${detail}`);
  };

  // ---- 1. 清单与版本 ----
  const manifestPath = path.join(backupDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new ToolError(`备份缺少 manifest.json：${backupDir}`, 2);
  const manifest = readJson(manifestPath, '备份清单');
  add(
    '备份格式',
    manifest && manifest.formatVersion === SUPPORTED_BACKUP_FORMAT && manifest.product === PRODUCT,
    `formatVersion=${manifest && manifest.formatVersion}，product=${manifest && manifest.product}`
  );
  if (problems.length > 0) return { checks, problems, manifest: null, checksums: null };
  const deploymentId = manifest.deployment && manifest.deployment.deploymentId;
  if (typeof deploymentId !== 'string' || deploymentId.length === 0) {
    add('清单部署标识', false, 'manifest 缺少 deployment.deploymentId');
    return { checks, problems, manifest, checksums: null };
  }
  if (manifest.configSchemaVersion > SUPPORTED_CONFIG_SCHEMA) {
    add(
      '配置结构版本',
      false,
      `备份来自更新版本（schemaVersion=${manifest.configSchemaVersion}，本工具支持 ${SUPPORTED_CONFIG_SCHEMA}）；请使用匹配版本的工具恢复`
    );
    return { checks, problems, manifest, checksums: null };
  }

  // ---- 2. 配置副本与业务引用 ----
  const snapshotPath = path.join(backupDir, 'config.snapshot.json');
  if (!fs.existsSync(snapshotPath)) throw new ToolError('备份缺少 config.snapshot.json', 2);
  const snapshot = validateConfigObject(readJson(snapshotPath, '配置副本'), '备份内的 config.snapshot.json');
  add('配置副本', true, `schemaVersion=${snapshot.schemaVersion}，deploymentId=${snapshot.deploymentId}`);
  add(
    '部署标识一致',
    snapshot.deploymentId === deploymentId,
    `config=${snapshot.deploymentId} / manifest=${deploymentId}`
  );
  if (snapshot.registration.mode === 'email' && !snapshot.modules.includes('mail')) {
    add('注册模式依赖', false, '注册方式为 email 但备份的模块清单没有 mail');
  }

  const referencesPath = path.join(backupDir, 'references.json');
  if (!fs.existsSync(referencesPath)) throw new ToolError('备份缺少 references.json', 2);
  const references = readJson(referencesPath, '引用清单');
  add(
    '引用清单',
    references.formatVersion === SUPPORTED_BACKUP_FORMAT && references.deploymentId === deploymentId,
    `formatVersion=${references.formatVersion}，deploymentId=${references.deploymentId}`
  );

  // ---- 3. 逐文件哈希 ----
  const checksums = readChecksums(backupDir);
  let hashMismatch = 0;
  let missing = 0;
  for (const [rel, expected] of checksums) {
    const abs = path.join(backupDir, rel);
    if (!fs.existsSync(abs)) {
      missing += 1;
      continue;
    }
    if (!fs.lstatSync(abs).isFile() || sha256File(abs) !== expected) hashMismatch += 1;
  }
  add(
    '文件哈希',
    missing === 0 && hashMismatch === 0 && checksums.size > 0,
    `共 ${checksums.size} 个文件，缺失 ${missing}，摘要不符 ${hashMismatch}`
  );
  const scopePrefixes = ['database/', ...manifest.roots.map((root) => `data/${root.regionId}/`)];
  const outsideScope = [...checksums.keys()].filter(
    (rel) => !scopePrefixes.some((prefix) => rel.startsWith(prefix))
  );
  add(
    '摘要范围',
    outsideScope.length === 0,
    outsideScope.length ? `摘要含区域外条目：${outsideScope.slice(0, 5).join('、')}` : '全部在 database/ 或 data/<regionId>/ 内'
  );

  // ---- 4. 未登记文件与区域树哈希 ----
  const expectedFiles = new Set(checksums.keys());
  const unlisted = [];
  const scopes = [
    { prefix: 'database/', root: path.join(backupDir, 'database') },
    ...manifest.roots.map((root) => ({
      prefix: `data/${root.regionId}/`,
      root: path.join(backupDir, 'data', root.regionId)
    }))
  ];
  for (const scope of scopes) {
    if (!fs.existsSync(scope.root)) {
      add('区域目录存在', false, `缺少 ${scope.root}`);
      continue;
    }
    for (const entry of collectEntries(scope.root)) {
      if (entry.type !== 'file') continue;
      const rel = `${scope.prefix}${entry.rel}`;
      if (!expectedFiles.has(rel)) unlisted.push(rel);
    }
  }
  add('未登记文件', unlisted.length === 0, unlisted.length ? `${unlisted.length} 个未列入 files.sha256：${unlisted.slice(0, 5).join('、')}` : '无');

  for (const name of fs.readdirSync(backupDir)) {
    const abs = path.join(backupDir, name);
    if (!TOP_LEVEL_ALLOWED.has(name)) {
      add('顶层内容', false, `存在未登记条目：${name}`);
      break;
    }
    if (name === 'data') {
      const known = new Set(manifest.roots.map((root) => root.regionId));
      for (const child of fs.readdirSync(abs)) {
        if (!known.has(child)) add('顶层内容', false, `data/ 下存在未登记区域目录：${child}`);
      }
    }
  }

  const databaseTree = treeHashOfDirectory(path.join(backupDir, 'database'));
  add(
    '数据库快照树哈希',
    databaseTree.treeHash === manifest.database.treeHash &&
      databaseTree.files === manifest.database.files &&
      databaseTree.bytes === manifest.database.bytes,
    `文件 ${databaseTree.files}/${manifest.database.files}，字节 ${databaseTree.bytes}/${manifest.database.bytes}`
  );

  for (const root of manifest.roots) {
    const rootDir = path.join(backupDir, 'data', root.regionId);
    if (!fs.existsSync(rootDir)) continue;
    const tree = treeHashOfDirectory(rootDir);
    add(
      `区域树哈希 ${root.regionId}`,
      tree.treeHash === root.treeHash && tree.files === root.files && tree.bytes === root.bytes,
      `文件 ${tree.files}/${root.files}，字节 ${tree.bytes}/${root.bytes}`
    );
  }

  // ---- 5. 身份快照与用户归属 ----
  const identityPath = path.join(backupDir, 'database', 'identity.json');
  if (!fs.existsSync(identityPath)) {
    add('身份快照', false, '备份缺少 database/identity.json，无法校验用户归属');
    return { checks, problems, manifest, checksums: null };
  }
  const identity = readJson(identityPath, '身份快照');
  if (!identity.users || typeof identity.users !== 'object') {
    add('身份快照', false, 'identity.json 缺少 users 集合');
    return { checks, problems, manifest, checksums: null };
  }
  const users = Object.values(identity.users)
    .filter((user) => user && typeof user === 'object')
    .map((user) => ({ id: user.id, username: user.username, email: user.email || null }));
  add('身份快照', true, `${users.length} 个用户`);

  const userKeySet = ownerKeySet(users);
  const referencedUsers = new Set();
  for (const user of references.users || []) {
    if (user.id) referencedUsers.add(user.id);
    if (user.username) referencedUsers.add(user.username);
    if (user.email) referencedUsers.add(user.email);
  }
  const userDiff = [...referencedUsers].filter((key) => !userKeySet.has(key));
  add('引用清单用户', userDiff.length === 0, userDiff.length ? `引用清单含身份快照中不存在的用户：${userDiff.join('、')}` : '一致');

  const referenceByRegion = new Map((references.regions || []).map((region) => [region.regionId, region]));
  let orphanTotal = 0;
  const orphanDetail = [];
  for (const root of manifest.roots) {
    if (root.ownership !== 'per-user') continue;
    const rootDir = path.join(backupDir, 'data', root.regionId);
    if (!fs.existsSync(rootDir)) continue;
    const { observed, orphan } = observeOwned(rootDir, userKeySet);
    const reference = referenceByRegion.get(root.regionId);
    if (!reference) {
      add(`用户归属 ${root.regionId}`, false, 'references.json 缺少该区域');
      continue;
    }
    const recordedOrphan = reference.orphanOwners || [];
    const observedMismatch =
      observed.length !== (reference.observedOwners || []).length ||
      observed.some((name) => !(reference.observedOwners || []).includes(name));
    const orphansOk = (orphan.length === 0 && recordedOrphan.length === 0) || allowOrphans;
    const orphanNames = [...new Set([...orphan, ...recordedOrphan])];
    add(
      `用户归属 ${root.regionId}`,
      observedMismatch ? false : orphansOk,
      observedMismatch
        ? '实际目录与 references.json 记录不一致（备份可能被改动）'
        : orphanNames.length
          ? `${orphansOk ? '已按 --allow-orphans 允许' : '无法映射到用户的目录'}：${orphanNames.join('、')}`
          : `${observed.length} 个用户目录全部匹配`
    );
    orphanTotal += orphanNames.length;
    if (orphanNames.length) orphanDetail.push(`${root.regionId}: ${orphanNames.join('、')}`);
  }
  if (orphanTotal > 0 && allowOrphans) {
    add('孤儿目录处理', true, `已按 --allow-orphans 保留：${orphanDetail.join('；')}`);
  }

  // ---- 6. 业务引用：区域 ↔ 配置键 ↔ 数据目录、迁移版本 ----
  const snapshotRegionIds = (snapshot.regions || []).map((region) => region.regionId).sort();
  const manifestRegionIds = manifest.roots.map((root) => root.regionId).sort();
  add(
    '区域清单一致',
    JSON.stringify(snapshotRegionIds) === JSON.stringify(manifestRegionIds),
    `config=${snapshotRegionIds.length}，manifest=${manifestRegionIds.length}`
  );

  const countedFiles = manifest.database.files + manifest.roots.reduce((sum, root) => sum + root.files, 0);
  const countedBytes = manifest.database.bytes + manifest.roots.reduce((sum, root) => sum + root.bytes, 0);
  add(
    '版本清单总计',
    manifest.counts &&
      manifest.counts.files === countedFiles &&
      manifest.counts.bytes === countedBytes &&
      manifest.counts.dirs === manifest.database.dirs + manifest.roots.reduce((sum, root) => sum + root.dirs, 0),
    `清单 ${manifest.counts && manifest.counts.files}/${manifest.counts && manifest.counts.bytes}，` +
      `实际 ${countedFiles}/${countedBytes}`
  );

  const markerPath = path.join(backupDir, 'database', 'deployment.json');
  if (!fs.existsSync(markerPath)) {
    add('部署标记', false, '备份缺少 database/deployment.json');
  } else {
    const marker = readJson(markerPath, '部署标记');
    add(
      '部署标记',
      marker.deploymentId === deploymentId && marker.dataRoot === snapshot.dataRoot,
      `deploymentId=${marker.deploymentId}，dataRoot=${marker.dataRoot}，期望 dataRoot=${snapshot.dataRoot}`
    );
    const storageMatches = JSON.stringify(marker.storage) === JSON.stringify(snapshot.storage);
    add(
      '业务引用 storage',
      storageMatches,
      storageMatches ? '部署标记与配置副本的 storage 映射一致' : '部署标记与配置副本的 storage 映射不一致'
    );
    const regionsMatch =
      JSON.stringify(marker.regions) === JSON.stringify((snapshot.regions || []).map((region) => region.regionId));
    add(
      '业务引用 regions',
      regionsMatch,
      regionsMatch ? '部署标记与配置副本的区域清单一致' : '部署标记与配置副本的区域清单不一致'
    );
  }

  for (const root of manifest.roots) {
    const reference = referenceByRegion.get(root.regionId);
    if (!reference) continue;
    const configKey = root.configKey;
    if (!snapshot.storage[configKey]) {
      add(`业务引用 ${root.regionId}`, false, `配置副本缺少配置键 ${configKey}`);
      continue;
    }
    add(
      `业务引用 ${root.regionId}`,
      reference.configKey === configKey && reference.relativeDataDir === `data/${root.regionId}`,
      `configKey=${configKey}，relativeDataDir=data/${root.regionId}`
    );
  }

  let migrations = null;
  const ledgerPath = path.join(backupDir, 'database', 'migrations.json');
  if (!fs.existsSync(ledgerPath)) {
    add('迁移台账', false, '备份缺少 database/migrations.json');
  } else {
    migrations = readJson(ledgerPath, '迁移台账');
    const applied = Array.isArray(migrations.applied) ? migrations.applied : null;
    add('迁移台账', migrations.formatVersion === 1 && applied !== null, `formatVersion=${migrations.formatVersion}`);
    if (applied) {
      const referenceIds = (references.migrations || []).map((item) => item.id).join(',');
      const appliedIds = applied.map((item) => item.id).join(',');
      add('业务引用 迁移', referenceIds === appliedIds, `references=[${referenceIds}]，ledger=[${appliedIds}]`);
      const { MIGRATIONS } = require(UPGRADE_PATH);
      const known = new Set(MIGRATIONS.map((migration) => migration.id));
      const unknown = applied.map((item) => item.id).filter((id) => !known.has(id));
      add(
        '迁移版本兼容',
        unknown.length === 0,
        unknown.length ? `备份含当前代码不认识的迁移：${unknown.join('、')}（请使用匹配版本的工具）` : '与当前代码兼容'
      );
    }
  }

  // 重定位路径（同时校验区域不越出原数据根）
  try {
    const relocation = relStoragePaths(snapshot);
    add('区域可重定位', true, `${relocation.mapping.size} 个区域，状态目录 ${relocation.stateRel}`);
  } catch (err) {
    add('区域可重定位', false, err.message);
  }

  return { checks, problems, manifest, snapshot, references, users, migrations, checksums };
}

function printChecks(result, jsonOutput) {
  if (jsonOutput) return;
  const lines = ['恢复校验：'];
  for (const check of result.checks) {
    lines.push(`  [${check.ok ? ' OK ' : '失败'}] ${check.name}：${check.detail}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printSummary(summary) {
  if (summary.jsonOutput) {
    const { jsonOutput, ...rest } = summary;
    process.stdout.write(`${JSON.stringify(rest, null, 2)}\n`);
    return;
  }
  const lines = [];
  lines.push(summary.ok ? '恢复结果：成功' : '恢复结果：失败');
  lines.push(`备份目录：${summary.backupDir}`);
  if (summary.backupId) lines.push(`备份标识：${summary.backupId}`);
  if (summary.target) lines.push(`目标数据根：${summary.target}`);
  if (summary.verifyOnly) lines.push('模式：仅校验（--verify-only）');
  if (summary.dryRun) lines.push('模式：--dry-run 未写盘');
  if (summary.movedAside) {
    lines.push(`旧数据已改名保留（未删除）：${summary.movedAside}`);
  }
  if (summary.restored) {
    lines.push(`恢复文件：${summary.restored.files} 个，${formatBytes(summary.restored.bytes)}`);
    lines.push(`恢复后配置：${summary.configRestoredPath}`);
    lines.push('请人工确认后替换正式 config.json，并重跑 node tools/upgrade.js --check。');
  }
  if (summary.problems && summary.problems.length > 0) {
    lines.push('问题：');
    for (const problem of summary.problems) lines.push(`  - ${problem}`);
  }
  if (summary.secrets) {
    lines.push(
      `秘密材料：备份只含引用（${summary.secrets.reference}，${summary.secrets.present ? '备份时已就位' : '备份时未就位'}），` +
        '未复制内容，请单独恢复。'
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function promoteStaging(stagingDir, target, replaceExisting) {
  let movedAside = null;
  if (fs.existsSync(target)) {
    const entries = fs.readdirSync(target);
    if (entries.length === 0) {
      fs.rmdirSync(target);
    } else if (replaceExisting) {
      movedAside = `${target}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.renameSync(target, movedAside);
    } else {
      throw new ToolError(
        `目标数据根非空：${target}\n默认保留数据，拒绝覆盖；如确认恢复，加 --replace-existing（旧数据会改名保留）。`,
        1
      );
    }
  }
  fs.renameSync(stagingDir, target);
  return movedAside;
}

function main(argv) {
  const { flags, values } = parseArgs(argv, {
    booleans: [
      'help',
      'dry-run',
      'json',
      'verify-only',
      'replace-existing',
      'allow-orphans',
      'allow-data-root-in-install'
    ],
    valueFlags: ['backup', 'target-data-root', 'config']
  });
  if (flags.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }

  const jsonOutput = Boolean(flags.json);
  const dryRun = Boolean(flags['dry-run']);
  const verifyOnly = Boolean(flags['verify-only']);
  const allowOrphans = Boolean(flags['allow-orphans']);

  if (!values.backup) throw new ToolError('缺少 --backup <备份目录>', 1);
  const backupDir = assertAbsolute(values.backup, '--backup');
  if (!fs.existsSync(backupDir)) throw new ToolError(`备份目录不存在：${backupDir}`, 1);

  let target = null;
  if (values['target-data-root']) {
    target = assertRestoreTarget(values['target-data-root'], {
      backupDir,
      allowInInstall: Boolean(flags['allow-data-root-in-install'])
    });
  } else if (!verifyOnly) {
    throw new ToolError('非 --verify-only 模式必须提供 --target-data-root <目录>', 1);
  }

  if (values.config) {
    const configPath = assertAbsolute(values.config, '--config');
    if (!fs.existsSync(configPath)) throw new ToolError(`参照配置不存在：${configPath}`, 1);
    const liveConfig = readJson(configPath, '参照配置');
    if (liveConfig.product !== PRODUCT) {
      throw new ToolError(`参照配置不是 PagesAI 配置：${configPath}`, 2);
    }
    validateConfigObject(liveConfig, `参照配置（${configPath}）`);
  }

  if (!dryRun && !jsonOutput) {
    process.stdout.write(`== PagesAI 恢复${verifyOnly ? '（仅校验）' : ''} ==\n备份：${backupDir}\n\n`);
  }

  let result;
  try {
    result = verifyBackup(backupDir, { allowOrphans });
  } catch (err) {
    if (err instanceof ToolError) {
      if (!jsonOutput) process.stdout.write(`\n校验中止：${err.message}\n`);
      printSummary({
        ok: false,
        dryRun,
        verifyOnly,
        backupDir,
        target,
        problems: [err.message],
        jsonOutput
      });
      return 2;
    }
    throw err;
  }

  printChecks(result, jsonOutput);

  if (result.problems.length > 0) {
    if (!jsonOutput) process.stdout.write('\n恢复校验失败：未写入任何数据，目标数据根保持原样。\n');
    printSummary({
      ok: false,
      dryRun,
      verifyOnly,
      backupDir,
      backupId: result.manifest ? result.manifest.backupId : null,
      target,
      problems: result.problems,
      secrets: result.manifest ? result.manifest.secretReference : null,
      jsonOutput
    });
    return 2;
  }

  if (result.problems.length === 0 && result.manifest) {
    const manifest = result.manifest;
    if (!jsonOutput) {
      process.stdout.write(
        `\n校验通过：${manifest.counts.files} 个文件，${formatBytes(manifest.counts.bytes)}；` +
          `用户归属、文件哈希、业务引用均一致。\n`
      );
    }
  }

  if (verifyOnly) {
    printSummary({
      ok: true,
      dryRun,
      verifyOnly,
      backupDir,
      backupId: result.manifest.backupId,
      target,
      checks: result.checks,
      problems: [],
      secrets: result.manifest.secretReference,
      jsonOutput
    });
    return 0;
  }

  const snapshot = result.snapshot;
  const checksums = result.checksums;
  if (!checksums) throw new ToolError('内部错误：备份校验未返回文件摘要', 1);
  let relocation;
  try {
    relocation = relStoragePaths(snapshot);
  } catch (err) {
    if (!jsonOutput) process.stdout.write(`\n无法重定位：${err.message}\n`);
    printSummary({
      ok: false,
      dryRun,
      verifyOnly,
      backupDir,
      backupId: result.manifest.backupId,
      target,
      problems: [err.message],
      jsonOutput
    });
    return 2;
  }

  // 目标条件检查（只读）
  if (target) {
    if (fs.existsSync(target) && !fs.lstatSync(target).isDirectory()) {
      const message = `目标路径已存在且不是目录：${target}（拒绝覆盖）`;
      if (!jsonOutput) process.stdout.write(`\n${message}\n`);
      printSummary({
        ok: false,
        dryRun,
        verifyOnly,
        backupDir,
        backupId: result.manifest.backupId,
        target,
        problems: [message],
        jsonOutput
      });
      return 1;
    }
    if (fs.existsSync(target)) {
      const entries = fs.readdirSync(target);
      if (entries.length > 0 && !flags['replace-existing']) {
        const message =
          `目标数据根非空：${target}\n默认保留数据，拒绝覆盖；如确认恢复，加 --replace-existing（旧数据改名保留）。`;
        if (!jsonOutput) process.stdout.write(`\n${message}\n`);
        printSummary({
          ok: false,
          dryRun,
          verifyOnly,
          backupDir,
          backupId: result.manifest.backupId,
          target,
          problems: [message],
          jsonOutput
        });
        return 1;
      }
      if (entries.length > 0 && fs.existsSync(path.join(target, 'state', 'deployment.json'))) {
        const marker = readJson(path.join(target, 'state', 'deployment.json'), '目标部署标记');
        if (marker.deploymentId !== result.manifest.deployment.deploymentId) {
          if (!jsonOutput) {
            process.stdout.write(
              `\n[提示] 目标数据根属于另一部署（${marker.deploymentId}），将整体改名保留后恢复。\n`
            );
          }
        }
      }
    }
  }

  const restoredStorage = {};
  for (const [key, rel] of relocation.mapping) restoredStorage[key] = path.join(target, rel);
  const restoredStateDir = path.join(target, relocation.stateRel);

  if (dryRun) {
    if (!jsonOutput) {
      process.stdout.write('\n恢复计划（--dry-run 不写盘）：\n');
      process.stdout.write(`  - 数据库快照 → ${restoredStateDir}\n`);
      for (const root of result.manifest.roots) {
        process.stdout.write(`  - ${root.regionId} → ${restoredStorage[root.configKey] || '(缺少配置键)'}\n`);
      }
      process.stdout.write('  - 生成 state/config.restored.json（不覆盖正式 config.json）\n');
    }
    printSummary({
      ok: true,
      dryRun,
      verifyOnly,
      backupDir,
      backupId: result.manifest.backupId,
      target,
      checks: result.checks,
      planned: {
        stateDir: restoredStateDir,
        storage: restoredStorage
      },
      problems: [],
      secrets: result.manifest.secretReference,
      jsonOutput
    });
    return 0;
  }

  // ---- 写入 staging，校验通过后才切换 ----
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const stagingDir = `${target}.restore-staging-${stamp}`;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o750 });
  if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: false, mode: 0o700 });

  let movedAside = null;
  try {
    const databaseCopy = copyTreeVerified(path.join(backupDir, 'database'), path.join(stagingDir, relocation.stateRel));
    const restoredRoots = [];
    for (const root of result.manifest.roots) {
      const targetRoot = path.join(stagingDir, relocation.mapping.get(root.configKey));
      const copied = copyTreeVerified(path.join(backupDir, 'data', root.regionId), targetRoot);
      restoredRoots.push({ root, targetRoot, copied });
    }

    // 更新部署标记与配置副本中的绝对路径
    const deploymentPath = path.join(stagingDir, relocation.stateRel, 'deployment.json');
    const deployment = readJson(deploymentPath, '部署标记');
    deployment.dataRoot = target;
    deployment.storage = { ...restoredStorage };
    deployment.restoredFrom = {
      backupId: result.manifest.backupId,
      dataRoot: snapshot.dataRoot,
      restoredAt: new Date().toISOString()
    };
    deployment.updatedAt = new Date().toISOString();
    writeJsonAtomic(deploymentPath, deployment, 0o600);

    const restoredConfig = JSON.parse(JSON.stringify(snapshot));
    restoredConfig.dataRoot = target;
    restoredConfig.storage = { ...restoredStorage };
    restoredConfig.database = { ...restoredConfig.database, stateDir: restoredStateDir };
    restoredConfig.updatedAt = new Date().toISOString();
    validateConfigObject(restoredConfig, '恢复后的 config.restored.json');
    const configRestoredPath = path.join(stagingDir, relocation.stateRel, 'config.restored.json');
    writeJsonAtomic(configRestoredPath, restoredConfig, 0o600);

    // ---- staging 校验：状态文件摘要 + 区域树哈希 + 用户归属 + 业务引用 ----
    const stagingProblems = [];
    const stagingState = verifyStateAgainstBackup(
      path.join(stagingDir, relocation.stateRel),
      checksums,
      target,
      result.manifest.deployment.deploymentId
    );
    stagingProblems.push(...stagingState.problems);
    const stagingIdentity = readJson(path.join(stagingDir, relocation.stateRel, 'identity.json'), '身份快照');
    const stagingUsers = Object.values(stagingIdentity.users || {});
    for (const item of restoredRoots) {
      const tree = treeHashOfDirectory(item.targetRoot);
      if (tree.treeHash !== item.root.treeHash) {
        stagingProblems.push(`staging 区域 ${item.root.regionId} 树哈希不一致`);
      }
      const ownership = checkOwnership(item.targetRoot, item.root, stagingUsers);
      if (!ownership.skipped && ownership.orphan.length > 0 && !allowOrphans) {
        stagingProblems.push(`staging 区域 ${item.root.regionId} 存在孤儿目录：${ownership.orphan.join('、')}`);
      }
      if (!restoredStorage[item.root.configKey]) {
        stagingProblems.push(`staging 区域 ${item.root.regionId} 缺少恢复后的配置键 ${item.root.configKey}`);
      }
    }

    if (stagingProblems.length > 0) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      if (!jsonOutput) process.stdout.write(`\nstaging 校验失败：\n${stagingProblems.map((p) => `  - ${p}`).join('\n')}\n`);
      printSummary({
        ok: false,
        dryRun,
        verifyOnly,
        backupDir,
        backupId: result.manifest.backupId,
        target,
        problems: stagingProblems,
        jsonOutput
      });
      return 2;
    }

    movedAside = promoteStaging(stagingDir, target, Boolean(flags['replace-existing']));
  } catch (err) {
    if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }

  // ---- 切换到目标后的最终复核 ----
  const finalProblems = [];
  const finalStateDir = path.join(target, relocation.stateRel);
  const finalState = verifyStateAgainstBackup(
    finalStateDir,
    checksums,
    target,
    result.manifest.deployment.deploymentId
  );
  finalProblems.push(...finalState.problems);
  const finalIdentity = readJson(path.join(finalStateDir, 'identity.json'), '身份快照');
  const finalUsers = Object.values(finalIdentity.users || {});
  let restoredFiles = finalState.files;
  let restoredBytes = finalState.bytes;
  for (const root of result.manifest.roots) {
    const rootDir = path.join(target, relocation.mapping.get(root.configKey));
    const tree = treeHashOfDirectory(rootDir);
    if (tree.treeHash !== root.treeHash) finalProblems.push(`恢复后区域 ${root.regionId} 树哈希不一致`);
    const ownership = checkOwnership(rootDir, root, finalUsers);
    if (!ownership.skipped && ownership.orphan.length > 0 && !allowOrphans) {
      finalProblems.push(`恢复后区域 ${root.regionId} 存在孤儿目录：${ownership.orphan.join('、')}`);
    }
    restoredFiles += tree.files;
    restoredBytes += tree.bytes;
  }

  const configRestoredPath = path.join(finalStateDir, 'config.restored.json');
  const summary = {
    ok: finalProblems.length === 0,
    dryRun,
    verifyOnly,
    backupDir,
    backupId: result.manifest.backupId,
    target,
    movedAside,
    restored: { files: restoredFiles, bytes: restoredBytes },
    configRestoredPath,
    checks: result.checks,
    problems: finalProblems,
    secrets: result.manifest.secretReference,
    jsonOutput
  };

  if (finalProblems.length > 0) {
    if (!jsonOutput) {
      process.stdout.write(`\n恢复后复核失败：\n${finalProblems.map((p) => `  - ${p}`).join('\n')}\n`);
      if (movedAside) process.stdout.write(`旧数据仍保留在：${movedAside}\n`);
    }
    printSummary(summary);
    return 2;
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
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    reportError(err);
  }
}

module.exports = { main, verifyBackup, treeHashOfDirectory, relStoragePaths, SUPPORTED_BACKUP_FORMAT };
