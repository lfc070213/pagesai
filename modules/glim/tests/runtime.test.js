'use strict';
// C20–C25：工作区隔离、模块发现状态、真实连接器接入、任务停止/恢复与审计。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  moduleEntry,
  silentLogger,
  alice,
  bob,
  call,
  withModule,
  expectError
} = require('./support.js');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function waitFor(fn, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const value = await fn();
        if (value) return resolve(value);
      } catch (error) {
        return reject(error);
      }
      if (Date.now() - started > timeoutMs) return reject(new Error('等待超时'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function installTool(name, fn) {
  const had = Object.prototype.hasOwnProperty.call(moduleEntry.tools, name);
  const previous = moduleEntry.tools[name];
  moduleEntry.tools[name] = fn;
  return () => {
    if (had) moduleEntry.tools[name] = previous;
    else delete moduleEntry.tools[name];
  };
}

function startDirectoryServer(payload) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/modules') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'not_found' }));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('模块连接：能力由本机声明，不接受请求体覆盖；重复登记返回既有连接', async () => {
  await withModule({ moduleDirectoryUrl: 'https://pages.example.test' }, async () => {
    const created = await call('POST', '/api/glim/connectors/from-module', {
      user: alice,
      body: { moduleId: 'pages', grant: true }
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const connector = created.body.connector;
    assert.equal(connector.moduleId, 'pages');
    assert.equal(connector.endpoint, 'https://pages.example.test/api/pages');
    assert.equal(connector.granted, true);
    assert.ok(connector.capabilities.every((item) => item.implemented === true));
    assert.ok(connector.capabilities.some((item) => item.name === 'pages_list_sites'));

    const again = await call('POST', '/api/glim/connectors/from-module', {
      user: alice,
      body: { moduleId: 'pages' }
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.existing, true);
    assert.equal(again.body.connector.id, connector.id);

    const tools = await call('GET', '/api/glim/tools', { user: alice });
    const pagesTool = tools.body.tools.find((item) => item.name === 'pages_list_sites');
    assert.equal(pagesTool.adapterReady, true, '显式 moduleId 应解析到本机真实适配器');
    assert.equal(pagesTool.moduleId, 'pages');

    expectError(
      await call('POST', '/api/glim/connectors/from-module', {
        user: alice,
        body: { moduleId: 'unknown' }
      }),
      400,
      'glim.invalid_input'
    );
    expectError(
      await call('POST', '/api/glim/connectors', {
        user: alice,
        body: {
          endpoint: 'https://pages.example.test/api/pages',
          moduleId: 'pages',
          capabilities: [{ name: 'pages_list_sites', access: 'read', implemented: true }]
        }
      }),
      400,
      'glim.invalid_input'
    );
  });
});

test('模块发现：未配置时给出明确状态；配置后按版本/安装/配置/就绪/授权计算', async () => {
  await withModule({}, async () => {
    const off = await call('GET', '/api/glim/discovery', { user: alice });
    assert.equal(off.status, 200);
    assert.equal(off.body.configured, false);
    assert.equal(off.body.modules.length, 5);
    assert.ok(off.body.modules.every((item) => item.status === 'not-installed'));
  });

  const directory = {
    modules: [
      { id: 'pages', version: '1.2.0', installed: true, enabled: true, configured: true, ready: true, routePrefix: '/api/pages' },
      { id: 'disk', version: '0.9.0', installed: true, enabled: true, configured: true, ready: true, routePrefix: '/api/disk' },
      { id: 'mail', installed: false },
      { id: 'survey', version: '1.0.0', installed: true, enabled: true, configured: true, ready: false, startError: '依赖不可用' },
      { id: 'paper', version: '1.0.0', installed: true, enabled: true, configured: false, ready: false }
    ]
  };
  const server = await startDirectoryServer(directory);
  const url = `http://127.0.0.1:${server.address().port}/api/modules`;
  try {
    await withModule({ moduleDirectoryUrl: url, moduleMinVersions: { disk: '1.0.0' } }, async () => {
      const listed = await call('GET', '/api/glim/discovery', { user: alice });
      assert.equal(listed.status, 200, JSON.stringify(listed.body));
      assert.equal(listed.body.configured, true);
      const byId = Object.fromEntries(listed.body.modules.map((item) => [item.moduleId, item]));
      assert.equal(byId.pages.status, 'pending-auth');
      assert.equal(byId.disk.status, 'incompatible');
      assert.equal(byId.mail.status, 'not-installed');
      assert.equal(byId.survey.status, 'unavailable');
      assert.equal(byId.paper.status, 'not-configured');
      assert.equal(byId.pages.endpointPath, '/api/pages');
      assert.equal(byId.pages.version, '1.2.0');

      await call('POST', '/api/glim/connectors/from-module', {
        user: alice,
        body: { moduleId: 'pages', grant: true }
      });
      const after = await call('GET', '/api/glim/discovery', { user: alice });
      const pages = after.body.modules.find((item) => item.moduleId === 'pages');
      assert.equal(pages.status, 'available');
      assert.equal(pages.registered, true);
      assert.equal(pages.granted, true);
      assert.ok(pages.connectorId);
      assert.ok(pages.capabilities.includes('pages_publish_site'));

      // 发现结果按用户隔离：bob 仍处于待授权。
      const bobView = await call('GET', '/api/glim/discovery', { user: bob });
      const bobPages = bobView.body.modules.find((item) => item.moduleId === 'pages');
      assert.equal(bobPages.status, 'pending-auth');
      assert.equal(bobPages.registered, false);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('工作区：路径校验、UTF-8/Base64、配额、跨用户隔离与未配置拒绝', async () => {
  await withModule({}, async () => {
    expectError(await call('GET', '/api/glim/workspace', { user: alice }), 409, 'glim.workspace_not_configured');
  });

  const root = tempDir('glim-workspace-');
  await withModule({ workspaceRoot: root, maxWorkspaceFiles: 2 }, async () => {
    const written = await call('PUT', '/api/glim/workspace/file', {
      user: alice,
      body: { path: 'notes/a.txt', content: '你好，Glim' }
    });
    assert.equal(written.status, 201);
    assert.equal(written.body.file.path, 'notes/a.txt');

    const read = await call('GET', '/api/glim/workspace/file?path=notes%2Fa.txt', { user: alice });
    assert.equal(read.status, 200);
    assert.equal(read.body.encoding, 'utf8');
    assert.equal(read.body.content, '你好，Glim');

    const binary = Buffer.from([0, 1, 2, 255]);
    await call('PUT', '/api/glim/workspace/file', {
      user: alice,
      body: { path: 'bin/data.bin', content: binary.toString('base64'), encoding: 'base64' }
    });
    const readBinary = await call('GET', '/api/glim/workspace/file?path=bin%2Fdata.bin', { user: alice });
    assert.equal(readBinary.body.encoding, 'base64');
    assert.deepEqual(Buffer.from(readBinary.body.content, 'base64'), binary);

    expectError(
      await call('PUT', '/api/glim/workspace/file', {
        user: alice,
        body: { path: '../escape.txt', content: 'x' }
      }),
      400,
      'glim.workspace_invalid_path'
    );
    expectError(
      await call('PUT', '/api/glim/workspace/file', {
        user: alice,
        body: { path: 'third.txt', content: 'x' }
      }),
      409,
      'glim.workspace_quota_exceeded'
    );

    const bobList = await call('GET', '/api/glim/workspace', { user: bob });
    assert.deepEqual(bobList.body.files, []);
    expectError(
      await call('GET', '/api/glim/workspace/file?path=notes%2Fa.txt', { user: bob }),
      404,
      'glim.workspace_not_found'
    );

    const removed = await call('POST', '/api/glim/workspace/delete', {
      user: alice,
      body: { path: 'notes/a.txt' }
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.deleted, true);
    assert.equal((await call('GET', '/api/glim/workspace', { user: alice })).body.files.length, 1);
  });
});

test('任务：排队、停止、恢复、幂等与跨用户拒绝', async () => {
  let calls = 0;
  let release = null;
  const adapter = async () => {
    calls += 1;
    if (calls === 1) {
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return { content: `任务完成 ${calls}` };
  };

  await withModule({ chatAdapter: adapter }, async () => {
    const created = await call('POST', '/api/glim/tasks', {
      user: alice,
      body: { prompt: '比较两份文件', operationId: 'op-1' }
    });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    const taskId = created.body.task.id;

    const duplicate = await call('POST', '/api/glim/tasks', {
      user: alice,
      body: { prompt: '比较两份文件', operationId: 'op-1' }
    });
    assert.equal(duplicate.status, 202);
    assert.equal(duplicate.body.task.id, taskId, '同一 operationId 必须幂等');

    expectError(
      await call('POST', '/api/glim/tasks', {
        user: alice,
        body: { prompt: '不同内容', operationId: 'op-1' }
      }),
      409,
      'glim.operation_conflict'
    );

    await waitFor(async () => {
      const current = await call('GET', `/api/glim/tasks/${taskId}`, { user: alice });
      return current.body.task.status === 'running';
    });

    expectError(await call('GET', `/api/glim/tasks/${taskId}`, { user: bob }), 403, 'glim.forbidden');
    expectError(await call('POST', `/api/glim/tasks/${taskId}/stop`, { user: bob }), 403, 'glim.forbidden');

    const stopped = await call('POST', `/api/glim/tasks/${taskId}/stop`, { user: alice });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.task.status, 'stopped');
    if (release) release();

    await waitFor(async () => {
      const current = await call('GET', `/api/glim/tasks/${taskId}`, { user: alice });
      return current.body.task.status === 'stopped';
    });

    const resumed = await call('POST', `/api/glim/tasks/${taskId}/resume`, { user: alice });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.task.status, 'queued');

    const done = await waitFor(async () => {
      const current = await call('GET', `/api/glim/tasks/${taskId}`, { user: alice });
      return current.body.task.status === 'done' ? current.body.task : null;
    });
    assert.equal(done.reply, '任务完成 2');
    assert.ok(done.messageId);

    const list = await call('GET', '/api/glim/tasks', { user: alice });
    assert.equal(list.body.tasks.length, 1);
    assert.deepEqual((await call('GET', '/api/glim/tasks', { user: bob })).body.tasks, []);
    expectError(
      await call('POST', `/api/glim/tasks/${taskId}/resume`, { user: alice }),
      409,
      'glim.task_finished'
    );
  });
});

test('任务恢复：重启后 running→interrupted、queued→stopped，并保留可恢复语义', async () => {
  const dir = tempDir('glim-tasks-');
  const dataFile = path.join(dir, 'glim.json');
  const at = new Date().toISOString();
  fs.writeFileSync(dataFile, JSON.stringify({
    tasks: {
      task_running: {
        id: 'task_running', userId: alice.id, sessionId: null, prompt: '运行中',
        status: 'running', attempts: 1, trace: [], reply: null, error: null,
        createdAt: at, updatedAt: at, startedAt: at, finishedAt: null
      },
      task_queued: {
        id: 'task_queued', userId: alice.id, sessionId: null, prompt: '排队中',
        status: 'queued', attempts: 0, trace: [], reply: null, error: null,
        createdAt: at, updatedAt: at, startedAt: null, finishedAt: null
      }
    }
  }), { mode: 0o600 });

  await moduleEntry.start({ config: { dataFile }, logger: silentLogger });
  try {
    const running = await call('GET', '/api/glim/tasks/task_running', { user: alice });
    assert.equal(running.body.task.status, 'interrupted');
    assert.match(running.body.task.error, /可恢复/);
    const queued = await call('GET', '/api/glim/tasks/task_queued', { user: alice });
    assert.equal(queued.body.task.status, 'stopped');
  } finally {
    await moduleEntry.stop();
  }
});

test('模型工具循环：只执行已授权工具，结果回填；审计不记录参数内容', async () => {
  const seen = [];
  const adapter = async ({ messages, tools: definitions }) => {
    seen.push({ messages: messages.map((item) => ({ ...item })), tools: definitions });
    const toolMessages = messages.filter((item) => item.role === 'tool');
    if (toolMessages.length === 0) {
      return {
        content: '',
        toolCalls: [{ id: 'call_1', name: 'pages_list_sites', arguments: { limit: 5 } }]
      };
    }
    return { content: '已读取站点列表' };
  };

  await withModule({ chatAdapter: adapter }, async () => {
    const connector = (await call('POST', '/api/glim/connectors', {
      user: alice,
      body: {
        endpoint: 'https://pages.example.test/api',
        capabilities: [
          { name: 'pages_list_sites', access: 'read', implemented: true },
          { name: 'pages_delete_site', access: 'write', implemented: true, externalEffect: true }
        ]
      }
    })).body.connector;
    await call('POST', `/api/glim/connectors/${connector.id}/grant`, {
      user: alice,
      body: { capabilities: ['pages_list_sites'] }
    });

    const restore = installTool('pages_list_sites', async (input) => ({ sites: ['alpha'], input }));
    try {
      const session = await call('POST', '/api/glim/sessions', { user: alice, body: {} });
      const sent = await call('POST', `/api/glim/sessions/${session.body.session.id}/messages`, {
        user: alice,
        body: { content: '列出站点' }
      });
      assert.equal(sent.status, 201, JSON.stringify(sent.body));
      assert.equal(sent.body.assistantMessage.content, '已读取站点列表');
      assert.equal(seen.length, 2);
      assert.deepEqual(seen[0].tools.map((item) => item.function.name), ['pages_list_sites']);
      const toolMessage = seen[1].messages.find((item) => item.role === 'tool');
      assert.equal(toolMessage.name, 'pages_list_sites');
      assert.match(toolMessage.content, /alpha/);

      const audit = await call('GET', '/api/glim/audit', { user: alice });
      assert.equal(audit.status, 200);
      const record = audit.body.audit.find((item) => item.tool === 'pages_list_sites');
      assert.equal(record.ok, true);
      assert.equal(record.source, 'agent');
      assert.equal(JSON.stringify(record).includes('limit'), false, '审计不得记录参数内容');
      assert.deepEqual((await call('GET', '/api/glim/audit', { user: bob })).body.audit, []);

      // 未授权能力不会被模型调用；授权撤销后立即不可见。
      await call('POST', `/api/glim/connectors/${connector.id}/revoke`, { user: alice, body: {} });
      const afterRevoke = await call('GET', '/api/glim/tools', { user: alice });
      assert.deepEqual(afterRevoke.body.tools, []);
    } finally {
      restore();
    }
  });
});
