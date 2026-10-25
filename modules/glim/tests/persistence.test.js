'use strict';
// 持久化测试：dataFile 由 JsonStore 承载；省略 dataFile 时纯内存；损坏文件拒绝启动。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  moduleEntry,
  silentLogger,
  alice,
  call,
  withModule,
  echoAdapter
} = require('./support.js');

async function startFile(dataFile) {
  await moduleEntry.stop();
  await moduleEntry.start({ config: { dataFile, chatAdapter: echoAdapter }, logger: silentLogger });
}

test('dataFile 持久化：会话、消息、记忆、connector 与授权跨重启保留，文件权限 0600', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glim-persist-'));
  const dataFile = path.join(dir, 'nested', 'glim.json');
  try {
    await startFile(dataFile);
    const created = await call('POST', '/api/glim/sessions', { user: alice, body: { title: '持久会议' } });
    const sessionId = created.body.session.id;
    await call('POST', `/api/glim/sessions/${sessionId}/messages`, { user: alice, body: { content: '重启后还在吗' } });
    await call('PUT', '/api/glim/memory', { user: alice, body: { content: '长期记忆' } });
    const connector = await call('POST', '/api/glim/connectors', {
      user: alice,
      body: {
        endpoint: 'https://pages.example.test/api',
        capabilities: [{ name: 'pages_list_sites', access: 'read', implemented: true, version: '1.0.0' }]
      }
    });
    assert.equal(connector.status, 201);
    await call('POST', `/api/glim/connectors/${connector.body.connector.id}/grant`, { user: alice, body: {} });

    await moduleEntry.stop();
    assert.equal(fs.existsSync(dataFile), true, 'JsonStore 应在写入时创建目录与文件');
    assert.equal(fs.statSync(dataFile).mode & 0o777, 0o600);

    await startFile(dataFile);
    const sessions = await call('GET', '/api/glim/sessions', { user: alice });
    assert.equal(sessions.body.sessions.length, 1);
    assert.equal(sessions.body.sessions[0].title, '持久会议');

    const messages = await call('GET', `/api/glim/sessions/${sessionId}/messages`, { user: alice });
    assert.equal(messages.body.messages.length, 2);
    assert.equal(messages.body.messages[1].content, 'echo:重启后还在吗');

    const memory = await call('GET', '/api/glim/memory', { user: alice });
    assert.equal(memory.body.content, '长期记忆');

    const connectors = await call('GET', '/api/glim/connectors', { user: alice });
    assert.equal(connectors.body.connectors.length, 1);
    assert.equal(connectors.body.connectors[0].granted, true);
    assert.deepEqual(connectors.body.connectors[0].grant.capabilities, ['pages_list_sites']);

    const tools = await call('GET', '/api/glim/tools', { user: alice });
    assert.deepEqual(tools.body.tools.map((tool) => tool.name), ['pages_list_sites']);
  } finally {
    await moduleEntry.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('省略 dataFile 时纯内存：stop/start 后不保留业务数据', async () => {
  await withModule({ chatAdapter: echoAdapter }, async () => {
    const created = await call('POST', '/api/glim/sessions', { user: alice, body: { title: '内存会话' } });
    assert.equal(created.status, 201);
    const sessions = await call('GET', '/api/glim/sessions', { user: alice });
    assert.equal(sessions.body.sessions.length, 1);
  });

  await withModule({}, async () => {
    const sessions = await call('GET', '/api/glim/sessions', { user: alice });
    assert.deepEqual(sessions.body.sessions, []);
  });
});

test('损坏的 JsonStore 文件拒绝启动，不静默重建空库', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glim-corrupt-'));
  const dataFile = path.join(dir, 'glim.json');
  fs.writeFileSync(dataFile, '{not-json', 'utf8');
  await moduleEntry.stop();
  try {
    await assert.rejects(
      () => moduleEntry.start({ config: { dataFile }, logger: silentLogger }),
      (err) => err instanceof SyntaxError || /JSON|格式|Unexpected/i.test(String(err && err.message))
    );
    assert.equal(fs.readFileSync(dataFile, 'utf8'), '{not-json', '启动失败不得覆盖原文件');
  } finally {
    await moduleEntry.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
