'use strict';
// Glim 任务控制：排队、运行、停止与恢复。
//
// 任务状态落 JsonStore，进程重启后把 running 标记为 interrupted（可恢复），
// 不会把中断任务伪装成完成。同一用户默认只允许一个运行中的任务。

const crypto = require('node:crypto');

const ACTIVE_STATUSES = new Set(['queued', 'running']);
const RESUMABLE = new Set(['stopped', 'interrupted', 'failed']);

function taskError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.expose = true;
  return error;
}

function publicTask(task) {
  return {
    id: task.id,
    sessionId: task.sessionId || null,
    prompt: task.prompt,
    status: task.status,
    attempts: task.attempts || 0,
    trace: Array.isArray(task.trace) ? task.trace.map((item) => ({ ...item })) : [],
    reply: task.reply || null,
    error: task.error || null,
    messageId: task.messageId || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt || null,
    finishedAt: task.finishedAt || null
  };
}

class TaskRunner {
  constructor({ store, logger, run, clock = () => new Date(), maxRunningPerUser = 1, maxToolRounds = 4 }) {
    this.store = store;
    this.logger = logger;
    this.run = run;
    this.clock = clock;
    this.maxRunningPerUser = maxRunningPerUser;
    this.maxToolRounds = maxToolRounds;
    this.active = new Map();
    this.recover();
  }

  now() {
    return this.clock().toISOString();
  }

  recover() {
    for (const task of this.store.list('tasks')) {
      if (task.status === 'running') {
        this.store.update('tasks', task.id, {
          status: 'interrupted',
          error: '任务因进程重启而中断，可恢复',
          updatedAt: this.now()
        });
      } else if (task.status === 'queued') {
        this.store.update('tasks', task.id, {
          status: 'stopped',
          error: '任务在启动前停止，可恢复',
          updatedAt: this.now()
        });
      }
    }
  }

  owned(userId, taskId) {
    const task = this.store.get('tasks')[taskId] || null;
    if (!task) throw taskError('glim.task_not_found', '任务不存在', 404);
    if (task.userId !== userId) throw taskError('glim.forbidden', '无权访问其他用户的任务', 403);
    return task;
  }

  runningCount(userId) {
    return this.store.list('tasks').filter((task) => task.userId === userId && task.status === 'running').length;
  }

  create({ userId, sessionId = null, prompt, operationId = null }) {
    if (operationId) {
      const existing = this.store.list('tasks').find((task) => task.userId === userId && task.operationId === operationId);
      if (existing) {
        if (existing.prompt !== prompt) throw taskError('glim.operation_conflict', '同一 operationId 携带了不同内容', 409);
        return publicTask(existing);
      }
    }
    const at = this.now();
    const task = {
      id: `task_${crypto.randomUUID()}`,
      userId,
      sessionId,
      prompt,
      operationId,
      status: 'queued',
      attempts: 0,
      trace: [],
      reply: null,
      error: null,
      messageId: null,
      createdAt: at,
      updatedAt: at,
      startedAt: null,
      finishedAt: null
    };
    this.store.put('tasks', task.id, task);
    this.schedule(task.id);
    return publicTask(task);
  }

  schedule(taskId) {
    setImmediate(() => {
      this.execute(taskId).catch((error) => {
        if (this.logger) this.logger.error(`[glim] 任务 ${taskId} 调度失败: ${error && error.message ? error.message : 'unknown'}`);
      });
    });
  }

  async execute(taskId) {
    if (this.active.has(taskId)) return;
    const task = this.store.get('tasks')[taskId];
    if (!task) return;
    // 排队期间可能已被停止；只有仍处于 queued 的任务才允许真正开始。
    if (task.status !== 'queued') return;
    if (this.runningCount(task.userId) >= this.maxRunningPerUser) {
      // 保持排队；当前运行任务结束时会再次调度最早的排队任务。
      return;
    }
    const controller = new AbortController();
    this.active.set(taskId, controller);
    const startedAt = this.now();
    let current = this.store.update('tasks', taskId, {
      status: 'running',
      attempts: (task.attempts || 0) + 1,
      error: null,
      startedAt,
      updatedAt: startedAt
    });
    try {
      const result = await this.run(current, {
        signal: controller.signal,
        maxToolRounds: this.maxToolRounds,
        onTrace: (entry) => {
          const fresh = this.store.get('tasks')[taskId];
          if (!fresh) return;
          const trace = Array.isArray(fresh.trace) ? fresh.trace.slice(-199) : [];
          trace.push(entry);
          this.store.update('tasks', taskId, { trace, updatedAt: this.now() });
        }
      });
      const finishedAt = this.now();
      const stopped = controller.signal.aborted;
      current = this.store.update('tasks', taskId, {
        status: stopped ? 'stopped' : 'done',
        reply: stopped ? null : (result && result.reply) || null,
        messageId: result && result.messageId ? result.messageId : null,
        sessionId: result && result.sessionId ? result.sessionId : current.sessionId,
        updatedAt: finishedAt,
        finishedAt
      });
      if (stopped) current = this.store.update('tasks', taskId, { error: '任务已停止', updatedAt: this.now() });
    } catch (error) {
      const finishedAt = this.now();
      const aborted = controller.signal.aborted || (error && error.code === 'glim.tool_aborted');
      current = this.store.update('tasks', taskId, {
        status: aborted ? 'stopped' : (error && error.status === 409 ? 'stopped' : 'failed'),
        error: aborted ? '任务已停止' : String(error && error.message ? error.message : '任务执行失败').slice(0, 300),
        updatedAt: finishedAt,
        finishedAt
      });
    } finally {
      this.active.delete(taskId);
      this.pump(current ? current.userId : task.userId);
    }
  }

  pump(userId) {
    if (this.runningCount(userId) >= this.maxRunningPerUser) return;
    const next = this.store.list('tasks')
      .filter((task) => task.userId === userId && task.status === 'queued')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
    if (next) this.schedule(next.id);
  }

  stop(userId, taskId) {
    const task = this.owned(userId, taskId);
    const controller = this.active.get(taskId);
    if (controller) {
      controller.abort();
      this.store.update('tasks', taskId, { status: 'stopped', error: '正在停止', updatedAt: this.now() });
      return publicTask(this.store.get('tasks')[taskId]);
    }
    if (ACTIVE_STATUSES.has(task.status)) {
      return publicTask(this.store.update('tasks', taskId, { status: 'stopped', error: '任务已停止', updatedAt: this.now(), finishedAt: this.now() }));
    }
    return publicTask(task);
  }

  resume(userId, taskId) {
    const task = this.owned(userId, taskId);
    if (task.status === 'done') throw taskError('glim.task_finished', '任务已完成，无需恢复', 409);
    if (ACTIVE_STATUSES.has(task.status) && this.active.has(taskId)) {
      throw taskError('glim.task_running', '任务正在运行', 409);
    }
    if (!RESUMABLE.has(task.status) && task.status !== 'queued') {
      throw taskError('glim.task_not_resumable', `任务状态 ${task.status} 不可恢复`, 409);
    }
    const updated = this.store.update('tasks', taskId, {
      status: 'queued',
      error: null,
      reply: null,
      finishedAt: null,
      updatedAt: this.now()
    });
    this.schedule(taskId);
    return publicTask(updated);
  }

  get(userId, taskId) {
    return publicTask(this.owned(userId, taskId));
  }

  list(userId, { sessionId = null, limit = 50 } = {}) {
    const tasks = this.store.list('tasks')
      .filter((task) => task.userId === userId)
      .filter((task) => !sessionId || task.sessionId === sessionId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, Math.min(Math.max(limit, 1), 200))
      .map(publicTask);
    return tasks;
  }

  health() {
    return { active: this.active.size };
  }

  abortAll() {
    for (const [taskId, controller] of this.active.entries()) {
      controller.abort();
      const task = this.store.get('tasks')[taskId];
      if (task) this.store.update('tasks', taskId, { status: 'stopped', error: '模块停止，任务中断', updatedAt: this.now() });
    }
  }
}

module.exports = { TaskRunner, publicTask, ACTIVE_STATUSES };
