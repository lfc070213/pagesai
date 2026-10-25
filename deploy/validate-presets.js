#!/usr/bin/env node
'use strict';
// deploy/validate-presets.js —— 部署预设静态校验（C30 / C31）
//
// 依据：方案 §2.3（先有真实进程入口、镜像与协议，再生成 Compose）、§2.4（同一套语义）、
//       §9.1（组合验收）、§9.6（安装/升级/备份/恢复演练）。
//
// 职责：
//  1. 以 deploy/presets/model.js 为唯一事实来源，核对 12 个预设文件与渲染结果逐字节一致；
//  2. 把渲染结果用零依赖 YAML 子集解析器回读，与 buildModel 逐字段比较；
//  3. 校验运行拓扑：gateway 是唯一发布宿主机端口的服务，app 只 expose，mongo 为依赖，
//     init 只在 setup profile 中运行；不存在 disk / glim / runner 常驻服务与 python3 健康检查；
//  4. 校验六模块全部 64 种组合，含 Disk 的 32 种组合各检查 generic 与 pku，
//     并负向验证“邮箱注册必须有 Mail”“pku 必须有 Disk”；
//  5. 校验镜像引用、秘密引用、Dockerfile 契约与 README 登记；
//  6. 扫描真实 IP / 域名 / 邮箱 / 私钥 / 明文密钥字样。
//
// 退出码：0 = 全部通过；1 = 存在违规。用法见 --help。
// 只使用 Node 内置模块；不改动任何预设文件（生成请用 model.js --write）。

const fs = require('node:fs');
const path = require('node:path');

const model = require(path.join(__dirname, 'presets', 'model.js'));

const DEPLOY_ROOT = __dirname;
const PRESET_DIR = path.join(DEPLOY_ROOT, 'presets');
const README_PATH = path.join(DEPLOY_ROOT, 'README.md');
const DOCKER_DIR = path.join(DEPLOY_ROOT, 'docker');

const EXPECTED_PRESETS = Object.keys(model.PRESETS);
const SERVICE_ORDER = Object.freeze(['app', 'gateway', 'init', 'mongo']);
const REQUIRED_SERVICES = Object.freeze(['gateway', 'app', 'mongo']);
const VOLUME_DATA = 'data';
const VOLUME_MONGO = 'mongo-db';
const DOCKERFILES = Object.freeze({
  app: 'Dockerfile.app',
  gateway: 'Dockerfile.gateway',
  worker: 'Dockerfile.worker'
});

const BOOTSTRAP_REF = '${PAGESAI_BOOTSTRAP_TOKEN:?请设置 PAGESAI_BOOTSTRAP_TOKEN}';
const MONGO_USER_REF = '${PAGESAI_MONGO_USER:-pagesai}';
const MONGO_PASSWORD_REF = '${PAGESAI_MONGO_PASSWORD:?请设置 PAGESAI_MONGO_PASSWORD}';

// 网关与 app 通过 Compose 服务名互连；只允许回环地址与这两个服务名。
const ALLOWED_URL_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', 'app', 'mongo']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0']);

class Report {
  constructor() {
    this.items = [];
  }

  add(scope, message) {
    this.items.push({ scope, message });
  }

  get ok() {
    return this.items.length === 0;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

// ---------------------------------------------------------------------------
// 1. 零依赖 YAML 子集解析器（只支持预设使用到的映射与标量序列）
// ---------------------------------------------------------------------------

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function tokenizeYaml(text, source) {
  const rawLines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const tokens = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i];
    if (/^\s*$/.test(raw)) continue;
    if (/^\t/.test(raw) || /^ *\t/.test(raw)) {
      throw new Error(`${source}:${i + 1} 不允许使用制表符缩进`);
    }
    const stripped = stripComment(raw);
    if (/^\s*$/.test(stripped)) continue;
    const indent = stripped.match(/^ */)[0].length;
    const content = stripped.slice(indent).replace(/\s+$/, '');
    if (content === '') continue;
    if (content.startsWith('&') || content.startsWith('*') || content.startsWith('!')) {
      throw new Error(`${source}:${i + 1} 不支持锚点、别名或标签语法`);
    }
    tokens.push({ indent, content, line: i + 1 });
  }
  return tokens;
}

function parseYaml(text, source = '<yaml>') {
  const tokens = tokenizeYaml(text, source);
  let index = 0;

  function parseScalar(rawValue, line) {
    const value = rawValue.trim();
    if (value === '') return null;
    if (value.startsWith('[') || value.startsWith('{')) {
      try {
        return JSON.parse(value);
      } catch (error) {
        throw new Error(`${source}:${line} 内联 JSON 解析失败：${error.message}`);
      }
    }
    if (value.startsWith('"')) {
      try {
        return JSON.parse(value);
      } catch (error) {
        throw new Error(`${source}:${line} 双引号标量解析失败：${error.message}`);
      }
    }
    if (value.startsWith("'")) {
      if (!value.endsWith("'") || value.length < 2) {
        throw new Error(`${source}:${line} 单引号标量未闭合`);
      }
      return value.slice(1, -1).replace(/''/g, "'");
    }
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null' || value === '~') return null;
    if (/^-?\d+$/.test(value)) return Number(value);
    if (/^-?\d+\.\d+$/.test(value)) return Number(value);
    if (/[[\]{}]/.test(value)) {
      throw new Error(`${source}:${line} 含未加引号的流式集合字符`);
    }
    return value;
  }

  function isSequence(token) {
    return token.content === '-' || token.content.startsWith('- ');
  }

  function parseSequence(indent) {
    const result = [];
    while (index < tokens.length && tokens[index].indent === indent && isSequence(tokens[index])) {
      const token = tokens[index];
      const rest = token.content === '-' ? '' : token.content.slice(2).trim();
      if (rest === '') {
        throw new Error(`${source}:${token.line} 不支持序列内嵌块`);
      }
      if (/^[A-Za-z0-9_.-]+:(?: |$)/.test(rest)) {
        throw new Error(`${source}:${token.line} 不支持序列内映射（预设只使用标量序列）`);
      }
      result.push(parseScalar(rest, token.line));
      index += 1;
    }
    if (index < tokens.length && tokens[index].indent > indent) {
      throw new Error(`${source}:${tokens[index].line} 序列缩进不一致`);
    }
    return result;
  }

  function parseMapping(indent) {
    const result = {};
    while (index < tokens.length && tokens[index].indent === indent && !isSequence(tokens[index])) {
      const token = tokens[index];
      const match = /^([A-Za-z0-9_.-]+):(?:[ ](.*))?$/.exec(token.content);
      if (!match) {
        throw new Error(`${source}:${token.line} 无法解析映射行（仅支持 key: value 或 key:）`);
      }
      const key = match[1];
      if (hasOwn(result, key)) {
        throw new Error(`${source}:${token.line} 重复键 ${key}`);
      }
      const value = (match[2] || '').trim();
      index += 1;
      if (value === '') {
        if (index < tokens.length && tokens[index].indent > indent) {
          result[key] = parseBlock(tokens[index].indent);
        } else {
          result[key] = null;
        }
      } else {
        result[key] = parseScalar(value, token.line);
        if (index < tokens.length && tokens[index].indent > indent) {
          throw new Error(`${source}:${tokens[index].line} 意外缩进`);
        }
      }
    }
    return result;
  }

  function parseBlock(indent) {
    if (index >= tokens.length) {
      throw new Error(`${source} 意外的文件结尾`);
    }
    if (tokens[index].indent !== indent) {
      throw new Error(`${source}:${tokens[index].line} 缩进不一致（期望 ${indent}）`);
    }
    return isSequence(tokens[index]) ? parseSequence(indent) : parseMapping(indent);
  }

  if (tokens.length === 0) return {};
  const root = parseBlock(tokens[0].indent);
  if (index !== tokens.length) {
    throw new Error(`${source}:${tokens[index].line} 存在无法归约的内容`);
  }
  if (!isPlainObject(root)) {
    throw new Error(`${source} 顶层必须是映射`);
  }
  return root;
}

// ---------------------------------------------------------------------------
// 2. 结构比较
// ---------------------------------------------------------------------------

function firstDifference(expected, actual, pathName = '$') {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return { path: pathName, expected, actual };
    }
    if (expected.length !== actual.length) {
      return { path: `${pathName}.length`, expected: expected.length, actual: actual.length };
    }
    for (let i = 0; i < expected.length; i += 1) {
      const diff = firstDifference(expected[i], actual[i], `${pathName}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  if (isPlainObject(expected) || isPlainObject(actual)) {
    if (!isPlainObject(expected) || !isPlainObject(actual)) {
      return { path: pathName, expected, actual };
    }
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      if (!hasOwn(expected, key) || !hasOwn(actual, key)) {
        return {
          path: `${pathName}.${key}`,
          expected: hasOwn(expected, key) ? expected[key] : '<缺失>',
          actual: hasOwn(actual, key) ? actual[key] : '<缺失>'
        };
      }
      const diff = firstDifference(expected[key], actual[key], `${pathName}.${key}`);
      if (diff) return diff;
    }
    return null;
  }
  if (expected !== actual) return { path: pathName, expected, actual };
  return null;
}

function shortValue(value) {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

function reportDifference(report, scope, expected, actual, label = '') {
  const diff = firstDifference(expected, actual);
  if (diff) {
    report.add(scope, `${label}${label ? '：' : ''}${diff.path} 期望 ${shortValue(diff.expected)}，实际 ${shortValue(diff.actual)}`);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 3. 镜像引用与 Dockerfile 契约
// ---------------------------------------------------------------------------

/**
 * 镜像只允许三种形态：
 *  - 已锁定摘要：name@sha256:<64 位十六进制>；
 *  - 本地构建：pagesai/app:local / pagesai/gateway:local，且服务带 build；
 *  - 公共基础镜像的显式标签：mongo:7（发布前仍须锁摘要）。
 * 自定义/私有仓库主机、协议、本机与私有网段一律拒绝。
 */
function imageKind(ref) {
  if (typeof ref !== 'string' || ref.trim() === '' || /\s/.test(ref)) return null;
  if (ref.includes('://')) return null;
  if (ref.includes('/')) {
    const first = ref.split('/')[0];
    if (first.includes('.') || first.includes(':')) return null;
    if (/^localhost$|^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(first)) return null;
  }
  if (/^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/.test(ref)) return 'digest';
  if (ref === 'pagesai/app:local' || ref === 'pagesai/gateway:local' || ref === 'pagesai/mongo:local') return 'local';
  if (ref === 'mongo:7') return 'base-tag';
  return null;
}

function validateDockerfiles(report) {
  const expectedEntries = {
    app: { cmd: 'deploy/docker/entrypoints/app.js', health: 'deploy/docker/healthcheck.js' },
    gateway: { cmd: 'deploy/docker/entrypoints/gateway.js', health: 'deploy/docker/gateway-healthcheck.js' },
    worker: { cmd: 'deploy/docker/entrypoints/worker.js', health: 'deploy/docker/entrypoints/worker.js' }
  };
  for (const [name, file] of Object.entries(DOCKERFILES)) {
    const scope = `deploy/docker/${file}`;
    const absolute = path.join(DOCKER_DIR, file);
    if (!fs.existsSync(absolute)) {
      report.add(scope, '缺少 Dockerfile');
      continue;
    }
    const text = fs.readFileSync(absolute, 'utf8');
    scanText(text, scope, report);
    if (!/^FROM node:24-bookworm-slim$/m.test(text)) report.add(scope, '基础镜像必须是 node:24-bookworm-slim');
    if (!/--gid 10001 pagesai/.test(text) || !/--uid 10001/.test(text)) {
      report.add(scope, '必须使用 uid/gid 10001 的 pagesai 用户');
    }
    if (!/^USER pagesai$/m.test(text)) report.add(scope, '必须以非 root 用户 pagesai 运行');
    if (!text.includes(expectedEntries[name].cmd)) report.add(scope, `缺少入口 ${expectedEntries[name].cmd}`);
    if (!text.includes(expectedEntries[name].health)) report.add(scope, `健康检查未引用 ${expectedEntries[name].health}`);
    if (/python/.test(text)) report.add(scope, 'Node 镜像不得依赖 Python');
  }

  const gateway = fs.existsSync(path.join(DOCKER_DIR, 'Dockerfile.gateway'))
    ? fs.readFileSync(path.join(DOCKER_DIR, 'Dockerfile.gateway'), 'utf8')
    : '';
  if (/COPY --chown=pagesai:pagesai \. \./.test(gateway)) {
    report.add('deploy/docker/Dockerfile.gateway', '网关镜像不得复制整个业务源码');
  }
  if (!/PAGESAI_GATEWAY_UPSTREAM/.test(gateway)) {
    report.add('deploy/docker/Dockerfile.gateway', '缺少 PAGESAI_GATEWAY_UPSTREAM 默认值说明');
  }

  const worker = fs.existsSync(path.join(DOCKER_DIR, 'Dockerfile.worker'))
    ? fs.readFileSync(path.join(DOCKER_DIR, 'Dockerfile.worker'), 'utf8')
    : '';
  if (/^EXPOSE\b/m.test(worker)) {
    report.add('deploy/docker/Dockerfile.worker', 'worker 是 fork+IPC 子进程，不得 EXPOSE 端口');
  }
  if (!/fork \+ IPC|fork\+IPC|fork 与 IPC/.test(worker)) {
    report.add('deploy/docker/Dockerfile.worker', '必须说明 worker 不是独立监听服务');
  }
}

// ---------------------------------------------------------------------------
// 4. 预设语义校验
// ---------------------------------------------------------------------------

function expectedServices() {
  return ['app', 'gateway', 'init', 'mongo'];
}

function validatePresetModel(parsed, expected, report, scope) {
  if (!isPlainObject(parsed)) {
    report.add(scope, '顶层必须是映射');
    return;
  }
  const topKeys = Object.keys(parsed).sort();
  reportDifference(report, scope, ['name', 'services', 'volumes'], topKeys, '顶层字段');
  if (parsed.name !== model.DEFAULTS.projectName) {
    report.add(scope, `顶层 name 必须是 ${model.DEFAULTS.projectName}`);
  }
  if (!isPlainObject(parsed.services)) {
    report.add(scope, 'services 必须是映射');
    return;
  }
  const actualServices = Object.keys(parsed.services).sort();
  reportDifference(report, scope, expectedServices(), actualServices, '服务集合');

  const services = parsed.services;
  for (const id of actualServices) {
    const service = services[id];
    if (!isPlainObject(service)) {
      report.add(scope, `服务 ${id} 必须是映射`);
      continue;
    }
    if (id === 'init') {
      if (service.restart !== 'no') report.add(scope, 'init 必须 restart: no');
      continue;
    }
    if (service.restart !== 'unless-stopped') report.add(scope, `服务 ${id} 必须 restart: unless-stopped`);
    const kind = imageKind(service.image);
    if (!kind) report.add(scope, `服务 ${id} 的镜像引用不合法：${service.image}`);
    if (kind === 'local') {
      if (!isPlainObject(service.build)) {
        report.add(scope, `服务 ${id} 使用本地镜像标签但缺少 build`);
      } else {
        if (service.build.context !== '../..') report.add(scope, `服务 ${id} 的 build.context 必须是 ../..`);
      }
    } else if (service.build !== undefined) {
      report.add(scope, `服务 ${id} 使用可拉取镜像时不得声明 build`);
    }
    for (const forbidden of ['network_mode', 'pid', 'ipc', 'privileged', 'cap_add', 'devices', 'env_file', 'volumes_from', 'user']) {
      if (hasOwn(service, forbidden)) report.add(scope, `服务 ${id} 不允许字段 ${forbidden}`);
    }
  }

  validateGateway(services.gateway, report, scope);
  validateApp(services.app, expected, report, scope);
  validateMongo(services.mongo, report, scope);
  validateInit(services.init, expected, report, scope);
  validateVolumes(parsed.volumes, services, report, scope);

  // 依赖环检测
  const state = new Map();
  function visit(id, trail) {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      report.add(scope, `依赖存在环：${trail.concat(id).join(' → ')}`);
      return;
    }
    state.set(id, 'visiting');
    const deps = services[id] && services[id].depends_on ? Object.keys(services[id].depends_on) : [];
    for (const dep of deps) {
      if (!hasOwn(services, dep)) {
        report.add(scope, `服务 ${id} 依赖不存在的服务 ${dep}`);
        continue;
      }
      visit(dep, trail.concat(id));
    }
    state.set(id, 'done');
  }
  for (const id of actualServices) visit(id, []);
}

function validateGateway(service, report, scope) {
  const id = 'gateway';
  if (!isPlainObject(service)) {
    report.add(scope, `缺少服务 ${id}`);
    return;
  }
  if (service.build && service.build.dockerfile !== 'deploy/docker/Dockerfile.gateway') {
    report.add(scope, `gateway 的 build.dockerfile 必须是 deploy/docker/Dockerfile.gateway`);
  }
  if (!Array.isArray(service.ports) || service.ports.length !== 1 || service.ports[0] !== '8080:8080') {
    report.add(scope, 'gateway 必须且只能发布 8080:8080');
  }
  if (service.expose !== undefined) report.add(scope, 'gateway 不需要 expose（它直接发布端口）');
  if (service.volumes !== undefined) report.add(scope, 'gateway 不得挂载数据卷');
  const env = service.environment;
  if (!isPlainObject(env)) {
    report.add(scope, 'gateway 缺少 environment');
  } else {
    reportDifference(report, scope, ['PAGESAI_GATEWAY_HOST', 'PAGESAI_GATEWAY_PORT', 'PAGESAI_GATEWAY_UPSTREAM'], Object.keys(env).sort(), 'gateway 环境变量');
    if (env.PAGESAI_GATEWAY_HOST !== '0.0.0.0') report.add(scope, 'gateway 必须监听 0.0.0.0');
    if (env.PAGESAI_GATEWAY_PORT !== '8080') report.add(scope, 'gateway 监听端口必须是 8080');
    if (env.PAGESAI_GATEWAY_UPSTREAM !== 'http://app:8080') report.add(scope, 'gateway 上游必须是 http://app:8080');
  }
  const deps = service.depends_on ? Object.keys(service.depends_on) : [];
  if (deps.length !== 1 || deps[0] !== 'app' || service.depends_on.app.condition !== 'service_healthy') {
    report.add(scope, 'gateway 必须以 condition: service_healthy 只依赖 app');
  }
  validateHealthcheck(id, service, report, scope, 'deploy/docker/gateway-healthcheck.js');
}

function validateApp(service, expected, report, scope) {
  const id = 'app';
  if (!isPlainObject(service)) {
    report.add(scope, `缺少服务 ${id}`);
    return;
  }
  if (service.ports !== undefined) report.add(scope, 'app 不得发布宿主机端口（只能经 gateway 访问）');
  if (!Array.isArray(service.expose) || service.expose.length !== 1 || service.expose[0] !== '8080') {
    report.add(scope, 'app 必须 expose 8080');
  }
  if (service.build && service.build.dockerfile !== 'deploy/docker/Dockerfile.app') {
    report.add(scope, 'app 的 build.dockerfile 必须是 deploy/docker/Dockerfile.app');
  }
  if (reportDifference(report, scope, [`${VOLUME_DATA}:/data`], service.volumes, 'app 数据卷')) {
    // 差异已报告
  }
  const deps = service.depends_on ? Object.keys(service.depends_on) : [];
  if (deps.length !== 1 || deps[0] !== 'mongo' || service.depends_on.mongo.condition !== 'service_healthy') {
    report.add(scope, 'app 必须以 condition: service_healthy 只依赖 mongo');
  }
  const env = service.environment;
  if (!isPlainObject(env)) {
    report.add(scope, 'app 缺少 environment');
  } else {
    const expectedKeys = [
      'PAGESAI_CONFIG',
      'PAGESAI_DATA_ROOT',
      'PAGESAI_HOST',
      'PAGESAI_INSTALL_ROOT',
      'PAGESAI_MODULES',
      'PAGESAI_MONGO_DB',
      'PAGESAI_MONGO_HOST',
      'PAGESAI_MONGO_PASSWORD',
      'PAGESAI_MONGO_PORT',
      'PAGESAI_MONGO_USER',
      'PAGESAI_BOOTSTRAP_TOKEN',
      'PAGESAI_PORT'
    ].sort();
    reportDifference(report, scope, expectedKeys, Object.keys(env).sort(), 'app 环境变量');
    if (env.PAGESAI_MODULES !== expected.moduleList) {
      report.add(scope, `app 的 PAGESAI_MODULES 必须是 "${expected.moduleList}"`);
    }
    if (env.PAGESAI_CONFIG !== '/data/config.json') report.add(scope, 'app 的 PAGESAI_CONFIG 必须是 /data/config.json');
    if (env.PAGESAI_DATA_ROOT !== '/data') report.add(scope, 'app 的 PAGESAI_DATA_ROOT 必须是 /data');
    if (env.PAGESAI_INSTALL_ROOT !== '/opt/pagesai') report.add(scope, 'app 的 PAGESAI_INSTALL_ROOT 必须是 /opt/pagesai');
    if (env.PAGESAI_HOST !== '0.0.0.0') report.add(scope, 'app 必须监听 0.0.0.0');
    if (env.PAGESAI_PORT !== '8080') report.add(scope, 'app 端口必须是 8080');
    if (env.PAGESAI_MONGO_HOST !== 'mongo') report.add(scope, 'app 的 PAGESAI_MONGO_HOST 必须是 mongo');
    if (env.PAGESAI_MONGO_PORT !== '27017') report.add(scope, 'app 的 PAGESAI_MONGO_PORT 必须是 27017');
    if (env.PAGESAI_MONGO_USER !== MONGO_USER_REF) report.add(scope, 'app 的 MongoDB 用户名引用不合法');
    if (env.PAGESAI_MONGO_PASSWORD !== MONGO_PASSWORD_REF) report.add(scope, 'app 的 MongoDB 密码必须是必填秘密引用');
    if (env.PAGESAI_MONGO_DB !== 'pagesai') report.add(scope, 'app 的 PAGESAI_MONGO_DB 必须是 pagesai');
    if (env.PAGESAI_BOOTSTRAP_TOKEN !== BOOTSTRAP_REF) report.add(scope, 'app 的引导令牌必须是必填秘密引用');
  }
  validateHealthcheck(id, service, report, scope, 'deploy/docker/healthcheck.js');
}

function validateMongo(service, report, scope) {
  const id = 'mongo';
  if (!isPlainObject(service)) {
    report.add(scope, `缺少服务 ${id}`);
    return;
  }
  if (service.ports !== undefined) report.add(scope, 'mongo 不得发布宿主机端口');
  if (service.depends_on !== undefined) report.add(scope, 'mongo 不得依赖其他服务');
  if (reportDifference(report, scope, [`${VOLUME_MONGO}:/data/db`], service.volumes, 'mongo 数据卷')) {
    // 差异已报告
  }
  const env = service.environment;
  if (!isPlainObject(env)) {
    report.add(scope, 'mongo 缺少 environment');
  } else {
    reportDifference(
      report,
      scope,
      ['MONGO_INITDB_DATABASE', 'MONGO_INITDB_ROOT_PASSWORD', 'MONGO_INITDB_ROOT_USERNAME'],
      Object.keys(env).sort(),
      'mongo 环境变量'
    );
    if (env.MONGO_INITDB_ROOT_USERNAME !== MONGO_USER_REF) report.add(scope, 'mongo 用户名引用不合法');
    if (env.MONGO_INITDB_ROOT_PASSWORD !== MONGO_PASSWORD_REF) report.add(scope, 'mongo 密码必须是必填秘密引用');
    if (env.MONGO_INITDB_DATABASE !== 'pagesai') report.add(scope, 'mongo 初始数据库必须是 pagesai');
  }
  const health = service.healthcheck;
  if (!isPlainObject(health) || !Array.isArray(health.test)) {
    report.add(scope, 'mongo 缺少 healthcheck');
  } else {
    const joined = health.test.join(' ');
    if (!joined.includes('/opt/pagesai/mongo-ready.js')) report.add(scope, 'mongo 健康检查必须验证已认证的副本集 Primary');
    const ready = fs.readFileSync(path.join(DOCKER_DIR, 'mongo-ready.js'), 'utf8');
    if (!ready.includes('process.env.MONGO_INITDB_ROOT_PASSWORD') || !ready.includes('isWritablePrimary') || !ready.includes('rs.initiate')) report.add(scope, 'Mongo 就绪脚本缺少认证或副本集初始化');
  }
}

function validateInit(service, expected, report, scope) {
  const id = 'init';
  if (!isPlainObject(service)) {
    report.add(scope, `缺少服务 ${id}`);
    return;
  }
  if (!Array.isArray(service.profiles) || service.profiles.length !== 1 || service.profiles[0] !== 'setup') {
    report.add(scope, 'init 必须只在 setup profile 中运行');
  }
  if (service.image !== model.DEFAULTS.appImage) report.add(scope, 'init 必须复用 app 镜像');
  if (reportDifference(report, scope, ['node', 'tools/init.js'], service.entrypoint, 'init 入口')) {
    // 差异已报告
  }
  if (!Array.isArray(service.command)) {
    report.add(scope, 'init 缺少 command');
    return;
  }
  const command = service.command;
  const pairs = {};
  for (let i = 0; i < command.length; i += 1) {
    const token = command[i];
    if (typeof token !== 'string' || !token.startsWith('--')) continue;
    const next = command[i + 1];
    // 布尔开关（如 --container）只占一个 token，不能吞掉下一个参数。
    if (typeof next === 'string' && !next.startsWith('--')) {
      pairs[token] = next;
      i += 1;
    } else {
      pairs[token] = true;
    }
  }
  if (!command.includes('--container')) report.add(scope, 'init 必须以 --container 运行');
  const expectedPairs = {
    '--data-root': '/data',
    '--install-root': '/opt/pagesai',
    '--config': '/data/config.json',
    '--modules': expected.moduleList === '' ? 'core' : expected.moduleList,
    '--port': '8080',
    '--disk-variant': expected.diskVariant,
    '--registration': expected.registration
  };
  for (const [flag, value] of Object.entries(expectedPairs)) {
    if (pairs[flag] !== value) report.add(scope, `init 的 ${flag} 必须是 ${value}（实际 ${pairs[flag]}）`);
  }
  const known = new Set([...Object.keys(expectedPairs), '--container']);
  for (const flag of Object.keys(pairs)) {
    if (!known.has(flag)) report.add(scope, `init 出现未预期的参数 ${flag}`);
  }
  if (reportDifference(report, scope, [`${VOLUME_DATA}:/data`], service.volumes, 'init 数据卷')) {
    // 差异已报告
  }
}

function validateHealthcheck(id, service, report, scope, script) {
  const health = service.healthcheck;
  if (!isPlainObject(health)) {
    report.add(scope, `服务 ${id} 缺少 healthcheck`);
    return;
  }
  if (!Array.isArray(health.test) || health.test.length === 0) {
    report.add(scope, `服务 ${id} 的 healthcheck.test 必须是非空数组`);
    return;
  }
  for (const key of ['interval', 'timeout', 'retries', 'start_period']) {
    if (health[key] === undefined || health[key] === null || health[key] === '') {
      report.add(scope, `服务 ${id} 的 healthcheck 缺少 ${key}`);
    }
  }
  if (!health.test.includes(script)) report.add(scope, `服务 ${id} 的健康检查必须运行 ${script}`);
  if (health.test.some((item) => /python3/.test(String(item)))) {
    report.add(scope, `服务 ${id} 的健康检查不得依赖 python3`);
  }
}

function validateVolumes(volumes, services, report, scope) {
  if (!isPlainObject(volumes)) {
    report.add(scope, '顶层 volumes 必须是映射');
    return;
  }
  const keys = Object.keys(volumes).sort();
  reportDifference(report, scope, [VOLUME_DATA, VOLUME_MONGO], keys, '命名卷');
  for (const [id, service] of Object.entries(services)) {
    for (const volume of (service && service.volumes) || []) {
      if (typeof volume !== 'string' || !volume.includes(':')) {
        report.add(scope, `服务 ${id} 的卷声明不合法：${String(volume)}`);
        continue;
      }
      const source = volume.split(':')[0];
      if (source.startsWith('.') || source.startsWith('/')) {
        report.add(scope, `服务 ${id} 不允许宿主机绑定挂载：${volume}`);
      }
      if (!keys.includes(source)) report.add(scope, `服务 ${id} 引用了未声明的卷 ${source}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. 文本扫描：真实地址、私钥与明文秘密
// ---------------------------------------------------------------------------

function scanText(text, scope, report) {
  for (const match of text.matchAll(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g)) {
    const value = match[0];
    const octets = value.split('.').map(Number);
    if (octets.some((n) => n > 255)) continue;
    if (LOOPBACK_HOSTS.has(value)) continue;
    report.add(scope, `出现真实 IPv4 地址 ${value}（只允许 127.0.0.1 / localhost / 0.0.0.0）`);
  }

  for (const match of text.matchAll(/https?:\/\/[^\s"'`()（）［］【】,，。；;、]+/g)) {
    const candidate = match[0];
    let host = '';
    try {
      host = new URL(candidate).hostname;
    } catch {
      report.add(scope, `URL 不合法：${candidate}`);
      continue;
    }
    if (!ALLOWED_URL_HOSTS.has(host)) {
      report.add(scope, `出现外部 URL ${candidate}（只允许回环地址与 Compose 服务名）`);
    }
  }

  for (const match of text.matchAll(/(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}(?![0-9A-Fa-f:])/g)) {
    report.add(scope, `出现 IPv6 地址样式 ${match[0]}`);
  }

  const domainPattern = /\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:com|cn|net|org|edu|gov|io|dev|app|cloud|top|xyz|site|tech|ai)\b/gi;
  // 文件名（Dockerfile.app、config.json 之类）不是域名，按扩展名白名单排除。
  const fileNamePattern = /^(?:Dockerfile|Makefile|compose|docker-compose)\.[A-Za-z0-9]+$|^[\w-]+\.(?:js|mjs|cjs|json|yml|yaml|md|txt|sh|lock|sql|toml|ini|conf|css|html|ts|tsx)$/i;
  for (const match of text.matchAll(domainPattern)) {
    if (fileNamePattern.test(match[0])) continue;
    report.add(scope, `出现真实域名样式 ${match[0]}`);
  }

  for (const match of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    report.add(scope, `出现邮箱地址样式 ${match[0]}`);
  }

  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) report.add(scope, '出现私钥字样');
  if (/\b(?:ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp256)\b/.test(text)) report.add(scope, '出现 SSH 公钥/私钥字样');
  if (/\bAKIA[0-9A-Z]{16}\b/.test(text)) report.add(scope, '出现云厂商访问密钥样式');
  if (/\bghp_[A-Za-z0-9]{20,}\b/.test(text)) report.add(scope, '出现代码托管平台令牌样式');
  if (/\bsk-[A-Za-z0-9]{20,}\b/.test(text)) report.add(scope, '出现模型服务密钥样式');

  const withoutComments = text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => stripComment(line))
    .join('\n');
  const secretPattern = /(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|ACCESS_KEY)\s*[:=]\s*(?!["']?\$[({])["']?([^\s"']{8,})/g;
  for (const match of withoutComments.matchAll(secretPattern)) {
    report.add(scope, `疑似明文秘密赋值：${match[1].slice(0, 12)}…`);
  }
}

// ---------------------------------------------------------------------------
// 6. 预设文件与 README
// ---------------------------------------------------------------------------

function validatePresetFile(name, readme, report) {
  const scope = `deploy/presets/${name}`;
  const absolute = path.join(PRESET_DIR, name);
  if (!fs.existsSync(absolute)) {
    report.add(scope, '缺少预设文件（运行 node deploy/presets/model.js --write）');
    return null;
  }
  const text = fs.readFileSync(absolute, 'utf8');
  scanText(text, scope, report);

  const expected = model.buildModel({
    modules: model.PRESETS[name],
    ...(model.PRESET_OPTIONS[name] || {})
  });
  const rendered = model.renderPreset(name);
  if (text !== rendered) {
    const at = firstTextDifference(text, rendered);
    report.add(scope, `文件与 model.js 渲染结果不一致（第 ${at.line} 行附近）；请运行 node deploy/presets/model.js --write`);
  }

  let parsed;
  try {
    parsed = parseYaml(text, scope);
  } catch (error) {
    report.add(scope, `YAML 解析失败：${error.message}`);
    return null;
  }
  const expectedBody = {
    name: expected.name,
    services: expected.services,
    volumes: expected.volumes
  };
  reportDifference(report, scope, expectedBody, parsed, '渲染/回读');
  validatePresetModel(parsed, expected, report, scope);
  if (!readme.includes(name)) report.add(scope, 'deploy/README.md 未登记该预设');
  return { model: expected, parsed };
}

function firstTextDifference(a, b) {
  const left = a.split('\n');
  const right = b.split('\n');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i] !== right[i]) return { line: i + 1 };
  }
  return { line: Math.max(left.length, right.length) };
}

function validateReadme(readme, report) {
  const scope = 'deploy/README.md';
  if (!readme || readme.trim() === '') {
    report.add(scope, 'README 为空');
    return;
  }
  scanText(readme, scope, report);
  const required = [
    'gateway',
    'app',
    'mongo',
    'init',
    '--profile setup',
    '--disk-variant',
    '--registration',
    '64',
    '--matrix',
    'Dockerfile.gateway',
    'pagesai/app:local',
    'pagesai/gateway:local',
    'mongo:7',
    '升级',
    '回滚',
    '备份',
    '数据卷',
    '北大',
    '未完成',
    '未构建',
    'full-generic',
    'full-pku'
  ];
  for (const keyword of required) {
    if (!readme.includes(keyword)) report.add(scope, `缺少必备内容：${keyword}`);
  }
  for (const name of EXPECTED_PRESETS) {
    if (!readme.includes(name)) report.add(scope, `缺少预设 ${name}`);
  }
}

// ---------------------------------------------------------------------------
// 7. 64 种组合静态校验
// ---------------------------------------------------------------------------

function buildMatrixModel(modules, diskVariant, registration) {
  return model.buildModel({
    modules,
    diskVariant,
    registration,
    hostPort: model.DEFAULTS.hostPort,
    containerPort: model.DEFAULTS.containerPort,
    dataRoot: model.DEFAULTS.dataRoot,
    installRoot: model.DEFAULTS.installRoot,
    appImage: model.DEFAULTS.appImage,
    gatewayImage: model.DEFAULTS.gatewayImage,
    mongoImage: model.DEFAULTS.mongoImage,
    buildContext: model.DEFAULTS.buildContext
  });
}

function normalizeVariantChoice(value) {
  const copy = structuredClone(value);
  copy.diskVariant = '<variant>';
  copy.registration = '<registration>';
  const args = copy.services.init.command;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--disk-variant') args[i + 1] = '<variant>';
    if (args[i] === '--registration') args[i + 1] = '<registration>';
  }
  return copy;
}

function validateMatrix(report, printRows) {
  const rows = [];
  let checks = 0;
  let negativeChecks = 0;

  for (let mask = 0; mask < 64; mask += 1) {
    const modules = model.MODULE_IDS.filter((_, i) => (mask & (1 << i)) !== 0);
    const variants = modules.includes('disk') ? ['generic', 'pku'] : ['generic'];
    const registration = modules.includes('mail') ? 'email' : 'open';
    const rowScope = `matrix/${modules.join('+') || 'core-only'}`;
    const before = report.items.length;
    const built = [];

    for (const diskVariant of variants) {
      checks += 1;
      let builtModel;
      try {
        builtModel = buildMatrixModel(modules, diskVariant, registration);
      } catch (error) {
        report.add(`${rowScope}/${diskVariant}`, `组合无法建模：${error.message}`);
        continue;
      }
      built.push(builtModel);
      const scope = `${rowScope}/${diskVariant}`;

      // 渲染 → 回读 → 语义校验
      const rendered = model.renderModel(builtModel, { presetName: `matrix-${mask}.yml` });
      let parsed;
      try {
        parsed = parseYaml(rendered, scope);
      } catch (error) {
        report.add(scope, `模板无法回读：${error.message}`);
        continue;
      }
      reportDifference(report, scope, {
        name: builtModel.name,
        services: builtModel.services,
        volumes: builtModel.volumes
      }, parsed, '渲染/回读');
      validatePresetModel(parsed, builtModel, report, scope);
    }

    // 邮箱注册必须有 Mail（负向）
    if (!modules.includes('mail')) {
      negativeChecks += 1;
      let rejected = false;
      try {
        buildMatrixModel(modules, 'generic', 'email');
      } catch {
        rejected = true;
      }
      if (!rejected) report.add(rowScope, '未安装 Mail 时邮箱注册未被拒绝');
    }
    // pku 必须有 Disk（负向）
    if (!modules.includes('disk')) {
      negativeChecks += 1;
      let rejected = false;
      try {
        buildMatrixModel(modules, 'pku', registration);
      } catch {
        rejected = true;
      }
      if (!rejected) report.add(rowScope, '未安装 Disk 时 pku 版本未被拒绝');
    }

    if (built.length === 2) {
      const diff = firstDifference(normalizeVariantChoice(built[0]), normalizeVariantChoice(built[1]));
      if (diff) report.add(rowScope, `generic 与 pku 的差异超出 Disk 版本/注册方式：${diff.path}`);
    }

    rows.push({
      combination: modules.join('+') || 'core-only',
      modules: modules.join(',') || '-',
      services: REQUIRED_SERVICES.join(',') + ',init',
      volumes: `${VOLUME_DATA},${VOLUME_MONGO}`,
      choice: variants.length === 2 ? 'generic+pku' : registration,
      result: report.items.length > before ? 'FAIL' : 'PASS'
    });
  }

  if (printRows) {
    const header = ['#', '组合', '模块', '服务', '数据卷', '选择', '结果'];
    const widths = [3, 20, 42, 32, 18, 14, 6];
    console.log(header.map((cell, i) => cell.padEnd(widths[i])).join(''));
    rows.forEach((row, i) => {
      const cells = [String(i + 1), row.combination, row.modules, row.services, row.volumes, row.choice, row.result];
      console.log(cells.map((cell, j) => String(cell).padEnd(widths[j])).join(''));
    });
    console.log('');
  }

  if (checks !== 96) report.add('matrix', `组合检查次数异常：${checks}（期望 96）`);
  if (negativeChecks !== 64) report.add('matrix', `负向检查次数异常：${negativeChecks}（期望 64）`);
  return { combinations: 64, checks, negativeChecks, rows };
}

// ---------------------------------------------------------------------------
// 8. 入口
// ---------------------------------------------------------------------------

function listPresetFiles(report) {
  let files = [];
  try {
    files = fs
      .readdirSync(PRESET_DIR)
      .filter((name) => name.endsWith('.yml'))
      .sort();
  } catch (error) {
    report.add('deploy/presets', `无法读取预设目录：${error.message}`);
    return [];
  }
  for (const name of EXPECTED_PRESETS) {
    if (!files.includes(name)) report.add('deploy/presets', `缺少预设 ${name}`);
  }
  for (const name of files) {
    if (!EXPECTED_PRESETS.includes(name)) report.add('deploy/presets', `未登记的预设 ${name}`);
  }
  return files.filter((name) => EXPECTED_PRESETS.includes(name));
}

function summarize(images, report) {
  const pinned = new Set();
  const local = new Set();
  const baseTags = new Set();
  for (const ref of images) {
    const kind = imageKind(ref);
    if (kind === 'digest') pinned.add(ref);
    if (kind === 'local') local.add(ref);
    if (kind === 'base-tag') baseTags.add(ref);
  }
  return {
    pinned_digests: [...pinned].sort(),
    local_builds: [...local].sort(),
    base_tags_pending_digest: [...baseTags].sort(),
    violations: report.items.length
  };
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      [
        '用法：node deploy/validate-presets.js [选项]',
        '',
        '  --matrix        打印六模块 64 种选择组合的静态校验矩阵',
        '  --json          以 JSON 输出摘要（适合 CI 采集）',
        '  --print <名称>  打印某个预设的正文（不含头部注释）',
        '  --help          显示本帮助',
        '',
        '默认行为：校验 deploy/presets/*.yml、deploy/docker/Dockerfile.*、deploy/README.md',
        '与 64 种模块组合（含 96 次 Disk 版本检查）。',
        '退出码 0 = 全部通过；1 = 存在违规。'
      ].join('\n')
    );
    return 0;
  }

  const printIndex = args.indexOf('--print');
  if (printIndex !== -1) {
    const name = args[printIndex + 1];
    if (!name || !EXPECTED_PRESETS.includes(name)) {
      console.error('--print 需要合法的预设文件名，例如 full-generic.yml');
      return 1;
    }
    const expected = model.buildModel({ modules: model.PRESETS[name], ...(model.PRESET_OPTIONS[name] || {}) });
    process.stdout.write(model.renderModel(expected, { presetName: name, withHeader: false }));
    return 0;
  }

  const report = new Report();
  let readme = '';
  try {
    readme = fs.readFileSync(README_PATH, 'utf8');
  } catch (error) {
    report.add('deploy/README.md', `无法读取：${error.message}`);
  }

  validateDockerfiles(report);
  const files = listPresetFiles(report);
  const images = new Set();
  let checked = 0;
  for (const name of files) {
    const result = validatePresetFile(name, readme, report);
    if (!result) continue;
    checked += 1;
    for (const service of Object.values(result.model.services)) {
      if (isPlainObject(service) && typeof service.image === 'string') images.add(service.image);
    }
  }

  const matrix = validateMatrix(report, args.includes('--matrix'));
  if (readme) validateReadme(readme, report);

  const summary = {
    presets_total: files.length,
    presets_validated: checked,
    matrix_combinations: matrix.combinations,
    matrix_checks: matrix.checks,
    matrix_negative_checks: matrix.negativeChecks,
    ...summarize([...images], report),
    result: report.ok ? 'PASS' : 'FAIL'
  };

  if (args.includes('--json')) {
    console.log(JSON.stringify({ ...summary, violations_detail: report.items }, null, 2));
  } else {
    if (!report.ok) {
      console.error('预设静态校验失败：');
      for (const item of report.items) console.error(`  - [${item.scope}] ${item.message}`);
    }
    console.log(
      `预设文件：${checked}/${files.length} 已校验；` +
        `组合矩阵：64 种 / ${matrix.checks} 次版本检查 / ${matrix.negativeChecks} 次负向检查；` +
        `镜像：${summary.pinned_digests.length} 个已锁摘要，${summary.local_builds.length} 个本地构建，` +
        `${summary.base_tags_pending_digest.length} 个基础标签待锁；` +
        `结果：${report.ok ? 'PASS' : `FAIL（${report.items.length} 项违规）`}`
    );
  }
  return report.ok ? 0 : 1;
}

module.exports = {
  parseYaml,
  validatePresetModel,
  validateMatrix,
  validateDockerfiles,
  validateReadme,
  scanText,
  imageKind,
  Report,
  EXPECTED_PRESETS,
  SERVICE_ORDER
};

if (require.main === module) {
  try {
    process.exitCode = main(process.argv);
  } catch (error) {
    console.error(`校验器内部错误：${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  }
}