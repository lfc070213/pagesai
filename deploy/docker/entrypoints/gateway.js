#!/usr/bin/env node
'use strict';
// PagesAI 网关进程入口（C30 / C06）。
//
// 职责：
//  1. 作为唯一对外 HTTP 入口，把请求流式转发给 app（默认 http://app:8080）；
//  2. 不缓冲请求/响应正文：上传、下载、Range、SSE 全部走 pipe，背压由 Node 流保证；
//  3. 客户端断开时立即销毁上游请求，取消继续读取与执行；
//  4. 可选 TLS 终止：同时提供 PAGESAI_GATEWAY_TLS_CERT / PAGESAI_GATEWAY_TLS_KEY 时监听 HTTPS；
//  5. 只信任自己写入的 X-Forwarded-* 头；不转发 hop-by-hop 头；
//  6. --check 只做离线校验（上游 URL、端口、TLS 文件是否存在），不监听端口。
//
// 用法：
//   node deploy/docker/entrypoints/gateway.js [--listen-port 8080] [--upstream http://app:8080] [--host 0.0.0.0]
//   node deploy/docker/entrypoints/gateway.js --check
//   node deploy/docker/entrypoints/gateway.js --help

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const SHUTDOWN_TIMEOUT_MS = 20000;
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

class GatewayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new GatewayError(code, message);
}

function parseArgs(argv) {
  const options = { listenPort: null, upstream: null, host: null, check: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--check') {
      options.check = true;
    } else if (arg === '--listen-port' || arg === '--upstream' || arg === '--host') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail('GATEWAY_USAGE', `${arg} 需要一个值`);
      options[arg === '--listen-port' ? 'listenPort' : arg.slice(2)] = value;
      index += 1;
    } else if (arg.startsWith('--listen-port=') || arg.startsWith('--upstream=') || arg.startsWith('--host=')) {
      const separator = arg.indexOf('=');
      const key = arg.slice(2, separator);
      options[key === 'listen-port' ? 'listenPort' : key] = arg.slice(separator + 1);
    } else {
      fail('GATEWAY_USAGE', `未知参数：${arg}（用 --help 查看用法）`);
    }
  }
  return options;
}

function helpText() {
  return [
    'PagesAI 网关进程入口（deploy/docker/entrypoints/gateway.js）',
    '',
    '用法：',
    '  node deploy/docker/entrypoints/gateway.js [--listen-port <端口>] [--upstream <URL>] [--host <地址>]',
    '  node deploy/docker/entrypoints/gateway.js --check',
    '',
    '环境变量：',
    '  PAGESAI_GATEWAY_PORT        监听端口，默认 8080',
    '  PAGESAI_GATEWAY_HOST        监听地址，默认 0.0.0.0',
    '  PAGESAI_GATEWAY_UPSTREAM    上游地址，默认 http://127.0.0.1:8080',
    '  PAGESAI_GATEWAY_TLS_CERT    PEM 证书路径；与 KEY 同时提供时启用 HTTPS',
    '  PAGESAI_GATEWAY_TLS_KEY     PEM 私钥路径；不得写入镜像或仓库',
    '',
    '网关不读取 config.json：上游地址与端口来自部署编排，业务配置仍只由 app 读取。'
  ].join('\n');
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('GATEWAY_PORT_INVALID', `端口必须是 1-65535 的整数：${value}`);
  return port;
}

function normalizeUpstream(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    fail('GATEWAY_UPSTREAM_INVALID', `上游地址不是合法 URL：${value}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) fail('GATEWAY_UPSTREAM_INVALID', '上游地址必须是 http:// 或 https://');
  if (!url.hostname) fail('GATEWAY_UPSTREAM_INVALID', '上游地址缺少主机名');
  return { url, basePath: url.pathname.replace(/\/+$/, '') };
}

function tlsOptions(env) {
  const cert = env.PAGESAI_GATEWAY_TLS_CERT;
  const key = env.PAGESAI_GATEWAY_TLS_KEY;
  if (!cert && !key) return null;
  if (!cert || !key) fail('GATEWAY_TLS_INCOMPLETE', 'TLS 需要同时提供 PAGESAI_GATEWAY_TLS_CERT 与 PAGESAI_GATEWAY_TLS_KEY');
  if (!fs.existsSync(cert)) fail('GATEWAY_TLS_UNREADABLE', `证书文件不存在：${cert}`);
  if (!fs.existsSync(key)) fail('GATEWAY_TLS_UNREADABLE', `私钥文件不存在：${key}`);
  return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
}

/** 解析运行参数；--check 与真实启动共用，避免两套默认值分叉。 */
function resolveOptions(argv, env = process.env) {
  const args = parseArgs(argv);
  const listenPort = normalizePort(args.listenPort || env.PAGESAI_GATEWAY_PORT || 8080);
  const host = args.host || env.PAGESAI_GATEWAY_HOST || '0.0.0.0';
  const upstream = normalizeUpstream(args.upstream || env.PAGESAI_GATEWAY_UPSTREAM || 'http://127.0.0.1:8080');
  const tls = tlsOptions(env);
  return { listenPort, host, upstream, tls };
}

// 客户端自带的 X-Forwarded-* 一律覆盖而不是追加：网关是本部署的第一跳，
// 直接采信客户端声明会让上游把伪造地址当成真实来源。
function forwardedFor(req) {
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
}

function upstreamHeaders(req, upstream) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  headers['x-forwarded-for'] = forwardedFor(req);
  headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http';
  if (req.headers.host) headers['x-forwarded-host'] = req.headers.host;
  if (req.socket && req.socket.remoteAddress) headers['x-real-ip'] = req.socket.remoteAddress;
  // Host 保留客户端原始值（公开访问地址），连接目标由 URL 决定。
  if (req.headers.host) headers.host = req.headers.host;
  return headers;
}

function responseHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
}

function gatewayError(res, status, code, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ ok: false, code, message });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

function createGateway(options) {
  const { listenPort, host, upstream, tls } = options;
  const transport = upstream.url.protocol === 'https:' ? https : http;
  const active = new Set();
  let server = null;

  function proxy(req, res) {
    const target = new URL(`${upstream.basePath}${req.url}`.replace(/\/{2,}/g, '/'), upstream.url);
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: upstreamHeaders(req, upstream)
    }, (response) => {
      if (res.destroyed) {
        response.destroy();
        return;
      }
      res.writeHead(response.statusCode || 502, response.statusMessage, responseHeaders(response.headers));
      res.flushHeaders();
      response.pipe(res);
      response.on('error', () => res.destroy());
    });

    active.add(request);
    const settle = () => active.delete(request);
    request.on('close', settle);
    request.on('error', (error) => {
      settle();
      gatewayError(res, 502, 'GATEWAY_UPSTREAM_UNAVAILABLE', `上游不可用：${error.code || error.message}`);
    });
    res.on('close', () => {
      if (!res.writableFinished) request.destroy();
    });
    req.on('error', () => request.destroy());
    req.pipe(request);
  }

  function closeIdle() {
    if (server) server.closeIdleConnections();
  }

  async function listen() {
    const handler = (req, res) => proxy(req, res);
    server = tls ? https.createServer(tls, handler) : http.createServer(handler);
    server.on('clientError', (error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenPort, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return { server, port: server.address().port, host };
  }

  async function close() {
    if (!server) return;
    closeIdle();
    for (const request of active) request.destroy();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (server) server.closeAllConnections();
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);
      timer.unref();
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  return { listen, close, options: { listenPort, host, upstream: upstream.url.toString(), tls: Boolean(tls) } };
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  const options = resolveOptions(argv);
  const summary = {
    ok: true,
    check: 'gateway',
    listenPort: options.listenPort,
    host: options.host,
    upstream: options.upstream.url.toString(),
    tls: Boolean(options.tls)
  };
  if (argv.includes('--check')) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return 0;
  }
  const gateway = createGateway(options);
  const listening = await gateway.listen();
  process.stdout.write(`${JSON.stringify({ event: 'listening', ...summary, port: listening.port })}\n`);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) {
      process.stderr.write(`${JSON.stringify({ event: 'forced-exit', signal })}\n`);
      process.exit(1);
    }
    stopping = true;
    try {
      await gateway.close();
      process.stdout.write(`${JSON.stringify({ event: 'stopped', signal })}\n`);
      process.exit(0);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ event: 'shutdown-failed', message: error.message })}\n`);
      process.exit(1);
    }
  };
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => { shutdown(signal).catch(() => process.exit(1)); });
  }
  return null;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ code: error.code || 'GATEWAY_FAILED', message: error.message || '网关启动失败' })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  parseArgs,
  resolveOptions,
  createGateway,
  HOP_BY_HOP
};