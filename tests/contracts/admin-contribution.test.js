'use strict';
// C29 契约测试：模块后台贡献与后台外壳的规范化。
// 重点：形状上限、控制台入口白名单、绝不复述密钥，以及外壳对异常数据的容忍。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const { normalizeAdminContribution, CONSOLE_PATHS } = require(
  path.join(root, 'core', 'registry', 'admin-contribution.js')
);
const { codes } = require(path.join(root, 'core', 'errors.js'));

const SECRET = 'SENTINEL-SECRET-DO-NOT-ECHO';

const FIXTURES = {
  pages: {
    config: {
      ai: { apiKey: SECRET, adapter: SECRET },
      aiAdapter: SECRET,
      tenantMongoKeyRef: SECRET,
      tenantMongoUrl: SECRET,
      models: [{ name: 'default', keyRef: SECRET }],
      maxSitesPerUser: 20,
      maxFilesPerSite: 200,
      maxFileBytes: 1024 * 1024,
      maxVersions: 50,
      publicBasePath: '/api/pages/public'
    },
    health: {
      ok: true,
      module: 'pages',
      version: '0.2.0',
      aiConfigured: true,
      storage: 'mongodb+content-store',
      startedAt: '2026-10-24T00:00:00.000Z'
    }
  },
  disk: {
    config: {
      adapter: 'json',
      quotaBytes: 1024 * 1024 * 1024,
      maxFileBytes: 0,
      chunkSize: 5 * 1024 * 1024,
      maxChunkBytes: 64 * 1024 * 1024,
      shareTtlSeconds: 86400,
      maxShareTtlSeconds: 2592000
    },
    health: { ok: true }
  },
  glim: {
    config: {
      chatAdapter: { apiKey: SECRET, endpoint: 'http://127.0.0.1:1' },
      systemPrompt: SECRET,
      memoryMaxChars: 4000,
      messageMaxChars: 8000,
      historyLimit: 50,
      maxConnectorsPerUser: 20,
      maxWorkspaceFileBytes: 2 * 1024 * 1024,
      maxWorkspaceFiles: 200,
      maxWorkspaceTotalBytes: 20 * 1024 * 1024,
      maxToolRounds: 4,
      maxRunningTasksPerUser: 1,
      auditLimit: 1000
    },
    health: {
      ok: true,
      started: true,
      storage: 'file',
      model: 'configured',
      workspace: true,
      discovery: true,
      connectors: ['pages', 'disk', 'mail', 'survey', 'paper'],
      tasks: { active: 2 }
    }
  },
  mail: {
    config: {
      transport: { provider: 'smtp', host: '127.0.0.1', password: SECRET },
      imap: { provider: 'imap', host: '127.0.0.1', password: SECRET },
      verification: { windowMs: 600000, maxPerWindow: 5, ttlMs: 600000, maxAttempts: 5, public: false },
      maxTotalAttachmentBytes: 20 * 1024 * 1024
    },
    health: {
      ok: true,
      reason: null,
      transportConfigured: true,
      imapConfigured: true,
      transportProvider: 'smtp',
      imapProvider: 'imap',
      fromConfigured: true,
      userSendEnabled: true,
      storage: 'file'
    }
  },
  survey: {
    config: { maxAttachmentBytes: 10 * 1024 * 1024 },
    health: { ok: true }
  },
  paper: {
    config: {
      translateAdapter: { apiKey: SECRET, endpoint: 'http://127.0.0.1:1' },
      qaAdapter: { apiKey: SECRET },
      searchAdapter: { apiKey: SECRET },
      maxUploadBytes: 32 * 1024 * 1024,
      defaultTargetLang: 'zh',
      qaTopK: 6,
      translateBatchSize: 20
    },
    health: { ok: true, reason: null, docs: 3, storage: 'json-file', uploads: 'disk' }
  }
};

function loadContribution(id) {
  const file = path.join(root, 'modules', id, 'server', 'admin.js');
  delete require.cache[require.resolve(file)];
  return require(file);
}

function describeShape(id) {
  const fixture = FIXTURES[id];
  const contribution = loadContribution(id).describe({
    id,
    config: fixture.config,
    manifest: { id },
    health: fixture.health
  });
  return normalizeAdminContribution(contribution, { id });
}

test('六个模块都声明了可加载的后台贡献', () => {
  for (const id of Object.keys(CONSOLE_PATHS)) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, 'modules', id, 'manifest.json'), 'utf8')
    );
    assert.equal(manifest.activation.adminContribution, 'server/admin.js', id);
    const file = path.join(root, 'modules', id, manifest.activation.adminContribution);
    assert.equal(fs.existsSync(file), true, id + ' 后台贡献文件缺失');
    assert.equal(typeof loadContribution(id).describe, 'function', id);
  }
});

test('后台贡献形状合法：标题、入口、分组与长度上限', () => {
  for (const id of Object.keys(CONSOLE_PATHS)) {
    const contribution = describeShape(id);
    assert.equal(contribution.consolePath, CONSOLE_PATHS[id], id);
    assert.ok(contribution.title.length > 0 && contribution.title.length <= 80, id);
    assert.ok(contribution.summary === null || contribution.summary.length <= 300, id);
    assert.ok(Array.isArray(contribution.sections), id);
    assert.ok(contribution.sections.length > 0 && contribution.sections.length <= 7, id);
    for (const section of contribution.sections) {
      assert.ok(section.title.length > 0 && section.title.length <= 40, id + ' / ' + section.title);
      assert.ok(section.items.length > 0 && section.items.length <= 12, id + ' / ' + section.title);
      for (const item of section.items) {
        assert.ok(item.label.length > 0 && item.label.length <= 40, id + ' / ' + item.label);
        assert.ok(item.value.length > 0 && item.value.length <= 200, id + ' / ' + item.label);
      }
    }
  }
});

test('后台贡献绝不复述配置中的密钥或系统提示词', () => {
  for (const id of Object.keys(CONSOLE_PATHS)) {
    const serialized = JSON.stringify(describeShape(id));
    assert.equal(serialized.includes(SECRET), false, id + ' 泄露了敏感配置');
    assert.equal(serialized.includes('apiKey'), false, id + ' 出现了密钥字段名');
    assert.equal(serialized.includes('password'), false, id + ' 出现了口令字段名');
    assert.equal(serialized.includes('systemPrompt'), false, id + ' 出现了系统提示词');
  }
});

test('规范化拒绝非法标题与不一致的控制台入口', () => {
  assert.throws(
    () => normalizeAdminContribution({ sections: [] }, { id: 'survey' }),
    (err) => err.code === codes.CONFIG_INVALID
  );
  assert.throws(
    () => normalizeAdminContribution({ title: 'x', consolePath: '/admin' }, { id: 'survey' }),
    (err) => err.code === codes.CONFIG_INVALID
  );
  assert.throws(
    () => normalizeAdminContribution({ title: 'x', consolePath: '/pages' }, { id: 'survey' }),
    (err) => err.code === codes.CONFIG_INVALID
  );
  // 未提供同源控制台页面的 id 不允许声明入口
  assert.throws(
    () => normalizeAdminContribution({ title: 'x', consolePath: '/survey' }, { id: 'unknown' }),
    (err) => err.code === codes.CONFIG_INVALID
  );
  assert.equal(
    normalizeAdminContribution({ title: 'x' }, { id: 'survey' }).consolePath,
    null
  );
});

test('规范化截断超限内容并丢弃空分组', () => {
  const contribution = normalizeAdminContribution(
    {
      title: 'T'.repeat(120),
      summary: 'S'.repeat(400),
      consolePath: '/survey',
      sections: [
        { title: '保留', items: Array.from({ length: 20 }, (_, i) => ({ label: 'L' + i, value: 'V'.repeat(300) })) },
        { title: '空分组', items: [] },
        { title: '', items: [{ label: 'x', value: 'y' }] },
        ...Array.from({ length: 10 }, (_, i) => ({ title: 'S' + i, items: [{ label: 'a', value: 'b' }] }))
      ]
    },
    { id: 'survey' }
  );
  assert.equal(contribution.title.length, 80);
  assert.equal(contribution.summary.length, 300);
  // 先按 MAX_SECTIONS 截断，再丢弃空分组，所以结果不超过 7。
  assert.ok(contribution.sections.length <= 7);
  assert.equal(contribution.sections.length, 5);
  assert.equal(contribution.sections[0].items.length, 12);
  assert.equal(contribution.sections[0].items[0].value.length, 200);
  assert.equal(contribution.sections.some((section) => section.title === '空分组'), false);
});

test('规范化接受数字与布尔值，拒绝无法展示的对象', () => {
  const contribution = normalizeAdminContribution(
    {
      title: '数值',
      sections: [
        {
          title: '混合',
          items: [
            { label: '数字', value: 42 },
            { label: '布尔', value: true },
            { label: '对象', value: { secret: SECRET } },
            { label: '空', value: null }
          ]
        }
      ]
    },
    { id: 'survey' }
  );
  assert.deepEqual(contribution.sections[0].items, [
    { label: '数字', value: '42' },
    { label: '布尔', value: '是' }
  ]);
});

// ---------------------------------------------------------------- 后台外壳

function loadShellInternals() {
  const code = fs.readFileSync(path.join(root, 'admin', 'admin.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'admin/admin.js' });
  const internals = sandbox.window.__pagesaiAdminInternals;
  assert.ok(internals, '后台外壳未导出纯函数');
  return internals;
}

test('后台外壳只接受核心约定的控制台入口', () => {
  const { safeConsolePath, normalizeContribution } = loadShellInternals();
  assert.equal(safeConsolePath('survey', '/survey'), '/survey');
  assert.equal(safeConsolePath('survey', '/pages'), null);
  assert.equal(safeConsolePath('survey', 'https://evil.example/survey'), null);
  assert.equal(safeConsolePath('unknown', '/survey'), null);

  const contribution = normalizeContribution('survey', {
    title: 'T'.repeat(120),
    summary: 'S'.repeat(400),
    consolePath: '//evil.example',
    sections: [{ title: 'A', items: [{ label: 'x', value: 'y' }] }]
  });
  assert.equal(contribution.title.length, 80);
  assert.equal(contribution.summary.length, 300);
  assert.equal(contribution.consolePath, null);
  assert.equal(contribution.sections.length, 1);
});

test('后台外壳丢弃未登记或 id 为空的模块项', () => {
  const { normalizeAdminEntry } = loadShellInternals();
  assert.equal(normalizeAdminEntry({ id: '', installed: true }), null);
  assert.equal(normalizeAdminEntry({ id: 'survey', installed: false }), null);
  const entry = normalizeAdminEntry({
    id: 'survey',
    installed: true,
    enabled: true,
    available: true,
    error: null,
    contribution: { title: '问卷', consolePath: '/survey', sections: [] }
  });
  assert.equal(entry.id, 'survey');
  assert.equal(entry.available, true);
  assert.equal(entry.contribution.consolePath, '/survey');
});
