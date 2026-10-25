'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readCommand, isAlive, killIfMatches } = require('../server/process-utils.js');

function spawnIdle(scriptPath) {
  const child = spawn(process.execPath, [scriptPath], { stdio: 'ignore' });
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

test('killIfMatches 只终止命令行匹配的进程', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pages-process-utils-'));
  const script = path.join(root, 'task-worker-orphan.js');
  await fs.promises.writeFile(script, 'setTimeout(() => {}, 30000);\n');
  const child = await spawnIdle(script);
  const exitPromise = new Promise((resolve) => child.once('exit', resolve));
  try {
    const command = await readCommand(child.pid);
    assert.ok(command && command.includes('task-worker-orphan.js'));
    assert.equal(await isAlive(child.pid), true);
    const mismatch = await killIfMatches(child.pid, ['backend-runner.js'], { graceMs: 100 });
    assert.deepEqual(mismatch, { killed: false, reason: 'marker-mismatch' });
    assert.equal(await isAlive(child.pid), true);
    const killed = await killIfMatches(child.pid, ['task-worker-orphan.js'], { graceMs: 200 });
    assert.equal(killed.killed, true);
    await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('killIfMatches 拒绝无效 PID 与自身 PID', async () => {
  assert.deepEqual(await killIfMatches(0, ['x']), { killed: false, reason: 'invalid-pid' });
  assert.deepEqual(await killIfMatches(process.pid, ['node']), { killed: false, reason: 'self' });
  const missing = await killIfMatches(2 ** 30, ['node']);
  assert.equal(missing.killed, false);
});
