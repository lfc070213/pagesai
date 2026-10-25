#!/usr/bin/env node
'use strict';
/**
 * PagesAI 初始化工具（P6 运维工具）
 *
 * 方案依据：§9（安装流程）、§16.2（配置入口与部署制品）、§4.3（配置是唯一事实来源）、
 *           §5.2（邮箱注册依赖 Mail）、§6.1（数据根与文件区域）。
 *
 * 设计约束：
 *  - 只依赖 Node 内置模块与公开版 core/ 的现有实现；
 *  - 只写 config.json 与数据根下的状态/区域目录，不启动、不重启任何服务；
 *  - 数据根必须显式给出：不从环境变量、旧配置或旧平台路径推断，避免隐式复用旧根；
 *  - 邮箱注册（--registration email）必须同时安装 Mail 模块，否则拒绝初始化；
 *  - config.json 只保存路径与策略，秘密值一律走 secrets 引用，不落配置文件；
 *  - --dry-run 全程只读，不创建目录、不写文件。
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_SCHEMA_PATH = path.join(PROJECT_ROOT, 'config', 'config.schema.json');
const CORE_VALIDATE_PATH = path.join(PROJECT_ROOT, 'core', 'contracts', 'validate.js');
const CORE_REGISTRY_PATH = path.join(PROJECT_ROOT, 'core', 'storage', 'registry.js');
const CORE_JSON_STORE_PATH = path.join(PROJECT_ROOT, 'core', 'storage', 'json-store.js');

const PRODUCT = 'pagesai';
const PRODUCT_VERSION = '0.1.0';
const CONFIG_SCHEMA_VERSION = 1;
const DEFAULT_PORT = 8080;
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const MODULE_IDS = Object.freeze(['pages', 'disk', 'glim', 'mail', 'survey', 'paper']);
const DISK_VARIANTS = Object.freeze(['generic', 'pku']);
const REGISTRATION_MODES = Object.freeze(['open', 'email']);

// 容器内布局：compose 预设与镜像入口都依赖这三个固定路径（C30 / C31）。
const CONTAINER_DATA_ROOT = '/data';
const CONTAINER_INSTALL_ROOT = '/opt/pagesai';
const CONTAINER_CONFIG_PATH = '/data/config.json';

// 与其它正式组件冲突的端口：应用不能占用 MongoDB 的端口。
const RESERVED_PORTS = Object.freeze({
  27017: 'MongoDB（数据库内部端口）'
});

// 旧平台/现网数据根：公开版新部署不得原地复用（方案 §6.1、§12）。
const LEGACY_DATA_ROOTS = Object.freeze([
  '/data',
  '/home/ubuntu/glim',
  '/srv/uniflourish',
  '/opt/uniflourish',
  '/var/lib/uniflourish'
]);

// 每个业务模块的存储区域声明（物理根 = dataRoot/<defaultSubpath>）。
// 字段与 contracts/storage-region.schema.json 对齐；数据面键在通用版与北大版之间保持一致。
const LAYOUT = Object.freeze({
  pages: [
    {
      regionId: 'pages.sites',
      configKey: 'storage.pages.root',
      subpath: 'pages-data',
      ownership: { rule: 'per-user', ownerField: 'username' },
      allowedOperations: ['read', 'write', 'delete', 'rename', 'mkdir'],
      disk: { visible: true, syncable: true },
      quota: { basis: 'logical-bytes', accounting: 'per-user' }
    },
    {
      regionId: 'pages.materials',
      configKey: 'storage.pages.materials',
      subpath: 'pages-materials',
      ownership: { rule: 'per-user', ownerField: 'username' },
      allowedOperations: ['read', 'write', 'delete', 'rename', 'mkdir'],
      disk: { visible: true, syncable: true },
      quota: { basis: 'logical-bytes', accounting: 'per-user' }
    },
    {
      regionId: 'pages.backends',
      configKey: 'storage.pages.backends',
      subpath: 'pages-backends',
      ownership: { rule: 'per-user', ownerField: 'username' },
      allowedOperations: ['read', 'write', 'delete'],
      disk: { visible: false },
      quota: { basis: 'logical-bytes', accounting: 'per-user' }
    },
    {
      regionId: 'pages.ai-workspace',
      configKey: 'storage.pages.aiWorkspace',
      subpath: 'pages-ai-workspace',
      ownership: { rule: 'per-user', ownerField: 'username' },
      allowedOperations: ['read', 'write', 'delete', 'mkdir'],
      disk: { visible: false },
      quota: { basis: 'file-count', accounting: 'per-user' }
    }
  ],
  disk: [
    {
      regionId: 'disk.user-files',
      configKey: 'storage.disk.root',
      subpath: 'disk',
      ownership: { rule: 'per-user', ownerField: 'username' },
      allowedOperations: ['read', 'write', 'delete', 'rename', 'mkdir'],
      disk: { visible: true, syncable: true },
      quota: { basis: 'logical-bytes', accounting: 'per-user' }
    },
    {
      regionId: 'disk.pku-archive',
      configKey: 'storage.disk.pkuRoot',
      subpath: 'disk-pku',
      when: 'pku',
      ownership: { rule: 'per-user', ownerField: 'username' },
      allowedOperations: ['read', 'write', 'delete', 'rename', 'mkdir'],
      disk: { visible: true, syncable: true },
      quota: { basis: 'logical-bytes', accounting: 'per-user' }
    },
    {
      regionId: 'disk.upload-tmp',
      configKey: 'storage.disk.uploadTmp',
      subpath: 'disk-upload-tmp',
      ownership: { rule: 'per-user', ownerField: 'username' },
      allowedOperations: ['write', 'delete'],
      disk: { visible: false },
      quota: { basis: 'none', accounting: 'per-user' }
    },
    {
      regionId: 'disk.preview-cache',
      configKey: 'storage.disk.previewCache',
      subpath: 'disk-preview-cache',
      ownership: { rule: 'per-object', ownerField: 'identity' },
      allowedOperations: ['write', 'delete'],
      disk: { visible: false },
      quota: { basis: 'physical-bytes', accounting: 'global' }
    },
    {
      regionId: 'disk.share-registry',
      configKey: 'storage.disk.shareRegistry',
      subpath: 'disk-share-registry',
      ownership: { rule: 'global' },
      allowedOperations: ['read', 'write'],
      disk: { visible: false },
      quota: { basis: 'none', accounting: 'global' }
    }
  ],
  glim: [
    {
      regionId: 'glim.state',
      configKey: 'storage.glim.state',
      subpath: 'glim-state',
      ownership: { rule: 'per-user', ownerField: 'username' },
      allowedOperations: ['read', 'write', 'delete', 'mkdir'],
      disk: { visible: false },
      quota: { basis: 'logical-bytes', accounting: 'per-user' }
    }
  ],
  mail: [
    {
      regionId: 'mail.mailbox',
      configKey: 'storage.mail.mailbox',
      subpath: 'mail-mailbox',
      ownership: { rule: 'per-user', ownerField: 'mailbox' },
      allowedOperations: ['read'],
      disk: { visible: false },
      quota: { basis: 'physical-bytes', accounting: 'per-object' }
    }
  ],
  survey: [
    {
      regionId: 'survey.responses',
      configKey: 'storage.survey.responses',
      subpath: 'survey-responses',
      ownership: { rule: 'per-user', ownerField: 'ownerUsername' },
      allowedOperations: ['read', 'write', 'delete'],
      disk: { visible: false },
      quota: { basis: 'logical-bytes', accounting: 'per-user' }
    },
    {
      regionId: 'survey.attachments',
      configKey: 'storage.survey.attachments',
      subpath: 'survey-attachments',
      ownership: { rule: 'per-user', ownerField: 'ownerUsername' },
      allowedOperations: ['read', 'write', 'delete', 'mkdir'],
      disk: { visible: false },
      quota: { basis: 'logical-bytes', accounting: 'per-user' }
    },
    {
      regionId: 'survey.upload-tmp',
      configKey: 'storage.survey.uploadTmp',
      subpath: 'survey-upload-tmp',
      ownership: { rule: 'per-user', ownerField: 'username' },
      allowedOperations: ['write', 'delete'],
      disk: { visible: false },
      quota: { basis: 'none', accounting: 'per-user' },
      deploymentOnly: true
    }
  ],
  paper: [
    {
      regionId: 'paper.uploads',
      configKey: 'storage.paper.uploads',
      subpath: 'paper-uploads',
      ownership: { rule: 'per-user', ownerField: 'ownerUsername' },
      allowedOperations: ['read', 'write', 'delete'],
      disk: { visible: true, syncable: false },
      quota: { basis: 'logical-bytes', accounting: 'per-user' }
    }
  ]
});

// 清单只声明数据面区域；部署层为运行需要额外登记的暂存/缓存/归档区域。
// 一致性测试以此白名单判定“多出来的区域”是否被解释过，防止两套命名再次分叉。
const DEPLOYMENT_ONLY_REGIONS = Object.freeze({
  disk: Object.freeze(['disk.pku-archive', 'disk.upload-tmp', 'disk.preview-cache', 'disk.share-registry']),
  survey: Object.freeze(['survey.upload-tmp'])
});

class ToolError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'ToolError';
    this.exitCode = exitCode;
  }
}

function helpText() {
  return [
    'PagesAI 初始化（tools/init.js）',
    '',
    '用法：',
    '  node tools/init.js --data-root <绝对路径> [选项]',
    '',
    '必填：',
    '  --data-root <路径>            新的数据根（绝对路径）。不从环境变量或旧配置隐式推断。',
    '',
    '选项：',
    '  --modules <列表>              逗号分隔；all=全部六模块，core 或空=仅公共核心（默认 all）',
    '  --disk-variant generic|pku    Disk 版本（默认 generic；两版共用同一数据面）',
    '  --registration open|email     注册方式（默认 open；email 必须包含 mail 模块）',
    '  --email-domains <列表>        email 注册允许的邮箱域名（默认不限制）',
    '  --domain <域名>               对外域名（默认空：仅本地 http://127.0.0.1:<port>）',
    '  --port <端口>                 监听端口（默认 8080）',
    '  --install-root <路径>         安装根目录（默认本仓库根）',
    '  --config <路径>               配置文件路径（默认 <install-root>/config.json）',
    '  --container                   容器布局：数据根 /data、安装根 /opt/pagesai、配置 /data/config.json',
    '  --module-config <路径>        模块非秘密配置 JSON（键为模块 ID；秘密字段必须用环境变量）',
    '  --check-port                  写盘前检查监听端口是否已被占用',
    '  --adopt-data-root             数据根非空且无部署标记时，显式接管',
    '  --confirm-data-root-change    已登记数据根发生变更时显式确认（先备份）',
    '  --allow-data-root-in-install  允许数据根位于安装目录内（不推荐）',
    '  --dry-run                     只打印计划，不写盘',
    '  --json                        机器可读输出',
    '  --help                        显示本帮助',
    '',
    '说明：',
    '  --container 只允许在镜像内实际写盘（存在 /.dockerenv 或 PAGESAI_CONTAINER=1）；',
    '  在宿主上演练请加 --dry-run，避免向宿主的 /data 写入。',
    '  --port 27017 会与 MongoDB 冲突，始终拒绝。',
    '',
    '示例：',
    '  node tools/init.js --data-root /srv/pagesai-data --modules all \\',
    '    --disk-variant generic --registration open --domain example.com --port 8080 --dry-run',
    '  node tools/init.js --container --modules pages,mail --dry-run',
    '',
    '退出码：0 成功；1 参数/环境错误；2 配置冲突或契约校验失败（需人工处理）。'
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
    if (!arg.startsWith('--')) {
      throw new ToolError(`无法识别的参数：${arg}（用 --help 查看用法）`, 1);
    }
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

function assertAbsolute(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new ToolError(`${label} 不能为空`, 1);
  if (!path.isAbsolute(value)) throw new ToolError(`${label} 必须是绝对路径：${value}`, 1);
  return path.resolve(value);
}

/** 数据根安全校验：拒绝根目录、主目录、旧平台根与安装目录内部。 */
function assertDataRoot(dataRootValue, { installRoot, allowInInstall, container = false }) {
  const resolved = assertAbsolute(dataRootValue, '--data-root');
  if (resolved === path.parse(resolved).root) throw new ToolError('数据根不能是文件系统根目录', 1);
  if (resolved === path.resolve(os.homedir())) throw new ToolError('数据根不能是用户主目录', 1);
  if (container && resolved !== CONTAINER_DATA_ROOT) {
    throw new ToolError(`--container 模式的数据根必须是 ${CONTAINER_DATA_ROOT}：${resolved}`, 1);
  }
  // 容器内的 /data 是卷挂载点，不是旧平台根；只有 --container 才放行这一条。
  for (const legacy of LEGACY_DATA_ROOTS) {
    if (container && legacy === CONTAINER_DATA_ROOT) continue;
    if (isInside(legacy, resolved)) {
      throw new ToolError(
        `数据根位于旧平台/现网根 ${legacy} 之下：${resolved}\n` +
          '公开版新部署不得隐式复用旧根（方案 §6.1）；请改用独立数据根。',
        2
      );
    }
  }
  if (!allowInInstall && isInside(installRoot, resolved)) {
    throw new ToolError(
      `数据根不得位于安装目录内：${resolved}\n` +
        '源码更新或重新发布可能连带删除数据；如确需如此，加 --allow-data-root-in-install。',
      1
    );
  }
  return resolved;
}

function normalizeModules(raw) {
  if (raw === undefined || raw === null || raw === '') return MODULE_IDS.slice();
  const text = String(raw).trim().toLowerCase();
  if (text === 'all') return MODULE_IDS.slice();
  if (text === 'core' || text === 'none') return [];
  const items = text.split(/[,\s]+/).filter(Boolean);
  const unknown = items.filter((id) => !MODULE_IDS.includes(id));
  if (unknown.length > 0) {
    throw new ToolError(`未知模块：${unknown.join('、')}（可选：${MODULE_IDS.join('、')}，或 all / core）`, 1);
  }
  return MODULE_IDS.filter((id) => items.includes(id));
}

function normalizeEmailDomains(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  const items = String(raw).toLowerCase().split(/[,\s]+/).filter(Boolean);
  const domains = [];
  for (const item of items) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(item)) {
      throw new ToolError(`邮箱域名格式不正确：${item}`, 1);
    }
    if (!domains.includes(item)) domains.push(item);
  }
  return domains;
}

function normalizeDomain(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = String(raw).trim().toLowerCase();
  if (value.includes('/') || value.includes(':') || value.includes(' ')) {
    throw new ToolError(`--domain 只能写域名本身，不要带协议、端口或路径：${raw}`, 1);
  }
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)) {
    throw new ToolError(`域名格式不正确：${raw}（示例占位：example.com）`, 1);
  }
  return value;
}

function normalizePort(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PORT;
  if (!/^\d+$/.test(String(raw))) throw new ToolError(`--port 必须是整数：${raw}`, 1);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ToolError(`--port 超出范围（1-65535）：${raw}`, 1);
  }
  if (RESERVED_PORTS[port]) {
    throw new ToolError(`--port ${port} 与 ${RESERVED_PORTS[port]} 冲突，请换一个端口`, 2);
  }
  return port;
}

/** 实际占用检查（显式 --check-port 才执行，避免升级时误判正在运行的服务）。 */
function assertPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        reject(new ToolError(`端口 ${port} 已被占用；请换端口或停止占用进程后再初始化`, 2));
        return;
      }
      reject(new ToolError(`无法检查端口 ${port}：${err && err.message ? err.message : '未知错误'}`, 1));
    });
    server.listen({ port, host: '0.0.0.0', exclusive: true }, () => {
      server.close(() => resolve(port));
    });
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function moduleDirectory(moduleId, installRoot) {
  const inInstall = path.join(installRoot, 'modules', moduleId);
  if (fs.existsSync(inInstall)) return inInstall;
  // 宿主上演练 --container 时安装根 /opt/pagesai 不存在，退回源码树。
  return path.join(PROJECT_ROOT, 'modules', moduleId);
}

function pointerValue(object, pointer) {
  const parts = String(pointer).split('/').filter(Boolean);
  let current = object;
  for (const part of parts) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, part)) return { found: false };
    current = current[part];
  }
  return { found: true, value: current };
}

/**
 * 读取并校验模块非秘密配置（C31）。
 *  - 键必须是本次已安装模块；
 *  - 必须通过模块 config.schema.json；
 *  - 清单声明为秘密的字段（例如 Glim chatAdapter.apiKey）一律拒绝写入 config.json。
 */
function readModuleConfig(file, modules, installRoot) {
  return validateModuleConfig(readJson(file, '--module-config'), modules, installRoot);
}

/** 校验模块非秘密配置对象（默认值合并后也要走同一条校验）。 */
function validateModuleConfig(value, modules, installRoot) {
  if (!isPlainObject(value)) throw new ToolError('--module-config 必须是 JSON 对象（键为模块 ID）', 1);
  const unknown = Object.keys(value).filter((id) => !modules.includes(id));
  if (unknown.length > 0) {
    throw new ToolError(`--module-config 包含未安装模块：${unknown.join('、')}`, 1);
  }
  const { validate } = require(CORE_VALIDATE_PATH);
  for (const moduleId of Object.keys(value)) {
    const moduleConfig = value[moduleId];
    if (!isPlainObject(moduleConfig)) {
      throw new ToolError(`--module-config.${moduleId} 必须是 JSON 对象`, 1);
    }
    const dir = moduleDirectory(moduleId, installRoot);
    const schemaPath = path.join(dir, 'config.schema.json');
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(schemaPath) || !fs.existsSync(manifestPath)) {
      throw new ToolError(`模块 ${moduleId} 缺少 config.schema.json 或 manifest.json`, 2);
    }
    const schema = readJson(schemaPath, `模块 ${moduleId} 配置 schema`);
    const result = validate(schema, moduleConfig);
    if (!result.valid) {
      const lines = result.errors.map((item) => `  - ${item.path}: ${item.message}`);
      throw new ToolError(`--module-config.${moduleId} 不符合模块配置 schema：\n${lines.join('\n')}`, 2);
    }
    const manifest = readJson(manifestPath, `模块 ${moduleId} 清单`);
    for (const pointer of (manifest.config && manifest.config.secrets) || []) {
      if (pointerValue(moduleConfig, pointer).found) {
        throw new ToolError(
          `--module-config.${moduleId} 不能包含秘密字段 ${pointer}；` +
            '秘密只能由部署环境变量注入，config.json 只保存引用',
          1
        );
      }
    }
  }
  return value;
}

function buildRegions(modules, diskVariant, dataRoot) {
  const regions = [];
  const storage = {};
  for (const moduleId of modules) {
    for (const item of LAYOUT[moduleId]) {
      if (item.when === 'pku' && diskVariant !== 'pku') continue;
      if (storage[item.configKey] !== undefined) {
        throw new ToolError(`存储配置键重复：${item.configKey}`, 1);
      }
      const declaration = {
        regionId: item.regionId,
        module: moduleId,
        physicalRoot: {
          configKey: item.configKey,
          defaultSubpath: item.subpath,
          allowImplicitChange: false
        },
        ownership: { ...item.ownership },
        allowedOperations: item.allowedOperations.slice(),
        disk: { ...item.disk }
      };
      if (item.quota) declaration.quota = { ...item.quota };
      regions.push(declaration);
      storage[item.configKey] = path.join(dataRoot, item.subpath);
    }
  }
  regions.sort((a, b) => a.regionId.localeCompare(b.regionId, 'en'));
  const orderedStorage = {};
  for (const key of Object.keys(storage).sort()) orderedStorage[key] = storage[key];
  return { regions, storage: orderedStorage };
}

/**
 * 新部署的模块持久化默认值（C31）：全部落在已登记的存储区域里，
 * 使未显式提供 --module-config 的容器部署也不是纯内存运行。
 * 显式 --module-config 仍逐字段覆盖这些默认值。
 */
function buildModuleConfigDefaults(modules, storage, dataRoot) {
  const defaults = {};
  const under = (configKey, ...parts) => path.join(storage[configKey], ...parts);
  for (const moduleId of modules) {
    if (moduleId === 'pages') {
      defaults.pages = {
        dataFile: under('storage.pages.root', 'pages.json'),
        taskRuntimeRoot: path.join(dataRoot, 'pages-task-runtime'),
        backendRuntimeRoot: path.join(dataRoot, 'pages-backend-runtime')
      };
    } else if (moduleId === 'disk') {
      defaults.disk = { dataFile: under('storage.disk.root', 'disk.json') };
    } else if (moduleId === 'glim') {
      defaults.glim = {
        dataFile: under('storage.glim.state', 'glim.json'),
        workspaceRoot: under('storage.glim.state', 'workspaces')
      };
    } else if (moduleId === 'mail') {
      defaults.mail = { dataFile: under('storage.mail.mailbox', 'mail.json') };
    } else if (moduleId === 'survey') {
      defaults.survey = {
        dataFile: under('storage.survey.responses', 'survey.json'),
        attachmentsDir: storage['storage.survey.attachments']
      };
    } else if (moduleId === 'paper') {
      defaults.paper = {
        dataFile: under('storage.paper.uploads', 'paper.json'),
        uploadsDir: under('storage.paper.uploads', 'uploads')
      };
    }
  }
  return defaults;
}

/** 逐模块浅合并：显式值覆盖默认值；未安装模块不会从默认值里冒出来。 */
function mergeModuleConfig(defaults, explicit, modules) {
  const merged = {};
  for (const moduleId of modules) {
    const base = defaults[moduleId] || {};
    const override = (explicit && explicit[moduleId]) || {};
    const value = { ...base, ...override };
    if (Object.keys(value).length > 0) merged[moduleId] = value;
  }
  return merged;
}

function buildConfig(context) {
  const {
    modules,
    diskVariant,
    registrationMode,
    allowedEmailDomains,
    domain,
    port,
    installRoot,
    dataRoot,
    deploymentId,
    createdAt,
    now,
    container,
    moduleConfig
  } = context;
  const { regions, storage } = buildRegions(modules, diskVariant, dataRoot);
  const effectiveModuleConfig = mergeModuleConfig(
    buildModuleConfigDefaults(modules, storage, dataRoot),
    moduleConfig,
    modules
  );
  const publicBaseUrl = domain ? `https://${domain}` : `http://127.0.0.1:${port}`;
  const connections = modules.includes('glim')
    ? ['pages', 'disk', 'mail', 'survey', 'paper']
        .filter((id) => modules.includes(id))
        .map((moduleId) => ({ module: moduleId, status: 'unconfigured' }))
    : [];
  const secrets = container
    ? {
        mode: 'env',
        reference: 'container-environment',
        keys: ['PAGESAI_BOOTSTRAP_TOKEN', 'PAGESAI_MONGO_PASSWORD'],
        note: '由 Compose/部署环境注入；不写入镜像、compose 文件或 config.json。'
      }
    : {
        mode: 'env-file',
        reference: path.join('secrets', 'pagesai.env'),
        keys: ['PAGESAI_BOOTSTRAP_TOKEN'],
        note: '只登记引用，不保存秘密值；秘密材料独立保护，不进入备份正文。'
      };
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    product: PRODUCT,
    productVersion: PRODUCT_VERSION,
    deploymentId,
    createdAt,
    updatedAt: now,
    installRoot,
    dataRoot,
    domain,
    port,
    publicBaseUrl,
    modules: modules.slice(),
    coreCompatibility: '^1.0.0',
    disk: {
      variant: diskVariant,
      dataPlane: 'shared',
      pkuArchive: diskVariant === 'pku'
    },
    registration: {
      mode: registrationMode,
      enabled: true,
      requireEmailVerification: registrationMode === 'email',
      allowedEmailDomains
    },
    sessionTtlMs: SESSION_TTL_MS,
    storage,
    regions,
    database: {
      engine: 'mongodb',
      name: 'pagesai',
      initialize: true,
      stateDir: path.join(dataRoot, 'state'),
      snapshotNote: '身份、会话与文件元数据以 MongoDB 为准；stateDir 仅保存部署标记和运维台账。'
    },
    secrets,
    moduleConfig: effectiveModuleConfig,
    glim: { connections }
  };
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

function ensureIdentitySnapshot(stateDir, now) {
  const file = path.join(stateDir, 'identity.json');
  if (fs.existsSync(file)) return { file, created: false };
  const { JsonStore } = require(CORE_JSON_STORE_PATH);
  const store = new JsonStore({
    filePath: file,
    initial: {
      users: {},
      sessions: {},
      verifications: {},
      meta: {
        createdAt: now,
        note: '身份导出快照；MongoDB 为权威，服务在启动与每次身份变更时重写本文件。'
      }
    }
  });
  store.save();
  return { file, created: true };
}

function ensureLedger(stateDir, now) {
  const file = path.join(stateDir, 'migrations.json');
  if (fs.existsSync(file)) return { file, created: false };
  writeJsonAtomic(file, { formatVersion: 1, updatedAt: now, applied: [] }, 0o600);
  return { file, created: true };
}

function assertNoStorageOverlap(storage) {
  const entries = Object.keys(storage).map((key) => ({ key, dir: storage[key] }));
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i];
      const b = entries[j];
      if (isInside(a.dir, b.dir) || isInside(b.dir, a.dir)) {
        throw new ToolError(`存储区域路径重叠：${a.key} 与 ${b.key}`, 2);
      }
    }
  }
}

/** 数据根下未被当前配置登记的顶层内容：只提示、绝不删除。 */
function findUnregisteredEntries(config) {
  if (!fs.existsSync(config.dataRoot)) return [];
  const known = new Set(['state']);
  for (const value of Object.values(config.storage)) {
    const rel = path.relative(config.dataRoot, path.resolve(value));
    if (rel && rel !== '..' && !rel.startsWith(`..${path.sep}`)) known.add(rel.split(path.sep)[0]);
  }
  return fs
    .readdirSync(config.dataRoot)
    .filter((name) => name !== '.DS_Store' && !known.has(name))
    .sort();
}

function uniqueDirs(dirs) {
  const seen = new Set();
  const result = [];
  for (const dir of dirs) {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result.sort((a, b) => a.length - b.length || a.localeCompare(b, 'en'));
}

function formatModuleList(modules) {
  return modules.length === 0 ? '仅公共核心' : modules.join('、');
}

function buildSummary(context) {
  const { config, configPath, dryRun, plannedDirs, writes } = context;
  return {
    ok: true,
    dryRun,
    wrote: writes.length > 0,
    configPath,
    installRoot: config.installRoot,
    dataRoot: config.dataRoot,
    deploymentId: config.deploymentId,
    modules: config.modules,
    diskVariant: config.disk.variant,
    registrationMode: config.registration.mode,
    allowedEmailDomains: config.registration.allowedEmailDomains,
    domain: config.domain,
    port: config.port,
    publicBaseUrl: config.publicBaseUrl,
    glimConnections: config.glim.connections,
    container: Boolean(context.container),
    moduleConfigModules: Object.keys(config.moduleConfig || {}),
    secretsMode: config.secrets.mode,
    secretsReference: config.secrets.reference,
    plannedDirs,
    unregisteredEntries: findUnregisteredEntries(config),
    dataRootInsideInstall: isInside(config.installRoot, config.dataRoot),
    writes
  };
}

function printSummary(summary) {
  if (summary.jsonOutput) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  const lines = [];
  lines.push(summary.dryRun ? 'PagesAI 初始化计划（--dry-run：未写盘）' : 'PagesAI 初始化完成');
  lines.push('');
  lines.push(`配置路径：${summary.configPath}`);
  lines.push(`安装根：${summary.installRoot}`);
  lines.push(`数据根：${summary.dataRoot}`);
  if (summary.container) lines.push('布局：容器（数据根 /data，安装根 /opt/pagesai，配置 /data/config.json）');
  lines.push(`部署标识：${summary.deploymentId}`);
  lines.push(`模块：${formatModuleList(summary.modules)}`);
  lines.push(
    summary.diskVariant === 'pku'
      ? 'Disk 版本：pku（北大版，与通用版共用同一数据面）'
      : 'Disk 版本：generic（通用版，与北大版共用同一数据面）'
  );
  lines.push(
    summary.registrationMode === 'email'
      ? '注册方式：email（邮箱验证码；依赖 Mail 模块）'
      : '注册方式：open（用户名 + 密码）'
  );
  lines.push(
    `邮箱域名白名单：${summary.allowedEmailDomains.length ? summary.allowedEmailDomains.join('、') : '不限制'}`
  );
  lines.push(
    `模块配置：${summary.moduleConfigModules.length ? summary.moduleConfigModules.join('、') : '无（仅默认值）'}`
  );
  lines.push(`监听端口：${summary.port}`);
  lines.push(`访问地址：${summary.publicBaseUrl}`);
  lines.push(`健康检查：${summary.publicBaseUrl}/healthz`);
  lines.push(
    `管理员引导：POST ${summary.publicBaseUrl}/api/admin/bootstrap` +
      '（令牌取自环境变量 PAGESAI_BOOTSTRAP_TOKEN，不写入 config.json）'
  );
  lines.push(
    summary.secretsMode === 'env'
      ? '秘密材料：由容器环境变量注入（不写入镜像、compose 或 config.json）'
      : `秘密材料引用：${summary.secretsReference}（仅登记引用，不保存秘密值）`
  );
  lines.push('');
  if (summary.glimConnections.length === 0) {
    lines.push('Glim 连接状态（占位）：未安装 Glim，无连接');
  } else {
    lines.push('Glim 连接状态（占位）：');
    for (const connection of summary.glimConnections) {
      lines.push(`  - ${connection.module}：未配置（占位，待授权后变为 connected）`);
    }
  }
  if (summary.dataRootInsideInstall) {
    lines.push('[提示] 数据根位于安装目录内（--allow-data-root-in-install），重新发布可能影响数据。');
  }
  if (summary.unregisteredEntries.length > 0) {
    lines.push(
      `[提示] 数据根下存在未登记的顶层内容（已保留，不会自动删除）：${summary.unregisteredEntries.join('、')}`
    );
  }
  lines.push('');
  lines.push(`${summary.dryRun ? '将创建目录' : '已创建目录'}（${summary.plannedDirs.length}）：`);
  for (const dir of summary.plannedDirs) lines.push(`  - ${dir}`);
  lines.push('');
  if (summary.dryRun) {
    lines.push('将写入：config.json、state/deployment.json、state/identity.json、state/migrations.json');
    lines.push('（--dry-run 未创建任何文件或目录。）');
  } else {
    lines.push('已写入：');
    for (const item of summary.writes) lines.push(`  - ${item}`);
  }
  lines.push('');
  lines.push('后续步骤：');
  lines.push('  1. 配置 Mail 发信（仅 email 注册需要），把秘密写入 secrets/pagesai.env');
  lines.push('  2. node tools/upgrade.js --check   # 校验并补齐迁移');
  lines.push('  3. node tools/backup.js            # 建立首份可验证备份');
  lines.push('  4. 按 docs 部署参考启动服务（本工具不启停服务）');
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main(argv) {
  const { flags, values } = parseArgs(argv, {
    booleans: [
      'help',
      'dry-run',
      'json',
      'container',
      'check-port',
      'adopt-data-root',
      'confirm-data-root-change',
      'allow-data-root-in-install'
    ],
    valueFlags: [
      'modules',
      'disk-variant',
      'registration',
      'email-domains',
      'data-root',
      'domain',
      'port',
      'install-root',
      'config',
      'module-config'
    ]
  });

  if (flags.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }

  const jsonOutput = Boolean(flags.json);
  const dryRun = Boolean(flags['dry-run']);
  const container = Boolean(flags.container);

  let installRoot;
  if (container) {
    const requested = values['install-root'] ? assertAbsolute(values['install-root'], '--install-root') : CONTAINER_INSTALL_ROOT;
    if (requested !== CONTAINER_INSTALL_ROOT) {
      throw new ToolError(`--container 模式的安装根必须是 ${CONTAINER_INSTALL_ROOT}：${requested}`, 1);
    }
    if (!dryRun && !fs.existsSync('/.dockerenv') && process.env.PAGESAI_CONTAINER !== '1') {
      throw new ToolError(
        '--container 非 --dry-run 只允许在容器内执行（需要 /.dockerenv 或 PAGESAI_CONTAINER=1）。\n' +
          '在宿主上演练请加 --dry-run，避免向宿主的 /data 写入。',
        1
      );
    }
    installRoot = CONTAINER_INSTALL_ROOT;
  } else {
    installRoot = assertAbsolute(values['install-root'] || PROJECT_ROOT, '--install-root');
    if (!fs.existsSync(installRoot)) throw new ToolError(`安装根不存在：${installRoot}`, 1);
  }

  if (!values['data-root'] && !container) {
    throw new ToolError(
      '缺少 --data-root。\n数据根必须显式给出，不从环境变量或旧部署隐式推断（方案 §6.1）。\n' +
        '示例：node tools/init.js --data-root /srv/pagesai-data --modules all',
      1
    );
  }
  const dataRoot = assertDataRoot(values['data-root'] || CONTAINER_DATA_ROOT, {
    installRoot,
    allowInInstall: Boolean(flags['allow-data-root-in-install']),
    container
  });

  const modules = normalizeModules(values.modules);
  const diskVariant = String(values['disk-variant'] || 'generic').toLowerCase();
  if (!DISK_VARIANTS.includes(diskVariant)) {
    throw new ToolError(`--disk-variant 只能是 ${DISK_VARIANTS.join('|')}`, 1);
  }
  const registrationMode = String(values.registration || 'open').toLowerCase();
  if (!REGISTRATION_MODES.includes(registrationMode)) {
    throw new ToolError(`--registration 只能是 ${REGISTRATION_MODES.join('|')}`, 1);
  }
  if (registrationMode === 'email' && !modules.includes('mail')) {
    throw new ToolError(
      '邮箱注册（--registration email）必须安装 Mail 模块。\n' +
        '方案 §5.2 要求：不能用一个外部 SMTP 绕过 Mail 模块。请加 --modules ...,mail 或改用 --registration open。',
      1
    );
  }

  const domain = normalizeDomain(values.domain);
  const port = normalizePort(values.port);
  const allowedEmailDomains = normalizeEmailDomains(values['email-domains']);
  const configPath = assertAbsolute(
    values.config || process.env.PAGESAI_CONFIG || path.join(installRoot, 'config.json'),
    '--config'
  );

  // ---- 读取既有配置与部署标记，避免隐式换根/覆盖别的部署 ----
  const existing = fs.existsSync(configPath)
    ? validateConfigObject(readJson(configPath, '既有 config.json'), `既有 config.json（${configPath}）`)
    : null;
  if (existing && existing.product !== PRODUCT) {
    throw new ToolError(`既有配置文件不是 PagesAI 的配置：${configPath}`, 2);
  }

  const markerPath = path.join(dataRoot, 'state', 'deployment.json');
  const marker = fs.existsSync(markerPath) ? readJson(markerPath, '部署标记') : null;
  if (marker && marker.product !== PRODUCT) {
    throw new ToolError(`数据根内的部署标记不属于 PagesAI：${markerPath}`, 2);
  }
  if (existing && marker && marker.deploymentId !== existing.deploymentId) {
    throw new ToolError(
      `配置文件与数据根部署标记不属于同一部署：\n` +
        `  config: ${existing.deploymentId}\n  marker: ${marker.deploymentId}\n拒绝覆盖。`,
      2
    );
  }
  if (marker && path.resolve(marker.dataRoot) !== dataRoot) {
    throw new ToolError(
      `数据根内部署标记记录的根目录是 ${marker.dataRoot}，与本次 ${dataRoot} 不一致；拒绝继续。`,
      2
    );
  }
  if (existing && existing.dataRoot !== dataRoot && !flags['confirm-data-root-change']) {
    throw new ToolError(
      `检测到已登记数据根：${existing.dataRoot}\n本次请求：${dataRoot}\n` +
        '初始化与升级不得隐式改变数据根（方案 §6.1）。请先备份数据，确认迁移后加 --confirm-data-root-change。',
      2
    );
  }

  if (fs.existsSync(dataRoot)) {
    const entries = fs.readdirSync(dataRoot).filter((name) => name !== '.DS_Store');
    if (entries.length > 0 && !marker && !flags['adopt-data-root']) {
      throw new ToolError(
        `数据根已存在且非空，但没有 PagesAI 部署标记：${dataRoot}\n` +
          `目录内现有：${entries.slice(0, 10).join('、')}${entries.length > 10 ? ' 等' : ''}\n` +
          '为避免隐式复用旧根，拒绝继续；确认接管请加 --adopt-data-root。',
        2
      );
    }
  }

  const deploymentId = existing
    ? existing.deploymentId
    : marker
      ? marker.deploymentId
      : crypto.randomUUID();
  const createdAt = existing ? existing.createdAt : marker ? marker.createdAt : new Date().toISOString();
  const now = new Date().toISOString();

  // 升级时没有 --module-config 就沿用既有模块配置，避免默认值覆盖部署者的显式选择。
  const requestedModuleConfig = values['module-config']
    ? readModuleConfig(values['module-config'], modules, installRoot)
    : (existing && isPlainObject(existing.moduleConfig) ? existing.moduleConfig : {});

  const config = buildConfig({
    modules,
    diskVariant,
    registrationMode,
    allowedEmailDomains,
    domain,
    port,
    installRoot,
    dataRoot,
    deploymentId,
    createdAt,
    now,
    container,
    moduleConfig: requestedModuleConfig
  });
  validateConfigObject(config, `生成的 config.json（${configPath}）`);
  validateModuleConfig(config.moduleConfig, modules, installRoot);
  assertNoStorageOverlap(config.storage);

  const plannedDirs = uniqueDirs([
    dataRoot,
    config.database.stateDir,
    ...Object.values(config.storage)
  ]);

  if (dryRun) {
    const summary = buildSummary({ config, configPath, dryRun, plannedDirs, writes: [], container });
    summary.jsonOutput = jsonOutput;
    printSummary(summary);
    return 0;
  }

  const writes = [];
  for (const dir of plannedDirs) fs.mkdirSync(dir, { recursive: true, mode: 0o750 });

  writeJsonAtomic(
    path.join(config.database.stateDir, 'deployment.json'),
    buildMarker(config, configPath, now),
    0o600
  );
  writes.push(path.join(config.database.stateDir, 'deployment.json'));

  const identity = ensureIdentitySnapshot(config.database.stateDir, now);
  if (identity.created) writes.push(identity.file);

  const ledger = ensureLedger(config.database.stateDir, now);
  if (ledger.created) writes.push(ledger.file);

  writeJsonAtomic(configPath, config, 0o600);
  writes.push(configPath);

  const summary = buildSummary({ config, configPath, dryRun, plannedDirs, writes, container });
  summary.jsonOutput = jsonOutput;
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
    main(process.argv.slice(2));
  } catch (err) {
    reportError(err);
  }
}

module.exports = {
  main,
  parseArgs,
  buildConfig,
  buildRegions,
  buildModuleConfigDefaults,
  mergeModuleConfig,
  readModuleConfig,
  validateModuleConfig,
  assertDataRoot,
  validateConfigObject,
  LAYOUT,
  DEPLOYMENT_ONLY_REGIONS
};
