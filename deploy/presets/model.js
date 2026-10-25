#!/usr/bin/env node
'use strict';
// PagesAI Compose 预设的唯一模型与渲染器（C30 / C31）。
//
// 设计约束：
//  - 一个 Node 进程承载公共核心与所选模块；Glim、Disk 不是独立 Python 服务，
//    因此预设的业务服务只有 app，MongoDB 是唯一外部依赖；
//  - 对外只有 gateway 一个入口：gateway 发布宿主机端口并流式转发到 app，
//    app 不直接发布端口，避免绕过网关直连；
//  - 正式启动必须使用 MongoDB，core-only 也同样启动 mongo；
//  - 端口、数据根、安装根、模块列表、Disk 版本与注册方式全部来自 config.json；
//    预设把同一组值也写进 init 命令与环境变量，由 tools/init.js 生成配置、
//    deploy/docker/entrypoints/app.js 启动时逐项核对，不一致即拒绝启动；
//  - 不写账号、口令、真实域名或镜像 digest；秘密一律由 Compose 变量注入；
//  - pku 与 generic 共用同一数据面与服务集合，差异只有 init 生成的
//    disk.pkuArchive 区域与 disk.variant 值（C19 编译期策略在同步客户端，
//    不在服务端增加第二个进程）。
//
// 用法：
//   node deploy/presets/model.js --write      重新生成 deploy/presets/*.yml
//   node deploy/presets/model.js --print NAME 输出单个预设
//   node deploy/presets/model.js --list       列出预设
//   node deploy/presets/model.js --help

const fs = require('node:fs');
const path = require('node:path');

const MODEL_VERSION = 2;
const MODULE_IDS = Object.freeze(['pages', 'disk', 'glim', 'mail', 'survey', 'paper']);
const DISK_VARIANTS = Object.freeze(['generic', 'pku']);
const REGISTRATION_MODES = Object.freeze(['open', 'email']);

// 预设与模块集合一一对应；full-pku 只改变 Disk 版本与注册方式，
// 不改变服务、镜像或数据卷。
const PRESETS = Object.freeze({
  'core-only.yml': [],
  'single-pages.yml': ['pages'],
  'single-disk.yml': ['disk'],
  'single-glim.yml': ['glim'],
  'single-mail.yml': ['mail'],
  'single-survey.yml': ['survey'],
  'single-paper.yml': ['paper'],
  'pages-disk.yml': ['pages', 'disk'],
  'survey-disk.yml': ['survey', 'disk'],
  'paper-disk.yml': ['paper', 'disk'],
  'full-generic.yml': ['pages', 'disk', 'glim', 'mail', 'survey', 'paper'],
  'full-pku.yml': ['pages', 'disk', 'glim', 'mail', 'survey', 'paper']
});

// 每个预设的部署选择。未列出的字段使用 DEFAULTS。
const PRESET_OPTIONS = Object.freeze({
  'full-pku.yml': Object.freeze({ diskVariant: 'pku', registration: 'email' })
});

const DEFAULTS = Object.freeze({
  projectName: 'pagesai',
  hostPort: 8080,
  containerPort: 8080,
  dataRoot: '/data',
  installRoot: '/opt/pagesai',
  configFileName: 'config.json',
  databaseName: 'pagesai',
  appImage: 'pagesai/app:local',
  gatewayImage: 'pagesai/gateway:local',
  mongoImage: 'pagesai/mongo:local',
  buildContext: '../..',
  appDockerfile: 'deploy/docker/Dockerfile.app',
  gatewayDockerfile: 'deploy/docker/Dockerfile.gateway',
  mongoUserDefault: 'pagesai',
  diskVariant: 'generic',
  registration: 'open',
  domain: null,
  emailDomains: Object.freeze([])
});

// 宿主机映射到 MongoDB 内部端口会造成不可解释的冲突，直接拒绝。
const RESERVED_PORTS = Object.freeze({
  27017: 'MongoDB'
});

const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

class ModelError extends Error {
  constructor(message, code = 'MODEL_INVALID') {
    super(message);
    this.name = 'ModelError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new ModelError(message, code);
}

function assertModules(modules) {
  if (!Array.isArray(modules)) fail('modules 必须是数组');
  const seen = new Set();
  for (const id of modules) {
    if (!MODULE_IDS.includes(id)) fail(`未知模块：${id}（可选：${MODULE_IDS.join('、')}）`);
    if (seen.has(id)) fail(`模块重复：${id}`);
    seen.add(id);
  }
  return MODULE_IDS.filter((id) => seen.has(id));
}

function modulesText(modules) {
  return modules.length === 0 ? '' : modules.join(',');
}

function assertPort(port, label) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`${label} 必须是 1-65535 的整数：${port}`);
  if (RESERVED_PORTS[port]) fail(`${label} ${port} 与 ${RESERVED_PORTS[port]} 冲突`);
  return port;
}

function assertAbsolute(value, label) {
  if (typeof value !== 'string' || !value.startsWith('/')) fail(`${label} 必须是绝对路径：${value}`);
  return value;
}

function assertHostname(value, label) {
  if (typeof value !== 'string' || !HOSTNAME_PATTERN.test(value)) {
    fail(`${label} 必须是裸主机名（不带协议、端口或路径）：${value}`);
  }
  return value;
}

/**
 * 模块组合的静态规则：
 *  - email 注册必须有 Mail（方案 §5.2）；
 *  - pku Disk 版本必须有 Disk（否则 pkuArchive 区域没有归属模块）；
 *  - generic 与 pku 共用同一数据面，不生成第二套卷。
 */
function validateCombination({ modules, registration = 'open', diskVariant = 'generic' }) {
  const ordered = assertModules(modules);
  if (!REGISTRATION_MODES.includes(registration)) fail(`未知注册方式：${registration}`);
  if (!DISK_VARIANTS.includes(diskVariant)) fail(`未知 Disk 版本：${diskVariant}`);
  if (registration === 'email' && !ordered.includes('mail')) {
    fail('邮箱注册必须安装 mail 模块（不能用一个外部 SMTP 绕过 Mail 模块）');
  }
  if (diskVariant === 'pku' && !ordered.includes('disk')) {
    fail('北大版 Disk（diskVariant=pku）必须安装 disk 模块');
  }
  return { modules: ordered, registration, diskVariant };
}

/** 生成 Compose 模型（纯数据，供渲染与测试复用）。 */
function buildModel(input = {}) {
  const options = { ...DEFAULTS, ...input };
  const { modules, registration, diskVariant } = validateCombination({
    modules: options.modules || [],
    registration: options.registration,
    diskVariant: options.diskVariant
  });
  const hostPort = assertPort(Number(options.hostPort), 'hostPort');
  const containerPort = assertPort(Number(options.containerPort), 'containerPort');
  const dataRoot = assertAbsolute(options.dataRoot, 'dataRoot');
  const installRoot = assertAbsolute(options.installRoot, 'installRoot');
  const configPath = options.configPath || `${dataRoot}/${options.configFileName}`;
  assertAbsolute(configPath, 'configPath');
  if (!configPath.startsWith(`${dataRoot.replace(/\/+$/, '')}/`)) {
    fail(`configPath 必须位于数据根内：${configPath}`);
  }
  if (typeof options.databaseName !== 'string' || !/^[A-Za-z0-9_-]+$/.test(options.databaseName)) {
    fail(`databaseName 非法：${options.databaseName}`);
  }
  const databaseName = options.databaseName;
  for (const key of ['appImage', 'gatewayImage', 'mongoImage', 'buildContext']) {
    if (typeof options[key] !== 'string' || options[key].trim() === '') fail(`${key} 不能为空`);
  }
  const domain = options.domain === null || options.domain === undefined
    ? null
    : assertHostname(options.domain, 'domain');
  const emailDomains = (options.emailDomains || []).map((item) => assertHostname(item, 'emailDomains[]'));

  const moduleList = modulesText(modules);
  const initModules = moduleList === '' ? 'core' : moduleList;
  const healthcheck = {
    test: ['CMD', 'node', 'deploy/docker/healthcheck.js'],
    interval: '15s',
    timeout: '5s',
    retries: 5,
    start_period: '30s'
  };
  const gatewayHealthcheck = {
    test: ['CMD', 'node', 'deploy/docker/gateway-healthcheck.js'],
    interval: '15s',
    timeout: '5s',
    retries: 5,
    start_period: '20s'
  };

  const initCommand = [
    '--container',
    '--data-root', dataRoot,
    '--install-root', installRoot,
    '--config', configPath,
    '--modules', initModules,
    '--port', String(containerPort),
    '--disk-variant', diskVariant,
    '--registration', registration
  ];
  if (emailDomains.length > 0) initCommand.push('--email-domains', emailDomains.join(','));
  if (domain) initCommand.push('--domain', domain);

  const appEnvironment = {
    PAGESAI_CONFIG: configPath,
    PAGESAI_INSTALL_ROOT: installRoot,
    PAGESAI_DATA_ROOT: dataRoot,
    PAGESAI_HOST: '0.0.0.0',
    PAGESAI_PORT: String(containerPort),
    PAGESAI_MODULES: moduleList,
    PAGESAI_MONGO_HOST: 'mongo',
    PAGESAI_MONGO_PORT: '27017',
    PAGESAI_MONGO_USER: `\${PAGESAI_MONGO_USER:-${options.mongoUserDefault}}`,
    PAGESAI_MONGO_PASSWORD: '${PAGESAI_MONGO_PASSWORD:?请设置 PAGESAI_MONGO_PASSWORD}',
    PAGESAI_MONGO_DB: options.databaseName,
    PAGESAI_BOOTSTRAP_TOKEN: '${PAGESAI_BOOTSTRAP_TOKEN:?请设置 PAGESAI_BOOTSTRAP_TOKEN}'
  };

  return {
    modelVersion: MODEL_VERSION,
    name: options.projectName,
    modules,
    moduleList,
    diskVariant,
    registration,
    domain,
    emailDomains: emailDomains.slice(),
    hostPort,
    containerPort,
    dataRoot,
    installRoot,
    configPath,
    databaseName,
    appImage: options.appImage,
    gatewayImage: options.gatewayImage,
    mongoImage: options.mongoImage,
    appDockerfile: options.appDockerfile,
    gatewayDockerfile: options.gatewayDockerfile,
    services: {
      gateway: {
        image: options.gatewayImage,
        build: { context: options.buildContext, dockerfile: options.gatewayDockerfile },
        restart: 'unless-stopped',
        environment: {
          PAGESAI_GATEWAY_PORT: String(containerPort),
          PAGESAI_GATEWAY_HOST: '0.0.0.0',
          PAGESAI_GATEWAY_UPSTREAM: `http://app:${containerPort}`
        },
        ports: [`${hostPort}:${containerPort}`],
        depends_on: { app: { condition: 'service_healthy' } },
        healthcheck: gatewayHealthcheck
      },
      app: {
        image: options.appImage,
        build: { context: options.buildContext, dockerfile: options.appDockerfile },
        restart: 'unless-stopped',
        environment: appEnvironment,
        expose: [String(containerPort)],
        volumes: [`data:${dataRoot}`],
        depends_on: { mongo: { condition: 'service_healthy' } },
        healthcheck
      },
      mongo: {
        image: options.mongoImage,
        build: { context: options.buildContext, dockerfile: 'deploy/docker/Dockerfile.mongo' },
        restart: 'unless-stopped',
        environment: {
          MONGO_INITDB_ROOT_USERNAME: `\${PAGESAI_MONGO_USER:-${options.mongoUserDefault}}`,
          MONGO_INITDB_ROOT_PASSWORD: '${PAGESAI_MONGO_PASSWORD:?请设置 PAGESAI_MONGO_PASSWORD}',
          MONGO_INITDB_DATABASE: options.databaseName
        },
        volumes: ['mongo-db:/data/db'],
        healthcheck: {
          test: [
            'CMD-SHELL',
            'mongosh --host 127.0.0.1 --port 27017 --quiet --file /opt/pagesai/mongo-ready.js'
          ],
          interval: '10s',
          timeout: '5s',
          retries: 10,
          start_period: '20s'
        }
      },
      init: {
        profiles: ['setup'],
        image: options.appImage,
        build: { context: options.buildContext, dockerfile: options.appDockerfile },
        restart: 'no',
        entrypoint: ['node', 'tools/init.js'],
        command: initCommand,
        volumes: [`data:${dataRoot}`]
      }
    },
    volumes: { data: {}, 'mongo-db': {} }
  };
}

function scalar(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  fail(`不支持的 YAML 标量：${typeof value}`);
}

function renderYaml(node, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(node)) {
    return node
      .map((item) => {
        if (item !== null && typeof item === 'object') fail('YAML 序列不支持嵌套对象');
        return `${pad}- ${scalar(item)}`;
      })
      .join('\n');
  }
  if (node === null || typeof node !== 'object') fail('YAML 根节点必须是映射或序列');
  return Object.entries(node)
    .map(([key, value]) => {
      if (value !== null && typeof value === 'object') {
        if (Array.isArray(value)) return `${pad}${key}:\n${renderYaml(value, indent + 2)}`;
        if (Object.keys(value).length === 0) return `${pad}${key}: {}`;
        return `${pad}${key}:\n${renderYaml(value, indent + 2)}`;
      }
      return `${pad}${key}: ${scalar(value)}`;
    })
    .join('\n');
}

function headerFor(model, presetName) {
  const modulesLabel = model.modules.length === 0 ? '仅公共核心' : model.modules.join('、');
  const variantLabel = model.diskVariant === 'pku' ? '北大版（pku）' : '通用版（generic）';
  return [
    `# PagesAI 部署预设：${presetName}（由 deploy/presets/model.js 生成，请勿手工编辑）`,
    `# 模块：${modulesLabel}`,
    `# Disk 版本：${variantLabel}；注册方式：${model.registration}`,
    '# 运行单元：gateway（唯一对外入口）+ app（Node 核心 + 已安装模块）+ mongo（身份与元数据）',
    '# 说明：Glim 与 Disk 是 app 内的 Node 模块，不是独立 Python 服务；也不存在独立 runner 服务。',
    '#       app 不发布宿主机端口，所有外部请求经 gateway 流式转发。',
    '#',
    '# 首次初始化（写入 /data/config.json，使用同一份模块列表与 Disk/注册选择）：',
    `#   docker compose -f deploy/presets/${presetName} --profile setup run --rm init`,
    '#',
    '# 秘密只从当前 shell 注入，不写入仓库或镜像：',
    '#   export PAGESAI_BOOTSTRAP_TOKEN="$(node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))")"',
    '#   export PAGESAI_MONGO_PASSWORD="$(node -e "console.log(require(\'node:crypto\').randomBytes(24).toString(\'hex\'))")"',
    '#',
    `# 构建与启动：docker compose -f deploy/presets/${presetName} up -d --build`,
    '# 健康检查：GET /healthz（存活）与 GET /readyz（核心与模块就绪），经 gateway 访问',
    '# 数据卷：data → /data；mongo-db → /data/db。两卷都由 Docker 命名卷管理。',
    '#'
  ].join('\n');
}

function renderModel(model, { presetName = 'compose', withHeader = true } = {}) {
  const body = renderYaml({
    name: model.name,
    services: model.services,
    volumes: model.volumes
  });
  return `${withHeader ? `${headerFor(model, presetName)}\n` : ''}${body}\n`;
}

function renderPreset(name) {
  if (!Object.prototype.hasOwnProperty.call(PRESETS, name)) {
    fail(`未知预设：${name}（可选：${Object.keys(PRESETS).join('、')}）`);
  }
  const options = PRESET_OPTIONS[name] || {};
  const model = buildModel({
    modules: PRESETS[name],
    diskVariant: options.diskVariant || DEFAULTS.diskVariant,
    registration: options.registration || DEFAULTS.registration,
    hostPort: DEFAULTS.hostPort,
    containerPort: DEFAULTS.containerPort,
    dataRoot: DEFAULTS.dataRoot,
    installRoot: DEFAULTS.installRoot,
    appImage: DEFAULTS.appImage,
    gatewayImage: DEFAULTS.gatewayImage,
    mongoImage: DEFAULTS.mongoImage,
    buildContext: DEFAULTS.buildContext
  });
  return renderModel(model, { presetName: name });
}

function helpText() {
  return [
    'PagesAI Compose 预设模型（deploy/presets/model.js）',
    '',
    '用法：',
    '  node deploy/presets/model.js --write',
    '  node deploy/presets/model.js --print <文件名>',
    '  node deploy/presets/model.js --list',
    '  node deploy/presets/model.js --help',
    '',
    '说明：',
    '  --write  按 PRESETS 重新生成 deploy/presets/*.yml（会覆盖同名文件）',
    '  --print  输出单个预设的完整 YAML 到 stdout',
    '  --list   逐行列出预设与模块',
    '',
    'full-pku 与 full-generic 的服务、镜像与数据卷完全相同，差异只在 init 的',
    '--disk-variant pku 与 --registration email。'
  ].join('\n');
}

function writePresets() {
  const dir = __dirname;
  for (const name of Object.keys(PRESETS)) {
    fs.writeFileSync(path.join(dir, name), renderPreset(name), { mode: 0o644 });
  }
  return Object.keys(PRESETS);
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  if (argv.includes('--write')) {
    const written = writePresets();
    process.stdout.write(`${JSON.stringify({ ok: true, written, count: written.length })}\n`);
    return 0;
  }
  if (argv.includes('--list')) {
    for (const [name, modules] of Object.entries(PRESETS)) {
      const options = PRESET_OPTIONS[name] || {};
      const suffix = options.diskVariant ? `\t${options.diskVariant}/${options.registration}` : '';
      process.stdout.write(`${name}\t${modules.length === 0 ? 'core' : modules.join(',')}${suffix}\n`);
    }
    return 0;
  }
  const index = argv.indexOf('--print');
  if (index >= 0) {
    const name = argv[index + 1];
    if (!name) fail('--print 需要一个预设文件名');
    process.stdout.write(renderPreset(name));
    return 0;
  }
  process.stderr.write(`${helpText()}\n`);
  return 2;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[错误] ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  MODEL_VERSION,
  MODULE_IDS,
  DISK_VARIANTS,
  REGISTRATION_MODES,
  PRESETS,
  PRESET_OPTIONS,
  DEFAULTS,
  RESERVED_PORTS,
  ModelError,
  buildModel,
  renderModel,
  renderPreset,
  validateCombination,
  modulesText,
  writePresets
};