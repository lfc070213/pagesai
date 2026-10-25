'use strict';
// 子进程孤儿清理工具。
// 只终止命令行中明确包含本模块入口文件名的进程，避免 PID 复用误杀无关进程。

const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);

async function readCommand(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const raw = await fs.promises.readFile(`/proc/${pid}/cmdline`);
      return raw.toString('utf8').split('\u0000').filter(Boolean).join(' ');
    }
    const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'command='], { timeout: 2000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error && error.code === 'EPERM'; }
}

/**
 * 终止一个命令行包含任一 marker 的遗留进程。
 * 返回 { killed, reason }；marker 不匹配时绝不发送信号。
 */
async function killIfMatches(pid, markers, { graceMs = 500 } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { killed: false, reason: 'invalid-pid' };
  if (pid === process.pid) return { killed: false, reason: 'self' };
  const command = await readCommand(pid);
  if (!command) return { killed: false, reason: 'not-found' };
  const wanted = markers.filter((marker) => typeof marker === 'string' && marker.length > 0);
  if (!wanted.some((marker) => command.includes(marker))) return { killed: false, reason: 'marker-mismatch' };
  try { process.kill(pid, 'SIGTERM'); }
  catch (error) { return { killed: false, reason: error.code || 'signal-failed' }; }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!await isAlive(pid)) return { killed: true, reason: 'sigterm' };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
  return { killed: true, reason: 'sigkill' };
}

module.exports = { readCommand, isAlive, killIfMatches };
