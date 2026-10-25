'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { fork } = require('node:child_process');
const { CoreError, codes } = require('../../../core/errors.js');
const { killIfMatches } = require('./process-utils.js');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const WORKER_MARKER = 'task-worker.js';

function safeEnv(extra = {}) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: extra.cwd,
    TMPDIR: extra.cwd,
    NODE_NO_WARNINGS: '1',
    ...extra.env
  };
}

class TaskManager {
  constructor({ repository, config, resolveSecret, onResult, logger }) {
    this.repository = repository;
    this.config = config;
    this.resolveSecret = resolveSecret;
    this.onResult = onResult;
    this.logger = logger;
    this.children = new Map();
    this.pumping = false;
    this.accepting = true;
  }

  async event(taskId, event, data) {
    const bounded = {};
    for (const [key, value] of Object.entries(data || {})) {
      bounded[key] = typeof value === 'string' ? value.slice(0, 8000) : value;
    }
    await this.repository.pushTaskEvent(taskId, { event, ...bounded });
  }

  async create({ ownerId, siteId, siteName, prompt, targetPath, model, files, materials }) {
    if (!this.accepting) throw new CoreError(codes.MODULE_NOT_READY, '任务调度器正在停止', { status: 503 });
    const now = this.repository.now();
    const task = {
      id: crypto.randomUUID(), ownerId, siteId, siteName, module: 'pages', kind: 'site-generate',
      status: 'queued', progress: 0, prompt, targetPath: targetPath || null,
      model: { id: model.id, kind: model.kind, baseUrl: model.baseUrl || null, model: model.model || null, keyRef: model.keyRef || null },
      files, materials, events: [], eventSequence: 0, result: null, error: null,
      cancelRequestedAt: null, createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + this.config.taskTtlMs).toISOString()
    };
    await this.repository.createTask(task);
    await this.event(task.id, 'status', { status: 'queued' });
    this.pump().catch((error) => this.logger.error(`[pages] 调度失败：${error.message}`));
    return task;
  }

  async recover() {
    const interrupted = await this.repository.tasksInStatuses(['running', 'cancelling']);
    for (const task of interrupted) {
      // 宿主被强杀后 worker 可能仍存活；先按 pid + 命令行标记清理，避免重复占用资源。
      if (Number.isInteger(task.workerPid)) {
        const cleaned = await killIfMatches(task.workerPid, [WORKER_MARKER]).catch(() => ({ killed: false }));
        if (cleaned.killed) this.logger.warn(`[pages] 已清理遗留 worker（task=${task.id}, pid=${task.workerPid}）`);
      }
      const failed = await this.repository.transitionTask(task.id, ['running', 'cancelling'], {
        status: 'failed', workerPid: null,
        error: { code: 'TASK_INTERRUPTED', message: '服务重启中断了任务；未提交部分结果', failed: true },
        finishedAt: this.repository.now()
      });
      if (!failed) continue;
      await this.event(task.id, 'error', { code: 'TASK_INTERRUPTED', message: '服务重启中断任务' });
    }
    await this.pump();
  }

  async pump() {
    if (this.pumping || !this.accepting) return;
    this.pumping = true;
    try {
      while (this.children.size < this.config.maxConcurrentTasks) {
        const queued = await this.repository.tasksInStatuses(['queued']);
        const runnable = queued.find((task) => ![...this.children.values()].some((child) => child.task.ownerId === task.ownerId));
        if (!runnable) break;
        await this.run(runnable);
      }
    } finally { this.pumping = false; }
  }

  async run(task) {
    const workspace = path.join(this.config.taskRuntimeRoot, task.id);
    await fs.promises.mkdir(workspace, { recursive: true, mode: 0o700 });
    const claimed = await this.repository.claimTask(task.id, { status: 'running', startedAt: this.repository.now(), progress: 5 });
    if (!claimed) return;
    let secret;
    try {
      secret = task.model.keyRef ? await this.resolveSecret(task.model.keyRef) : null;
    } catch (cause) {
      const current = await this.repository.getTask(task.id);
      if (current && !TERMINAL.has(current.status)) await this.fail(task.id, cause.code || 'MODEL_KEY_MISSING', '模型 key reference 无法解析');
      return;
    }
    const current = await this.repository.getTask(task.id);
    if (!current || current.status !== 'running') return;
    if (task.model.kind === 'openai-compatible' && !secret) {
      await this.fail(task.id, 'MODEL_KEY_MISSING', '模型 key reference 无法解析');
      return;
    }
    const child = fork(path.join(__dirname, '..', 'worker', 'task-worker.js'), [], {
      cwd: workspace,
      env: safeEnv({ cwd: workspace, env: {
        ...(secret ? { PAGESAI_TASK_MODEL_KEY: secret } : {}),
        ...(this.config.allowTestModel ? { PAGESAI_ALLOW_TEST_MODEL: '1' } : {})
      } }),
      execArgv: [`--max-old-space-size=${this.config.workerMemoryMB}`],
      silent: true,
      ...(this.config.workerUid === null ? {} : { uid: this.config.workerUid, gid: this.config.workerGid })
    });
    const record = { child, task: claimed, workspace, stdout: '', stdoutBytes: 0, stderr: '', settled: false, exited: false, finishing: null, timer: null };
    this.children.set(task.id, record);
    const onExit = async (code, signal) => {
      if (record.exited) return;
      record.exited = true;
      if (record.timer) clearTimeout(record.timer);
      try {
        if (record.finishing) await record.finishing;
        if (!record.settled) {
          record.settled = true;
          const latest = await this.repository.getTask(task.id);
          if (latest && !TERMINAL.has(latest.status)) {
            await this.fail(task.id, signal ? 'WORKER_SIGNALLED' : 'WORKER_EXIT', `worker 未返回结果（code=${code}, signal=${signal || 'none'}）`);
          }
        }
      } finally {
        this.children.delete(task.id);
        this.pump().catch(() => {});
      }
    };
    child.stdout.on('data', (chunk) => {
      record.stdoutBytes += chunk.length;
      record.stdout = (record.stdout + chunk.toString('utf8')).slice(-4096);
      if (record.stdoutBytes > 4096) this.cancel(task.id, 'OUTPUT_LIMIT').catch(() => {});
    });
    child.stderr.on('data', (chunk) => { record.stderr = (record.stderr + chunk.toString('utf8')).slice(-4096); });
    child.on('message', (message) => {
      if (record.settled) return;
      if (message.type === 'event') {
        this.event(task.id, message.event, message.data).catch(() => {});
      } else if (message.type === 'result') {
        record.settled = true;
        record.finishing = this.succeed(record, message.result);
      } else if (message.type === 'error') {
        record.settled = true;
        record.finishing = this.fail(task.id, message.error.code, message.error.message);
      }
    });
    child.on('error', (error) => {
      if (!record.settled) {
        record.settled = true;
        record.finishing = this.fail(task.id, 'WORKER_SPAWN_FAILED', `worker 启动失败：${error.code || 'UNKNOWN'}`);
      }
    });
    child.on('exit', onExit);
    record.timer = setTimeout(() => {
      this.cancel(task.id, 'TASK_TIMEOUT').catch(() => {});
    }, this.config.taskTimeoutMs);
    record.timer.unref();
    // fork 后不再 await，直到所有退出/消息监听已安装；避免早退 worker 永久占槽。
    if (child.exitCode !== null || child.signalCode !== null) { await onExit(child.exitCode, child.signalCode); return; }
    await this.repository.transitionTask(task.id, ['running'], { workerPid: child.pid }).catch(() => null);
    await this.event(task.id, 'status', { status: 'running' });
    if (!record.exited && !record.settled && child.connected) {
      child.send({ type: 'run', payload: {
        prompt: task.prompt, targetPath: task.targetPath,
        site: { id: task.siteId, name: claimed.siteName || task.siteId },
        files: task.files, materials: task.materials, model: task.model
      } }, (error) => {
        if (error && !record.settled) {
          record.settled = true;
          record.finishing = this.fail(task.id, 'WORKER_IPC_FAILED', '无法向 worker 发送任务');
        }
      });
    }
  }

  async succeed(record, result) {
    const taskId = record.task.id;
    try {
      const committed = await this.onResult(record.task, result);
      // 只有仍处于 running 的任务才接受结果；已被取消/失败的任务不覆盖终态。
      const updated = await this.repository.transitionTask(taskId, ['running'], {
        status: 'succeeded', progress: 100, result: committed, workerPid: null, finishedAt: this.repository.now()
      });
      if (!updated) return;
      await this.event(taskId, 'done', { status: 'succeeded', result: committed });
    } catch (error) {
      await this.fail(taskId, error.code || 'RESULT_COMMIT_FAILED', error instanceof CoreError ? error.message : '结果提交失败；未公开部分结果');
    }
  }

  async fail(taskId, code, message) {
    const safeCode = String(code || 'TASK_FAILED').slice(0, 120);
    const safeMessage = String(message || '任务失败').replace(/(api[_-]?key|authorization|bearer)\s*[:=]?\s*\S+/gi, '$1=[redacted]').slice(0, 500);
    // cancelling 由 cancel() 自己收尾；worker 退出失败不得把用户取消改写成 failed。
    const updated = await this.repository.transitionTask(taskId, ['queued', 'running'], {
      status: 'failed', workerPid: null,
      error: { code: safeCode, message: safeMessage, failed: true }, finishedAt: this.repository.now()
    });
    if (!updated) return null;
    await this.event(taskId, 'error', { code: safeCode, message: safeMessage });
    return updated;
  }

  async cancel(taskId, reason = 'USER_CANCELLED') {
    const task = await this.repository.getTask(taskId);
    if (!task) throw new CoreError(codes.NOT_FOUND, '任务不存在', { status: 404 });
    if (TERMINAL.has(task.status)) return task;
    if (task.status === 'queued') {
      const cancelled = await this.repository.transitionTask(taskId, ['queued'], {
        status: 'cancelled', cancelRequestedAt: this.repository.now(), finishedAt: this.repository.now(),
        error: { code: reason, message: '任务已取消' }
      });
      if (!cancelled) return this.repository.getTask(taskId);
      await this.event(taskId, 'done', { status: 'cancelled' });
      return cancelled;
    }
    const cancelling = await this.repository.transitionTask(taskId, ['running'], {
      status: 'cancelling', cancelRequestedAt: this.repository.now(),
      error: { code: reason, message: reason === 'TASK_TIMEOUT' ? '任务超时' : '任务取消中' }
    });
    if (!cancelling) {
      const current = await this.repository.getTask(taskId);
      if (!current) throw new CoreError(codes.NOT_FOUND, '任务不存在', { status: 404 });
      return current;
    }
    const record = this.children.get(taskId);
    if (record) {
      record.settled = true;
      record.child.kill('SIGTERM');
      setTimeout(() => { if (!record.exited) record.child.kill('SIGKILL'); }, 1000).unref();
    }
    // worker 可能刚刚失败退出；只有 cancelling 状态才写成 cancelled。
    const final = await this.repository.transitionTask(taskId, ['cancelling'], {
      status: 'cancelled', workerPid: null, finishedAt: this.repository.now(),
      error: { code: reason, message: reason === 'TASK_TIMEOUT' ? '任务已因超时停止' : '任务已停止' }
    });
    if (!final) return this.repository.getTask(taskId);
    await this.event(taskId, 'done', { status: 'cancelled', code: reason });
    return final;
  }

  async stop() {
    this.accepting = false;
    await Promise.all([...this.children.keys()].map((id) => this.cancel(id, 'SERVICE_STOPPED')));
  }
}

module.exports = { TaskManager, TERMINAL };
