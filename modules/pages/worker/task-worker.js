'use strict';

const { generate } = require('./model-adapters.js');

let started = false;
let abort = null;

async function emit(event, data) {
  if (!process.send || !process.connected) return;
  await new Promise((resolve) => process.send({ type: 'event', event, data }, resolve));
}

async function run(payload) {
  if (started) return;
  started = true;
  const controller = new AbortController();
  abort = () => controller.abort(new Error('TASK_CANCELLED'));
  const apiKey = process.env.PAGESAI_TASK_MODEL_KEY || null;
  delete process.env.PAGESAI_TASK_MODEL_KEY;
  try {
    if (!payload || !payload.model || !payload.prompt || !payload.site) throw new Error('TASK_PAYLOAD_INVALID');
    const result = await generate(payload, payload.model, {
      apiKey,
      allowTestModel: process.env.PAGESAI_ALLOW_TEST_MODEL === '1',
      emit,
      signal: controller.signal
    });
    if (process.send && process.connected) {
      await new Promise((resolve) => process.send({ type: 'result', result }, resolve));
    }
    process.exitCode = 0;
  } catch (error) {
    const code = error && error.name === 'AbortError' ? 'TASK_CANCELLED' : String(error && error.message || 'MODEL_FAILED').slice(0, 120);
    if (process.send && process.connected) {
      await new Promise((resolve) => process.send({ type: 'error', error: { code, message: '任务执行失败', failed: true } }, resolve));
    }
    process.exitCode = 1;
  } finally {
    if (process.send) process.disconnect();
  }
}

process.once('message', (message) => {
  if (message && message.type === 'run') run(message.payload).catch(() => { process.exitCode = 1; });
});
process.on('SIGTERM', () => { if (abort) abort(); else process.exit(143); });
process.on('SIGINT', () => { if (abort) abort(); else process.exit(130); });
// 宿主异常退出时 IPC 通道断开：worker 必须自行结束，不能成为遗留进程继续占用资源。
process.on('disconnect', () => {
  if (abort) abort();
  setTimeout(() => process.exit(1), 200).unref();
});

const keepAlive = setInterval(() => {}, 1000);
keepAlive.unref();
