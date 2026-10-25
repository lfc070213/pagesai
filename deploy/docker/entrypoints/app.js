#!/usr/bin/env node
'use strict';
// PagesAI 应用进程入口（C30）。
//
// 职责：
//  1. 读取 config.json（默认 /data/config.json），核对容器环境变量与配置一致；
//  2. 复用 core/runtime.js 的 startRuntime：加载正式 MongoDB 适配器、安装所选模块、
//     监听 config.port；
//  3. SIGTERM/SIGINT 时调用 createServer().close() 优雅停止（关闭 HTTP、停用模块、
//     关闭 Mongo 客户端），超时才强制退出；
//  4. --check 只做离线校验（配置 schema、模块目录、Node 版本），不连接数据库。
//
// 用法：
//   node deploy/docker/entrypoints/app.js [--config /data/config.json] [--host 0.0.0.0]
//   node deploy/docker/entrypoints/app.js --check --config /path/to/config.json
//   node deploy/docker/entrypoints/app.js --help

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SHUTDOWN_TIMEOUT_MS = 20000;

class EntryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EntryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new EntryError(code, message);
}

function parseArgs(argv) {
  const options = { configPath: null, host: null, check: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--check') {
      options.check = true;
    } else if (arg === '--config') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail('ENTRY_USAGE', '--config 需要一个绝对路径');
      options.configPath = value;
      index += 1;
    } else if (arg.startsWith('--config=')) {
      options.configPath = arg.slice('--config='.length);
    } else if (arg === '--host') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail('ENTRY_USAGE', '--host 需要一个地址');
      options.host = value;
      index += 1;
    } else if (arg.startsWith('--host=')) {
      options.host = arg.slice('--host='.length);
    } else {
      fail('ENTRY_USAGE', `未知参数：${arg}（用 --help 查看用法）`);
    }
  }
  return options;
}

function helpText() {
  return [
    'PagesAI 应用进程入口（deploy/docker/entrypoints/app.js）',
    '',
    '用法：',
    '  node deploy/docker/entrypoints/app.js [--config <绝对路径>] [--host <地址>]',
    '  node deploy/docker/entrypoints/app.js --check [--config <绝对路径>]',
    '',
    '环境变量：',
    '  PAGESAI_CONFIG        配置文件路径，默认 /data/config.json',
    '  PAGESAI_HOST          监听地址，默认 0.0.0.0',
    '  PAGESAI_PORT          仅用于与 config.port 核对；不一致即拒绝启动',
    '  PAGESAI_MODULES       仅用于与 config.modules 核对',
    '  PAGESAI_DATA_ROOT     仅用于与 config.dataRoot 核对',
    '  PAGESAI_INSTALL_ROOT  仅用于与 config.installRoot 核对',
    '  PAGESAI_MONGO_DB      仅用于与 config.database.name 核对',
    '  PAGESAI_BOOTSTRAP_TOKEN / PAGESAI_MONGO_*  由部署注入的真实秘密',
    '',
    '端口只来自 config.json；命令行不提供端口覆盖，避免与 healthcheck、Compose 映射分叉。'
  ].join('\n');
}

function assertNodeVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const required = String((pkg.engines && pkg.engines.node) || '');
  const match = /^>=\s*(\d+)/.exec(required);
  const major = Number(process.versions.node.split('.')[0]);
  if (match && major < Number(match[1])) {
    fail('NODE_VERSION_MISMATCH', `当前 Node ${process.versions.node} 不满足 engines.node ${required}`);
  }
  return { required, actual: process.versions.node };
}

function readConfig(configPath) {
  if (!path.isAbsolute(configPath)) fail('CONFIG_INVALID', `配置文件必须是绝对路径：${configPath}`);
  let document;
  try {
    document = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    fail('CONFIG_UNREADABLE', `无法读取配置 ${configPath}：${error.message}`);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    fail('CONFIG_INVALID', 'config.json 必须是 JSON 对象');
  }
  if (document.product !== 'pagesai') fail('CONFIG_INVALID', 'config.json 不是 PagesAI 配置');
  return document;
}

function samePath(left, right) {
  return path.resolve(String(left)) === path.resolve(String(right));
}

/** 环境变量与 config.json 必须指向同一部署；重复项不一致时拒绝启动。 */
function assertEnvironmentMatches(document, env) {
  if (env.PAGESAI_MODULES !== undefined && env.PAGESAI_MODULES !== '') {
    const expected = Array.isArray(document.modules) ? document.modules.slice().sort().join(',') : '';
    const actual = String(env.PAGESAI_MODULES)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .sort()
      .join(',');
    if (expected !== actual) {
      fail('MODULES_CONFIG_MISMATCH', `PAGESAI_MODULES=${env.PAGESAI_MODULES} 与 config.modules=${expected} 不一致`);
    }
  }
  if (env.PAGESAI_PORT !== undefined && env.PAGESAI_PORT !== '' && Number(env.PAGESAI_PORT) !== document.port) {
    fail('PORT_CONFIG_MISMATCH', `PAGESAI_PORT=${env.PAGESAI_PORT} 与 config.port=${document.port} 不一致`);
  }
  if (env.PAGESAI_DATA_ROOT && !samePath(env.PAGESAI_DATA_ROOT, document.dataRoot)) {
    fail('DATA_ROOT_CONFIG_MISMATCH', `PAGESAI_DATA_ROOT=${env.PAGESAI_DATA_ROOT} 与 config.dataRoot=${document.dataRoot} 不一致`);
  }
  if (env.PAGESAI_INSTALL_ROOT && !samePath(env.PAGESAI_INSTALL_ROOT, document.installRoot)) {
    fail('INSTALL_ROOT_CONFIG_MISMATCH', `PAGESAI_INSTALL_ROOT 与 config.installRoot=${document.installRoot} 不一致`);
  }
  if (env.PAGESAI_MONGO_DB && env.PAGESAI_MONGO_DB !== document.database.name) {
    fail('MONGO_DB_CONFIG_MISMATCH', `PAGESAI_MONGO_DB=${env.PAGESAI_MONGO_DB} 与 config.database.name=${document.database.name} 不一致`);
  }
}

function validateOffline(document, configPath) {
  const { validate } = require(path.join(PROJECT_ROOT, 'core', 'contracts', 'validate.js'));
  const schema = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'config.schema.json'), 'utf8'));
  const result = validate(schema, document);
  if (!result.valid) {
    const details = result.errors.map((item) => `${item.path}: ${item.message}`).join('；');
    fail('CONFIG_SCHEMA_INVALID', `config.json 不符合 config/config.schema.json：${details}`);
  }
  if (document.database.engine !== 'mongodb') {
    fail('CONFIG_INVALID', '正式启动只支持 database.engine=mongodb');
  }
  for (const id of document.modules) {
    const manifestPath = path.join(document.installRoot, 'modules', id, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      const inImage = path.join(PROJECT_ROOT, 'modules', id, 'manifest.json');
      if (!fs.existsSync(inImage)) fail('MODULE_NOT_FOUND', `模块 ${id} 的 manifest.json 不存在`);
    }
  }
  return {
    configPath,
    deploymentId: document.deploymentId,
    modules: document.modules,
    port: document.port,
    dataRoot: document.dataRoot,
    installRoot: document.installRoot,
    database: document.database.name
  };
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  const node = assertNodeVersion();
  const configPath = path.resolve(options.configPath || process.env.PAGESAI_CONFIG || '/data/config.json');
  const document = readConfig(configPath);
  assertEnvironmentMatches(document, process.env);
  const summary = validateOffline(document, configPath);

  if (options.check) {
    process.stdout.write(`${JSON.stringify({ ok: true, check: 'app', node, ...summary })}\n`);
    return 0;
  }

  const { startRuntime } = require(path.join(PROJECT_ROOT, 'core', 'runtime.js'));
  const host = options.host || process.env.PAGESAI_HOST || '0.0.0.0';
  const runtime = await startRuntime({ configPath, host });

  process.stdout.write(`${JSON.stringify({
    event: 'listening',
    url: runtime.url,
    port: runtime.port,
    host: runtime.host,
    modules: runtime.config.installedModules,
    deploymentId: runtime.config.deploymentId
  })}\n`);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) {
      process.stderr.write(`${JSON.stringify({ event: 'forced-exit', signal })}\n`);
      process.exit(1);
    }
    stopping = true;
    const timer = setTimeout(() => {
      process.stderr.write(`${JSON.stringify({ event: 'shutdown-timeout', signal })}\n`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    try {
      await runtime.app.close();
      process.stdout.write(`${JSON.stringify({ event: 'stopped', signal })}\n`);
      process.exit(0);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ event: 'shutdown-failed', message: error.message })}\n`);
      process.exit(1);
    }
  };
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => { shutdown(signal).catch(() => process.exit(1)); });
  }
  return null;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      code: error.code || 'ENTRY_FAILED',
      message: error.message || '启动失败'
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  parseArgs,
  readConfig,
  assertEnvironmentMatches,
  validateOffline,
  assertNodeVersion
};
