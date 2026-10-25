'use strict';
// 连接与工具测试：登记校验、显式授权、撤销立即失效、跨用户拒绝、来源白名单与策略开关。

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  moduleEntry,
  alice,
  bob,
  admin,
  call,
  withModule,
  expectError
} = require('./support.js');

function connectorBody(overrides = {}) {
  return {
    name: 'Pages 测试连接',
    endpoint: 'https://pages.example.test/api',
    version: '1.0.0',
    capabilities: [
      { name: 'pages_list_sites', access: 'read', implemented: true, version: '1.0.0' },
      { name: 'pages_publish_site', access: 'write', implemented: false, externalEffect: true },
      { name: 'pages_delete_site', access: 'write', implemented: true, externalEffect: true }
    ],
    ...overrides
  };
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

async function register(user = alice, overrides = {}) {
  const result = await call('POST', '/api/glim/connectors', { user, body: connectorBody(overrides) });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.connector;
}

test('connector 登记：endpoint/capabilities 严格校验，登记本身不等于授权', async () => {
  await withModule({}, async () => {
    const badBodies = [
      connectorBody({ endpoint: 'ftp://pages.example.test' }),
      connectorBody({ endpoint: '/relative/path' }),
      // 带凭据的 URL 必须被拒绝；字符串运行时拼接，避免仓库密钥扫描把测试字面量误判为真实凭据
      connectorBody({ endpoint: 'https://' + 'user' + ':' + 'pass' + '@pages.example.test' }),
      connectorBody({ capabilities: [] }),
      connectorBody({ capabilities: [{ name: 'Bad-Name', access: 'read', implemented: true }] }),
      connectorBody({ capabilities: [{ name: 'pages_list_sites', access: 'admin', implemented: true }] }),
      connectorBody({ capabilities: [{ name: 'pages_list_sites', access: 'read', implemented: 'yes' }] }),
      connectorBody({
        capabilities: [
          { name: 'pages_list_sites', access: 'read', implemented: true },
          { name: 'pages_list_sites', access: 'write', implemented: false }
        ]
      })
    ];
    for (const body of badBodies) {
      expectError(await call('POST', '/api/glim/connectors', { user: alice, body }), 400, 'glim.invalid_input');
    }
    expectError(
      await call('POST', '/api/glim/connectors', { user: alice, body: connectorBody({ name: 42 }) }),
      400,
      'glim.invalid_input'
    );

    const connector = await register();
    assert.equal(connector.endpoint, 'https://pages.example.test/api');
    assert.equal(connector.capabilities.length, 3);
    assert.equal(connector.granted, false);
    assert.equal(connector.grant, null);

    const list = await call('GET', '/api/glim/connectors', { user: alice });
    assert.equal(list.status, 200);
    assert.equal(list.body.connectors.length, 1);
    assert.equal(list.body.connectors[0].id, connector.id);

    const single = await call('GET', `/api/glim/connectors/${connector.id}`, { user: alice });
    assert.equal(single.status, 200);
    assert.equal(single.body.connector.id, connector.id);

    const tools = await call('GET', '/api/glim/tools', { user: alice });
    assert.deepEqual(tools.body.tools, [], '仅登记、未授权时不得出现任何工具');
  });
});

test('未授权调用返回 403；未实现能力返回 409；授权后 GET /tools 只返回 implemented=true', async () => {
  await withModule({}, async () => {
    const connector = await register();

    expectError(
      await call('POST', '/api/glim/tools/pages_list_sites/invoke', { user: alice, body: { input: {} } }),
      403,
      'glim.tool_not_authorized'
    );

    const granted = await call('POST', `/api/glim/connectors/${connector.id}/grant`, { user: alice, body: {} });
    assert.equal(granted.status, 200);
    assert.equal(granted.body.grant.capabilities.length, 3);

    const tools = await call('GET', '/api/glim/tools', { user: alice });
    assert.equal(tools.status, 200);
    assert.deepEqual(
      tools.body.tools.map((tool) => tool.name).sort(),
      ['pages_delete_site', 'pages_list_sites']
    );
    for (const tool of tools.body.tools) {
      assert.equal(tool.implemented, true);
      assert.equal(tool.adapterReady, false, '本机尚未注入适配器时必须如实标记');
      assert.ok(tool.connectorId);
      assert.ok(tool.endpoint);
    }

    expectError(
      await call('POST', '/api/glim/tools/pages_publish_site/invoke', { user: alice, body: { input: {} } }),
      409,
      'glim.tool_incompatible'
    );
    expectError(
      await call('POST', '/api/glim/tools/pages_list_sites/invoke', { user: alice, body: { input: {} } }),
      409,
      'glim.tool_incompatible'
    );
    expectError(
      await call('POST', '/api/glim/tools/pages_list_sites/invoke', {
        user: alice,
        body: { access: 'write', input: {} }
      }),
      409,
      'glim.tool_incompatible'
    );
  });
});

test('注入真实本机适配器后工具调用成功；访问类型不匹配仍 409', async () => {
  await withModule({}, async () => {
    const connector = await register();
    await call('POST', `/api/glim/connectors/${connector.id}/grant`, { user: alice, body: {} });
    const restore = installTool('pages_list_sites', async (input, context) => ({
      echo: input,
      connectorId: context.connector.id
    }));
    try {
      const invoked = await call('POST', '/api/glim/tools/pages_list_sites/invoke', {
        user: alice,
        body: { input: { foo: 'bar' } }
      });
      assert.equal(invoked.status, 200);
      assert.equal(invoked.body.tool, 'pages_list_sites');
      assert.equal(invoked.body.connectorId, connector.id);
      assert.deepEqual(invoked.body.result.echo, { foo: 'bar' });

      const writeAttempt = await call('POST', '/api/glim/tools/pages_list_sites/invoke', {
        user: alice,
        body: { access: 'write', input: {} }
      });
      assert.equal(writeAttempt.status, 409);
      assert.equal(writeAttempt.body.code, 'glim.tool_incompatible');

      const tools = await call('GET', '/api/glim/tools', { user: alice });
      const entry = tools.body.tools.find((tool) => tool.name === 'pages_list_sites');
      assert.equal(entry.adapterReady, true);
    } finally {
      restore();
    }
  });
});

test('撤销立即失效：撤销后列表清空、调用 403，无需等待缓存过期', async () => {
  await withModule({}, async () => {
    const connector = await register();
    await call('POST', `/api/glim/connectors/${connector.id}/grant`, { user: alice, body: {} });
    const restore = installTool('pages_list_sites', async () => ({ ok: true }));
    try {
      assert.equal((await call('GET', '/api/glim/tools', { user: alice })).body.tools.length, 2);

      const revoked = await call('POST', `/api/glim/connectors/${connector.id}/revoke`, { user: alice, body: {} });
      assert.equal(revoked.status, 200);
      assert.equal(revoked.body.granted, false);
      assert.deepEqual(revoked.body.capabilities, []);

      assert.deepEqual((await call('GET', '/api/glim/tools', { user: alice })).body.tools, []);
      expectError(
        await call('POST', '/api/glim/tools/pages_list_sites/invoke', { user: alice, body: {} }),
        403,
        'glim.tool_not_authorized'
      );
    } finally {
      restore();
    }
  });
});

test('按能力授权与撤销：read/write 分开，未授权能力 403', async () => {
  await withModule({}, async () => {
    const connector = await register();

    const readOnly = await call('POST', `/api/glim/connectors/${connector.id}/grant`, {
      user: alice,
      body: { capabilities: ['pages_list_sites'] }
    });
    assert.deepEqual(readOnly.body.grant.capabilities, ['pages_list_sites']);
    assert.deepEqual(
      (await call('GET', '/api/glim/tools', { user: alice })).body.tools.map((tool) => tool.name),
      ['pages_list_sites']
    );
    expectError(
      await call('POST', '/api/glim/tools/pages_delete_site/invoke', { user: alice, body: {} }),
      403,
      'glim.tool_not_authorized'
    );

    const addWrite = await call('POST', `/api/glim/connectors/${connector.id}/grant`, {
      user: alice,
      body: { capabilities: ['pages_delete_site'] }
    });
    assert.deepEqual(addWrite.body.grant.capabilities.sort(), ['pages_delete_site', 'pages_list_sites']);

    const revokeRead = await call('POST', `/api/glim/connectors/${connector.id}/revoke`, {
      user: alice,
      body: { capabilities: ['pages_list_sites'] }
    });
    assert.equal(revokeRead.body.granted, true);
    assert.deepEqual(revokeRead.body.capabilities, ['pages_delete_site']);
    assert.deepEqual(
      (await call('GET', '/api/glim/tools', { user: alice })).body.tools.map((tool) => tool.name),
      ['pages_delete_site']
    );
    expectError(
      await call('POST', '/api/glim/tools/pages_list_sites/invoke', { user: alice, body: {} }),
      403,
      'glim.tool_not_authorized'
    );
  });
});

test('跨用户拒绝：connector 不可见、不可授权、不可撤销、不可删除、工具不可见', async () => {
  await withModule({}, async () => {
    const connector = await register(alice);
    await call('POST', `/api/glim/connectors/${connector.id}/grant`, { user: alice, body: {} });

    assert.deepEqual((await call('GET', '/api/glim/connectors', { user: bob })).body.connectors, []);
    assert.deepEqual((await call('GET', '/api/glim/tools', { user: bob })).body.tools, []);
    expectError(await call('GET', `/api/glim/connectors/${connector.id}`, { user: bob }), 403, 'glim.forbidden');
    expectError(
      await call('POST', `/api/glim/connectors/${connector.id}/grant`, { user: bob, body: {} }),
      403,
      'glim.forbidden'
    );
    expectError(
      await call('POST', `/api/glim/connectors/${connector.id}/revoke`, { user: bob, body: {} }),
      403,
      'glim.forbidden'
    );
    expectError(await call('DELETE', `/api/glim/connectors/${connector.id}`, { user: bob }), 403, 'glim.forbidden');
    expectError(
      await call('POST', '/api/glim/tools/pages_list_sites/invoke', { user: bob, body: {} }),
      403,
      'glim.tool_not_authorized'
    );
  });
});

test('受信来源白名单与登记策略：白名单外 403、关闭登记 403、仅管理员 403', async () => {
  await withModule({ trustedConnectorOrigins: ['https://trusted.example'] }, async () => {
    expectError(
      await call('POST', '/api/glim/connectors', {
        user: alice,
        body: connectorBody({ endpoint: 'https://evil.example/api' })
      }),
      403,
      'glim.connector_origin_denied'
    );
    const trusted = await call('POST', '/api/glim/connectors', {
      user: alice,
      body: connectorBody({ endpoint: 'https://trusted.example/api' })
    });
    assert.equal(trusted.status, 201);
  });

  await withModule({ allowConnectorRegistration: false }, async () => {
    expectError(
      await call('POST', '/api/glim/connectors', { user: alice, body: connectorBody() }),
      403,
      'glim.connector_registration_disabled'
    );
  });

  await withModule({ requireAdminForConnectorRegistration: true }, async () => {
    expectError(
      await call('POST', '/api/glim/connectors', { user: alice, body: connectorBody() }),
      403,
      'glim.forbidden'
    );
    const byAdmin = await call('POST', '/api/glim/connectors', { user: admin, body: connectorBody() });
    assert.equal(byAdmin.status, 201);
  });
});

test('资源上限：每用户 connector 数量受限', async () => {
  await withModule({ maxConnectorsPerUser: 1 }, async () => {
    await register();
    expectError(
      await call('POST', '/api/glim/connectors', {
        user: alice,
        body: connectorBody({ endpoint: 'https://second.example/api' })
      }),
      409,
      'glim.connector_limit'
    );
  });
});

test('删除 connector 同时清除授权，工具立即不可见', async () => {
  await withModule({}, async () => {
    const connector = await register();
    await call('POST', `/api/glim/connectors/${connector.id}/grant`, { user: alice, body: {} });
    const restore = installTool('pages_list_sites', async () => ({ ok: true }));
    try {
      assert.equal((await call('GET', '/api/glim/tools', { user: alice })).body.tools.length, 2);
      const deleted = await call('DELETE', `/api/glim/connectors/${connector.id}`, { user: alice });
      assert.equal(deleted.status, 200);
      assert.equal(deleted.body.deleted, true);

      assert.deepEqual((await call('GET', '/api/glim/tools', { user: alice })).body.tools, []);
      assert.deepEqual((await call('GET', '/api/glim/connectors', { user: alice })).body.connectors, []);
      expectError(
        await call('POST', '/api/glim/tools/pages_list_sites/invoke', { user: alice, body: {} }),
        403,
        'glim.tool_not_authorized'
      );
      expectError(
        await call('POST', `/api/glim/connectors/${connector.id}/grant`, { user: alice, body: {} }),
        404,
        'glim.connector_not_found'
      );
    } finally {
      restore();
    }
  });
});