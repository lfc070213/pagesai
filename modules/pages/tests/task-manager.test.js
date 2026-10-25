'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskManager } = require('../server/task-manager.js');

function repositoryFixture() {
  const tasks = new Map();
  return {
    tasks,
    now: () => new Date().toISOString(),
    async createTask(task) { tasks.set(task.id, structuredClone(task)); },
    async getTask(id) { return structuredClone(tasks.get(id) || null); },
    async updateTask(id, patch) {
      const next = { ...tasks.get(id), ...patch, updatedAt: new Date().toISOString() };
      tasks.set(id, next);
      return structuredClone(next);
    },
    async claimTask(id, patch) {
      if (!tasks.has(id) || tasks.get(id).status !== 'queued') return null;
      return this.updateTask(id, patch);
    },
    async transitionTask(id, fromStatuses, patch) {
      const current = tasks.get(id);
      if (!current || !fromStatuses.includes(current.status)) return null;
      return this.updateTask(id, patch);
    },
    async pushTaskEvent() {},
    async tasksInStatuses(statuses) {
      return [...tasks.values()].filter((task) => statuses.includes(task.status)).map((task) => structuredClone(task));
    }
  };
}

function managerFixture(repository, taskRuntimeRoot) {
  return new TaskManager({
    repository,
    config: {
      taskRuntimeRoot, taskTtlMs: 60000, taskTimeoutMs: 10000,
      maxConcurrentTasks: 1, workerMemoryMB: 64,
      workerUid: null, workerGid: null, allowTestModel: true
    },
    resolveSecret: async () => null,
    onResult: async (_task, result) => result,
    logger: { error() {} }
  });
}

function taskFixture(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), ownerId: 'owner', siteId: 'site', siteName: 'Site',
    module: 'pages', kind: 'site-generate', status: 'queued', progress: 0,
    prompt: 'test', targetPath: null,
    model: { id: 'local', kind: 'deterministic-test', baseUrl: null, model: 'deterministic-local-v1', keyRef: null },
    files: {}, materials: [], events: [], eventSequence: 0, result: null, error: null,
    cancelRequestedAt: null, createdAt: now, updatedAt: now,
    expiresAt: new Date(Date.now() + 60000).toISOString(), ...overrides
  };
}

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test('运行状态刚可见即取消时，worker 退出后必须释放并发槽', async () => {
  const taskRuntimeRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pages-task-cancel-'));
  const repository = repositoryFixture();
  const manager = managerFixture(repository, taskRuntimeRoot);
  let cancelled = false;
  repository.pushTaskEvent = async (id, event) => {
    if (!cancelled && event.event === 'status' && event.status === 'running') {
      cancelled = true;
      await manager.cancel(id);
      // 让 worker 有机会在状态事件持久化期间退出，稳定覆盖启动/取消竞态。
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  try {
    const task = await manager.create(taskFixture());
    await waitFor(async () => (await repository.getTask(task.id)).status === 'cancelled', '任务未取消');
    await waitFor(() => manager.children.size === 0, '已取消 worker 仍占用并发槽');
    assert.equal(cancelled, true);
  } finally {
    for (const record of manager.children.values()) record.child.kill('SIGKILL');
    await manager.stop();
    await fs.promises.rm(taskRuntimeRoot, { recursive: true, force: true });
  }
});

test('已取消的持久队列任务不能被迟到的调度重新置为运行', async () => {
  const taskRuntimeRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pages-task-claim-'));
  const repository = repositoryFixture();
  const manager = managerFixture(repository, taskRuntimeRoot);
  const task = taskFixture();
  await repository.createTask(task);
  try {
    await manager.cancel(task.id);
    await manager.run(task);
    assert.equal((await repository.getTask(task.id)).status, 'cancelled');
    assert.equal(manager.children.size, 0);
  } finally {
    for (const record of manager.children.values()) record.child.kill('SIGKILL');
    await manager.stop();
    await fs.promises.rm(taskRuntimeRoot, { recursive: true, force: true });
  }
});

test('迟到的成功结果不得把已取消的任务改写为成功', async () => {
  const repository = repositoryFixture();
  const manager = managerFixture(repository, os.tmpdir());
  const task = taskFixture();
  await repository.createTask(task);
  await repository.updateTask(task.id, { status: 'running', workerPid: 424242 });
  const cancelled = await manager.cancel(task.id, 'USER_CANCELLED');
  assert.equal(cancelled.status, 'cancelled');
  await manager.succeed({ task }, { files: { 'index.html': '<h1>late</h1>' } });
  const current = await repository.getTask(task.id);
  assert.equal(current.status, 'cancelled');
  assert.equal(current.result, null);
});

test('迟到的失败不得覆盖取消终态', async () => {
  const repository = repositoryFixture();
  const manager = managerFixture(repository, os.tmpdir());
  const task = taskFixture();
  await repository.createTask(task);
  await repository.updateTask(task.id, { status: 'running' });
  await manager.cancel(task.id, 'USER_CANCELLED');
  const result = await manager.fail(task.id, 'WORKER_EXIT', 'worker 未返回结果');
  assert.equal(result, null);
  assert.equal((await repository.getTask(task.id)).status, 'cancelled');
});
