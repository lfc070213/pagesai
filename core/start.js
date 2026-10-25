#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { startRuntime } = require('./runtime.js');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  const configPath = argument('--config');
  const runtime = await startRuntime({
    configPath: configPath ? path.resolve(configPath) : null,
    port: argument('--port') ? Number(argument('--port')) : undefined,
    host: argument('--host') || '127.0.0.1'
  });
  process.stdout.write(`${JSON.stringify({ url: runtime.url, modules: runtime.config.installedModules })}\n`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await runtime.app.close();
  };
  process.once('SIGINT', () => close().then(() => { process.exitCode = 0; }));
  process.once('SIGTERM', () => close().then(() => { process.exitCode = 0; }));
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ code: error.code || 'START_FAILED', message: error.message || '启动失败' })}\n`);
  process.exitCode = 1;
});
