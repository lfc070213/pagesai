#!/usr/bin/env node
'use strict';
// 网关容器健康检查（C30）：经网关自身访问 /healthz 与 /readyz。
// 使用 PAGESAI_GATEWAY_PORT（默认 8080）构造回环地址，不读取业务配置。

const port = Number(process.env.PAGESAI_GATEWAY_PORT || 8080);
const base = process.env.PAGESAI_GATEWAY_HEALTH_URL || `http://127.0.0.1:${port}`;

async function check(pathname) {
  const response = await fetch(`${base}${pathname}`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`${pathname} 返回 ${response.status}`);
  const body = await response.json();
  if (body.ok !== true) throw new Error(`${pathname} 响应 ok 不为 true`);
}

Promise.all(['/healthz', '/readyz'].map(check))
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`网关健康检查失败：${error.message}\n`);
    process.exit(1);
  });