'use strict';

const net = require('node:net');
const path = require('node:path');

const entry = process.argv[2];
if (!entry || !path.isAbsolute(entry)) process.exit(2);

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const expectedPort = Number(process.env.PORT);

/**
 * 租户入口只允许监听回环地址。
 * 覆盖默认 host（Node 默认监听所有接口），并拒绝显式绑定非回环地址。
 */
function enforceLoopback(args) {
  if (args.length === 0) return args;
  const [first, ...rest] = args;
  if (first && typeof first === 'object') {
    if (first.path !== undefined) throw new Error('租户后端不支持 Unix socket 监听');
    const host = typeof first.host === 'string' ? first.host : '127.0.0.1';
    if (!LOOPBACK.has(host)) throw new Error('租户后端只允许绑定回环地址');
    return [{ ...first, host: '127.0.0.1' }, ...rest];
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    const host = typeof rest[0] === 'string' ? rest[0] : '127.0.0.1';
    if (!LOOPBACK.has(host)) throw new Error('租户后端只允许绑定回环地址');
    return [first, '127.0.0.1', ...rest.slice(1)];
  }
  return args;
}

const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function patchedListen(...args) {
  const server = originalListen.apply(this, enforceLoopback(args));
  server.once('listening', () => {
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : null;
    if (!Number.isInteger(port) || (Number.isInteger(expectedPort) && expectedPort > 0 && port !== expectedPort)) {
      if (process.send && process.connected) process.send({ type: 'error', code: 'TENANT_PORT_MISMATCH' });
      process.exit(3);
    }
    if (process.send && process.connected) process.send({ type: 'listening', port });
  });
  return server;
};

process.on('SIGTERM', () => {
  if (process.send && process.connected) process.send({ type: 'stopping' }, () => process.exit(0));
  else process.exit(0);
});
// 宿主异常退出时 IPC 断开：runner 及其租户代码随之退出，避免遗留后台进程。
process.on('disconnect', () => process.exit(0));

try {
  require(entry);
} catch (error) {
  if (process.send && process.connected) process.send({ type: 'error', code: 'TENANT_BOOT_FAILED' });
  process.exitCode = 1;
}
