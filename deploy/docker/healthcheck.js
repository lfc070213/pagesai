#!/usr/bin/env node
'use strict';
// 容器健康检查：同时请求 /healthz 与 /readyz（C30）。
//
// 端口只从 config.json 读取；PAGESAI_PORT 仅用于确认与配置一致。
// 退出码：0 = 两个端点都返回 2xx 且 body.ok=true；1 = 不健康或配置不可读；2 = 用法错误。

const fs = require('node:fs');
const path = require('node:path');

const TIMEOUT_MS = 3000;

function helpText() {
  return [
    'PagesAI 容器健康检查（deploy/docker/healthcheck.js）',
    '',
    '用法：',
    '  node deploy/docker/healthcheck.js [--config /data/config.json]',
    '',
    '环境变量：',
    '  PAGESAI_CONFIG  配置文件路径，默认 /data/config.json',
    '  PAGESAI_PORT    可选；设置时必须与 config.port 一致',
    '',
    '检查 GET /healthz 与 GET /readyz；任一失败即退出 1。'
  ].join('\n');
}

function parseArgs(argv) {
  let configPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--config') {
      configPath = argv[index + 1];
      if (!configPath) throw new Error('--config 需要一个路径');
      index += 1;
    } else if (arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return { configPath };
}

async function probe(port, endpoint) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json' }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${endpoint} 返回 HTTP ${response.status}`);
  if (!body || body.ok !== true) throw new Error(`${endpoint} 未返回 {"ok":true}`);
  return { endpoint, status: response.status };
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  const configPath = path.resolve(options.configPath || process.env.PAGESAI_CONFIG || '/data/config.json');
  let document;
  try {
    document = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取配置 ${configPath}：${error.message}`);
  }
  const port = Number(document.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`config.port 非法：${document.port}`);
  if (process.env.PAGESAI_PORT && Number(process.env.PAGESAI_PORT) !== port) {
    throw new Error(`PAGESAI_PORT=${process.env.PAGESAI_PORT} 与 config.port=${port} 不一致`);
  }
  const results = [];
  for (const endpoint of ['/healthz', '/readyz']) results.push(await probe(port, endpoint));
  process.stdout.write(`${JSON.stringify({ ok: true, port, checks: results })}\n`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, message: error.message || '健康检查失败' })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, probe };
