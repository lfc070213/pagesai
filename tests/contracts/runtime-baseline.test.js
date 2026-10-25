'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const topology = JSON.parse(fs.readFileSync(path.join(root, 'contracts/runtime-topology.json'), 'utf8'));
const configSchema = JSON.parse(fs.readFileSync(path.join(root, 'config/config.schema.json'), 'utf8'));
const contractText = fs.readFileSync(path.join(root, 'contracts/runtime-contracts.md'), 'utf8');

test('C03 拓扑固定 Node Glim，不虚构独立 Python 服务', () => {
  assert.equal(topology.contractVersion, 1);
  assert.equal(topology.status, 'contract-frozen-entrypoints-implemented');
  assert.equal(topology.moduleRuntime.hostLanguage, 'node');
  assert.equal(topology.moduleRuntime.glimLanguage, 'node');
  assert.equal(topology.moduleRuntime.independentPythonGlimService, false);
});

test('C03 必要进程和按需 worker 明确，MongoDB 不暴露公网端口', () => {
  const units = new Map(topology.units.map((unit) => [unit.id, unit]));
  for (const id of ['gateway', 'app', 'mongodb', 'execution-worker']) assert.ok(units.has(id), id);
  assert.equal(units.get('app').runtime, 'node');
  assert.equal(units.get('mongodb').network.publicPort, false);
  assert.equal(units.get('mongodb').highAvailability, false);
  assert.deepEqual(units.get('execution-worker').requiredWhenModules, ['pages', 'glim']);
  assert.equal(topology.moduleRuntime.diskSplitMayCreateSecondAuthority, false);
});

test('C03 配置事实源包含模块、注册、Disk、区域和秘密引用', () => {
  for (const key of ['modules', 'registration', 'disk', 'storage', 'regions', 'database', 'secrets']) {
    assert.ok(configSchema.required.includes(key), key);
    assert.ok(configSchema.properties[key], key);
  }
  assert.deepEqual(configSchema.properties.modules.items.enum, ['pages', 'disk', 'glim', 'mail', 'survey', 'paper']);
  assert.equal(configSchema.properties.database.properties.engine.const, 'mongodb');
  assert.equal(topology.configuration.schema, 'config/config.schema.json');
  assert.equal(topology.configuration.schemaVersion, configSchema.properties.schemaVersion.const);
});

test('C03 构建隔离与生产连接禁止项是机器可核对声明', () => {
  assert.equal(topology.buildIsolation.dependenciesInsideSharedSourceTree, false);
  assert.equal(topology.buildIsolation.containerContextInsideSharedSourceTree, false);
  assert.equal(topology.buildIsolation.productionCredentialsAllowed, false);
  assert.equal(topology.buildIsolation.productionNetworkDefault, false);
  for (const forbidden of ['production-env', 'development-identity-headers', 'silent-in-memory-production-store']) {
    assert.ok(topology.configuration.forbiddenFallbacks.includes(forbidden));
  }
});

test('C03 异步适配器、HTTP 类型、取消和禁止身份头均已写入契约', () => {
  for (const text of ['await store.withTransaction', 'await content.openRead', 'await changes.commitFileOperation']) {
    assert.ok(contractText.includes(text), text);
  }
  for (const kind of ['json', 'binary', 'upload', 'download', 'sse']) assert.ok(contractText.includes(kind), kind);
  assert.match(contractText, /x-\*-user-id/);
  assert.match(contractText, /不得重复产生副作用/);
  assert.match(contractText, /内存\/JSON 适配器只在测试/);
});
