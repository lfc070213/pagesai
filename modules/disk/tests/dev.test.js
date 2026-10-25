'use strict';
// 开发服务器纯函数测试：路由匹配与环境配置解析。
// 按施工要求，功能测试不启动 HTTP；dev.js 的 --once 启动由 README 中的命令单独冒烟。

const test = require('node:test');

const { assert, disk } = require('./helpers');
const { matchRoute, configFromEnv, parseArgs } = require('../server/dev.js');

test('dev 路由匹配支持 :param 与 HEAD 映射', () => {
  const matched = matchRoute('PUT', '/api/disk/uploads/upl_0123456789abcdef/chunks/2');
  assert.ok(matched);
  assert.equal(matched.route.path, '/api/disk/uploads/:uploadId/chunks/:index');
  assert.equal(matched.params.uploadId, 'upl_0123456789abcdef');
  assert.equal(matched.params.index, '2');
  assert.equal(matched.head, false);

  const head = matchRoute('HEAD', '/api/disk/health');
  assert.ok(head);
  assert.equal(head.route.method, 'GET');
  assert.equal(head.head, true);

  assert.equal(matchRoute('GET', '/api/disk/not-found'), null);
  assert.equal(matchRoute('POST', '/api/disk/health'), null);
});

test('dev 路由表与模块导出完全一致，且没有重复项', () => {
  const seen = new Set();
  for (const route of disk.routes) {
    const matched = matchRoute(route.method, route.path.replace(/:[^/]+/g, 'x'));
    assert.ok(matched, `${route.method} ${route.path} 未被 dev 匹配`);
    assert.equal(matched.route.path, route.path);
    const key = `${route.method} ${route.path}`;
    assert.equal(seen.has(key), false);
    seen.add(key);
  }
});

test('dev 环境变量解析：只接受合法整数，空值忽略', () => {
  const config = configFromEnv({
    DISK_DATA_FILE: ' /tmp/disk.json ',
    DISK_REGIONS: 'disk.user-files',
    DISK_QUOTA_BYTES: '2048',
    DISK_CHUNK_BYTES: '1024',
    DISK_MAX_CHUNK_BYTES: '4096',
    DISK_MAX_FILE_BYTES: '0',
    DISK_STORAGE_ADAPTER: 'json'
  });
  assert.equal(config.dataFile, '/tmp/disk.json');
  assert.deepEqual(config.regions, ['disk.user-files']);
  assert.equal(config.quotaBytes, 2048);
  assert.equal(config.chunkSizeBytes, 1024);
  assert.equal(config.maxChunkBytes, 4096);
  assert.equal(config.maxFileBytes, 0);
  assert.equal(config.storageAdapter, 'json');

  assert.deepEqual(configFromEnv({ DISK_DATA_FILE: '', DISK_REGIONS: '' }), {});
  assert.throws(() => configFromEnv({ DISK_QUOTA_BYTES: 'abc' }), (err) => err.code === 'CONFIG_INVALID');
  assert.throws(() => configFromEnv({ DISK_QUOTA_BYTES: '-1' }), (err) => err.code === 'CONFIG_INVALID');
});

test('dev 命令行参数解析：--once 与 --data-file', () => {
  assert.deepEqual(parseArgs(['--once', '--data-file', '/tmp/disk.json']), {
    once: true,
    help: false,
    dataFile: '/tmp/disk.json'
  });
  assert.deepEqual(parseArgs(['--data-file=/tmp/disk.json']), {
    once: false,
    help: false,
    dataFile: '/tmp/disk.json'
  });
  assert.deepEqual(parseArgs(['--help']), { once: false, help: true, dataFile: null });
  assert.throws(() => parseArgs(['--data-file']), (err) => err.code === 'CONFIG_INVALID');
  assert.throws(() => parseArgs(['--unknown']), (err) => err.code === 'CONFIG_INVALID');
});
