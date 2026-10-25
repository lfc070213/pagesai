'use strict';
// C14 正式数据面配置边界：不连数据库，只验证归一化与拒绝策略。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { normalizeConfig, REGION } = require(path.join(__dirname, '..', 'server', 'platform.js'));

test('Disk 正式配置：只允许 disk.user-files 区域，默认值稳定', () => {
  const config = normalizeConfig({});
  assert.equal(config.regionId, REGION);
  assert.equal(config.regionId, 'disk.user-files');
  assert.equal(config.quotaBytes, 1024 * 1024 * 1024);
  assert.equal(config.chunkSizeBytes, 5 * 1024 * 1024);
  assert.equal(config.maxChunkBytes, 64 * 1024 * 1024);
  assert.equal(config.shareDefaultTtlSeconds, 24 * 60 * 60);
  assert.equal(config.shareMaxTtlSeconds, 30 * 24 * 60 * 60);
  assert.equal(config.uploadTtlMs, 24 * 60 * 60 * 1000);
  assert.deepEqual(normalizeConfig({ regions: ['disk.user-files'] }).regionId, REGION);
});

test('Disk 正式配置：非法数值、未知区域与越界分享有效期均拒绝', () => {
  assert.throws(() => normalizeConfig({ quotaBytes: 0 }), (error) => error.code === 'CONFIG_INVALID');
  assert.throws(() => normalizeConfig({ chunkSizeBytes: 65 * 1024 * 1024 }), (error) => error.code === 'CONFIG_INVALID');
  assert.throws(() => normalizeConfig({ chunkSizeBytes: 9, maxChunkBytes: 8 }), (error) => error.code === 'CONFIG_INVALID');
  assert.throws(() => normalizeConfig({ regions: ['disk.other'] }), (error) => error.code === 'CONFIG_INVALID');
  assert.throws(() => normalizeConfig({ share: { defaultTtlSeconds: 120, maxTtlSeconds: 60 } }), (error) => error.code === 'CONFIG_INVALID');
  assert.throws(() => normalizeConfig({ share: { maxTtlSeconds: 0 } }), (error) => error.code === 'CONFIG_INVALID');
  assert.throws(() => normalizeConfig({ uploadTtlMs: 1000 }), (error) => error.code === 'CONFIG_INVALID');
});

test('Disk 正式配置：自定义值原样归一化为整数', () => {
  const config = normalizeConfig({
    quotaBytes: '2048', chunkSizeBytes: '1024', maxChunkBytes: '4096', maxFileBytes: '512',
    share: { defaultTtlSeconds: 60, maxTtlSeconds: 120 }, uploadTtlMs: 120000,
    regions: ['disk.user-files']
  });
  assert.equal(config.quotaBytes, 2048);
  assert.equal(config.chunkSizeBytes, 1024);
  assert.equal(config.maxChunkBytes, 4096);
  assert.equal(config.maxFileBytes, 512);
  assert.equal(config.shareDefaultTtlSeconds, 60);
  assert.equal(config.shareMaxTtlSeconds, 120);
  assert.equal(config.uploadTtlMs, 120000);
});
