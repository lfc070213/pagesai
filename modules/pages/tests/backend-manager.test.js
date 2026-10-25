'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BackendManager, TENANT_CSP,
  validateListeningMessage, sanitizeRequestHeaders, sanitizeResponseHeaders, allocatePort
} = require('../server/backend-manager.js');

const syntheticCredential = ['admin', 'synthetic'].join(':');

const managerConfig = {
  databaseName: 'pagesai',
  mongodbUri: `mongodb://${syntheticCredential}@db.example:27017/pagesai?replicaSet=rs0`,
  tenantMongoUri: null,
  backendRuntimeRoot: '/tmp/pages-backend-test',
  backendMemoryMB: 64,
  backendSourceBytes: 1024 * 1024,
  backendStartTimeoutMs: 5000,
  backendProxyTimeoutMs: 10000
};

function manager(overrides = {}) {
  return new BackendManager({
    repository: {}, files: {},
    config: { ...managerConfig, ...overrides },
    logger: { info() {}, warn() {}, error() {} }
  });
}

test('只接受与预分配端口一致的回环监听报告', () => {
  assert.equal(validateListeningMessage({ type: 'listening', port: 32123 }, 32123), 32123);
  assert.equal(validateListeningMessage({ type: 'listening', port: 32123 }, 32124), null);
  assert.equal(validateListeningMessage({ type: 'listening', port: 80 }, null), null);
  assert.equal(validateListeningMessage({ type: 'listening', port: 70000 }, null), null);
  assert.equal(validateListeningMessage({ type: 'listening', port: '32123' }, null), null);
  assert.equal(validateListeningMessage({ type: 'other', port: 32123 }, 32123), null);
  assert.equal(validateListeningMessage(null, 32123), null);
});

test('转发到租户的请求头不含管理面凭据与转发链', () => {
  const headers = sanitizeRequestHeaders({
    Host: 'pagesai.cn',
    Cookie: 'session=secret',
    Authorization: 'Bearer secret',
    'X-Forwarded-For': '203.0.113.9',
    'X-Pages-Signature': 'sig',
    'Proxy-Authorization': 'Basic secret',
    'Content-Type': 'application/json',
    Accept: '*/*'
  });
  assert.deepEqual(headers, { 'content-type': 'application/json', accept: '*/*' });
});

test('租户响应丢失 Set-Cookie 且 HTML 追加沙箱 CSP', () => {
  const html = sanitizeResponseHeaders({
    'Content-Type': 'text/html; charset=utf-8',
    'Set-Cookie': ['session=tenant; Path=/'],
    'Transfer-Encoding': 'chunked'
  });
  assert.equal(html['set-cookie'], undefined);
  assert.equal(html['transfer-encoding'], undefined);
  assert.equal(html['content-security-policy'], TENANT_CSP);
  assert.equal(html['x-frame-options'], 'DENY');
  assert.equal(html['x-content-type-options'], 'nosniff');

  const json = sanitizeResponseHeaders({ 'Content-Type': 'application/json', 'Set-Cookie': 'a=b' });
  assert.equal(json['content-security-policy'], undefined);
  assert.equal(json['set-cookie'], undefined);
  assert.equal(json['x-content-type-options'], 'nosniff');
});

test('租户数据库连接串默认剥离主库凭据', () => {
  const url = new URL(manager().tenantDatabaseUrl('pagesai_tenant_abc'));
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.pathname, '/pagesai_tenant_abc');
  assert.equal(url.searchParams.get('replicaSet'), 'rs0');
});

test('显式配置租户专用凭据时才随连接串下发', () => {
  const url = new URL(manager({ tenantMongoUri: `mongodb://${syntheticCredential}@db.example:27017/x` }).tenantDatabaseUrl('pagesai_tenant_abc'));
  assert.equal(url.username, 'admin');
  assert.equal(url.password, 'synthetic');
  assert.equal(url.pathname, '/pagesai_tenant_abc');
});

test('端口分配返回可用回环端口', async () => {
  const port = await allocatePort();
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
});
