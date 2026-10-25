#!/usr/bin/env node
'use strict';
// PagesAI Pages 任务 worker 入口（C30）。
//
// 当前运行方式是 app 通过 child_process.fork + IPC 启动的任务子进程，
// 不是独立监听端口的服务。本入口提供：
//   - 被宿主 fork（存在 process.send）时：加载 modules/pages/worker/task-worker.js；
//   - --check：离线校验 worker 依赖、模块清单、Node 版本，供镜像 HEALTHCHECK 使用；
//   - 其他情况：明确拒绝，避免把 worker 当成无配置也能常驻的服务。
//
// 用法：
//   node deploy/docker/entrypoints/worker.js --check
//   node deploy/docker/entrypoints/worker.js --help
//   （由宿主 fork，不需要手写参数）

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const TASK_WORKER = path.join(PROJECT_ROOT, 'modules', 'pages', 'worker', 'task-worker.js');
const MODEL_ADAPTERS = path.join(PROJECT_ROOT, 'modules', 'pages', 'worker', 'model-adapters.js');
const PAGES_MANIFEST = path.join(PROJECT_ROOT, 'modules', 'pages', 'manifest.json');

class WorkerEntryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkerEntryError';
    this.code = code;
  }
}

function helpText() {
  return [
    'PagesAI 执行 worker 入口（deploy/docker/entrypoints/worker.js）',
    '',
    '用法：',
    '  node deploy/docker/entrypoints/worker.js --check',
    '  node deploy/docker/entrypoints/worker.js --help',
    '',
    '说明：worker 由 app 进程 fork 并通过 IPC 下发任务；没有 IPC 通道时不会常驻。',
    '--check 只校验代码、依赖与清单，不执行模型请求、不读取生产配置。'
  ].join('\n');
}

function assertNodeVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const required = String((pkg.engines && pkg.engines.node) || '');
  const match = /^>=\s*(\d+)/.exec(required);
  const major = Number(process.versions.node.split('.')[0]);
  if (match && major < Number(match[1])) {
    throw new WorkerEntryError('NODE_VERSION_MISMATCH', `当前 Node ${process.versions.node} 不满足 engines.node ${required}`);
  }
  return { required, actual: process.versions.node };
}

function check() {
  const node = assertNodeVersion();
  if (!fs.existsSync(TASK_WORKER)) throw new WorkerEntryError('WORKER_MISSING', `缺少 ${TASK_WORKER}`);
  if (!fs.existsSync(MODEL_ADAPTERS)) throw new WorkerEntryError('ADAPTER_MISSING', `缺少 ${MODEL_ADAPTERS}`);
  if (!fs.existsSync(PAGES_MANIFEST)) throw new WorkerEntryError('MANIFEST_MISSING', `缺少 ${PAGES_MANIFEST}`);
  const manifest = JSON.parse(fs.readFileSync(PAGES_MANIFEST, 'utf8'));
  if (manifest.id !== 'pages') throw new WorkerEntryError('MANIFEST_INVALID', 'Pages 模块清单 id 不是 pages');
  const adapters = require(MODEL_ADAPTERS);
  if (typeof adapters.generate !== 'function') {
    throw new WorkerEntryError('ADAPTER_INVALID', 'model-adapters.js 未导出 generate()');
  }
  return {
    ok: true,
    check: 'worker',
    node,
    entry: path.relative(PROJECT_ROOT, TASK_WORKER),
    module: manifest.id,
    moduleVersion: manifest.version,
    adapter: 'model-adapters.js',
    standaloneService: false,
    ipcRequired: true
  };
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  if (argv.includes('--check')) {
    process.stdout.write(`${JSON.stringify(check())}\n`);
    return 0;
  }
  if (argv.length > 0) {
    throw new WorkerEntryError('WORKER_USAGE', `未知参数：${argv.join(' ')}（用 --help 查看用法）`);
  }
  if (typeof process.send !== 'function' || !process.connected) {
    throw new WorkerEntryError(
      'WORKER_REQUIRES_IPC',
      'worker 必须由 app 进程 fork 并通过 IPC 启动；独立运行时请使用 --check'
    );
  }
  // 真实 worker 逻辑（IPC 协议、SIGTERM、父进程断开清理）只在宿主拉起时加载。
  require(TASK_WORKER);
  return null;
}

if (require.main === module) {
  try {
    const result = main(process.argv.slice(2));
    if (result !== null) process.exitCode = result;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      code: error.code || 'WORKER_ENTRY_FAILED',
      message: error.message || 'worker 启动失败'
    })}\n`);
    process.exitCode = 2;
  }
}

module.exports = { main, check, TASK_WORKER };
