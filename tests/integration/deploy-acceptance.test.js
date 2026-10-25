'use strict';
// C31 / C32 / C33 部署验收：
//   - 安装器生成的 config 与 Compose 预设的 init 命令逐字段一致（同一配置控制所有层）；
//   - 在仓库外的独立安装树上真实启动进程，覆盖 core-only、六模块单装、组合与全量；
//   - 未安装模块没有隐式挂载，Glim 在未配置目录时不发外部请求；
//   - 真实升级、备份、恢复、停用/启用、卸载与重装演练。
//
// 运行前需设置（与 test:mongo 相同）：
//   NODE_PATH=/tmp/pagesai-mongo-build/node_modules
//   PAGESAI_MONGO_TEST=1
//   MONGOMS_DOWNLOAD_DIR=/tmp/pagesai-mongo-build/binaries
// 容器镜像构建依赖宿主容器运行时；本机没有，相关验证由
// contracts/runtime-topology.json 记录为外部阻塞，不在本文件内伪造。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  sourceRoot,
  unusedPort,
  startMongo,
  stopMongo,
  copyInstall,
  runNode,
  startProcess,
  waitForHttp,
  client
} = require('./support/harness');

const model = require('../../deploy/presets/model.js');

const MONGO_ENABLED = process.env.PAGESAI_MONGO_TEST === '1';
const ALL_MODULES = ['pages', 'disk', 'glim', 'mail', 'survey', 'paper'];

function parseJson(stdout, label) {
  const text = String(stdout).trim();
  assert.ok(text.length > 0, `${label} 没有输出 JSON`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} 输出不是 JSON：${text.slice(0, 1200)}`);
  }
}

function sorted(value) {
  return value.slice().sort();
}

async function statTree(root) {
  return fs.existsSync(root) ? fs.readdirSync(root).sort() : [];
}

/** 按 model.js 的真实 init 命令解析出参数，确保验收直接消费部署预设。 */
function initCommandOf(presetName) {
  const built = model.buildModel({
    modules: model.PRESETS[presetName],
    diskVariant: (model.PRESET_OPTIONS[presetName] || {}).diskVariant || model.DEFAULTS.diskVariant,
    registration: (model.PRESET_OPTIONS[presetName] || {}).registration || model.DEFAULTS.registration,
    hostPort: model.DEFAULTS.hostPort,
    containerPort: model.DEFAULTS.containerPort,
    dataRoot: model.DEFAULTS.dataRoot,
    installRoot: model.DEFAULTS.installRoot,
    appImage: model.DEFAULTS.appImage,
    gatewayImage: model.DEFAULTS.gatewayImage,
    mongoImage: model.DEFAULTS.mongoImage,
    buildContext: model.DEFAULTS.buildContext
  });
  assert.deepEqual(built.services.init.command.slice(0, 1), ['--container'], '预设 init 命令应以 --container 开头');
  const flags = {};
  const argv = built.services.init.command.slice(1);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[token.slice(2)] = next;
      index += 1;
    } else {
      flags[token.slice(2)] = true;
    }
  }
  return { command: built.services.init.command, flags };
}

test('预设静态校验与容器初始化计划同源', async () => {
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pagesai-deploy-plan-'));
  try {
    const validated = await runNode(sourceRoot, ['deploy/validate-presets.js'], { timeout: 120000 });
    assert.equal(validated.code, 0, `validate-presets 失败：\n${validated.stdout}\n${validated.stderr}`);

    const installRoot = path.join(work, 'install');
    await copyInstall(installRoot);

    for (const presetName of Object.keys(model.PRESETS)) {
      const { command, flags } = initCommandOf(presetName);
      const planned = await runNode(installRoot, ['tools/init.js', ...command, '--dry-run', '--json'], {
        timeout: 60000
      });
      assert.equal(planned.code, 0, `${presetName} init --container --dry-run 失败：\n${planned.stdout}\n${planned.stderr}`);
      const summary = parseJson(planned.stdout, `${presetName} init`);

      // 同一份预设命令产生同一份配置：模块、变体、注册、端口、根目录全部对齐。
      assert.equal(summary.container, true, `${presetName} 未进入容器布局`);
      assert.equal(summary.configPath, flags.config, `${presetName} 配置路径与预设不一致`);
      assert.equal(summary.installRoot, flags['install-root'], `${presetName} 安装根与预设不一致`);
      assert.equal(summary.dataRoot, flags['data-root'], `${presetName} 数据根与预设不一致`);
      assert.equal(String(summary.port), flags.port, `${presetName} 端口与预设不一致`);
      assert.equal(summary.diskVariant, flags['disk-variant'], `${presetName} Disk 变体与预设不一致`);
      assert.equal(summary.registrationMode, flags.registration, `${presetName} 注册方式与预设不一致`);
      assert.deepEqual(sorted(summary.modules), sorted(model.PRESETS[presetName]), `${presetName} 模块集合与预设不一致`);
      assert.equal(summary.wrote, false, `${presetName} --dry-run 不应写盘`);
      assert.equal(summary.dryRun, true);
      assert.equal(summary.secretsMode, 'env', `${presetName} 容器布局应只从环境读取秘密`);
      assert.equal(summary.secretsReference, 'container-environment');

      // Glim 只为已安装的同级模块生成连接位，且默认未配置；未安装模块不产生连接。
      const glimInstalled = model.PRESETS[presetName].includes('glim');
      const expectedConnections = glimInstalled
        ? ['pages', 'disk', 'mail', 'survey', 'paper'].filter((moduleId) => model.PRESETS[presetName].includes(moduleId))
        : [];
      assert.deepEqual(
        (summary.glimConnections || []).map((item) => item.module),
        expectedConnections,
        `${presetName} 的 Glim 连接位与已装模块不一致`
      );
      for (const connection of summary.glimConnections || []) {
        assert.equal(connection.status, 'unconfigured', `${presetName} 的 ${connection.module} 连接不应预配置`);
      }
      for (const moduleId of summary.moduleConfigModules) {
        assert.ok(model.PRESETS[presetName].includes(moduleId), `${presetName} 未装 ${moduleId} 却生成了模块配置`);
      }
    }
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true });
  }
});

test('干净安装矩阵：真实启动、就绪与未安装模块隔离', { skip: !MONGO_ENABLED, timeout: 300000 }, async () => {
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pagesai-deploy-matrix-'));
  const mongo = await startMongo(work);
  let installRoot = null;
  try {
    installRoot = await copyInstall(path.join(work, 'install'));

    const combos = [
      { name: 'core-only', modules: [] },
      { name: 'single-pages', modules: ['pages'] },
      { name: 'single-disk', modules: ['disk'] },
      { name: 'single-glim', modules: ['glim'] },
      { name: 'single-mail', modules: ['mail'] },
      { name: 'single-survey', modules: ['survey'] },
      { name: 'single-paper', modules: ['paper'] },
      { name: 'glim-pages', modules: ['glim', 'pages'] },
      { name: 'glim-disk', modules: ['glim', 'disk'] },
      { name: 'glim-mail', modules: ['glim', 'mail'] },
      { name: 'glim-survey', modules: ['glim', 'survey'] },
      { name: 'glim-paper', modules: ['glim', 'paper'] },
      { name: 'pages-disk', modules: ['pages', 'disk'] },
      { name: 'survey-disk', modules: ['survey', 'disk'] },
      { name: 'paper-disk', modules: ['paper', 'disk'] },
      { name: 'full-generic', modules: ALL_MODULES, diskVariant: 'generic', registration: 'open' },
      { name: 'full-pku', modules: ALL_MODULES, diskVariant: 'pku', registration: 'email' }
    ];

    for (const combo of combos) {
      const slug = combo.name.replace(/[^a-z0-9]+/g, '-');
      const dataRoot = path.join(work, `data-${slug}`);
      const configPath = path.join(work, `config-${slug}.json`);
      const port = await unusedPort();
      const registration = combo.registration || 'open';
      const diskVariant = combo.diskVariant || 'generic';
      const modulesArg = combo.modules.length === 0 ? 'core' : combo.modules.join(',');

      const init = await runNode(installRoot, [
        'tools/init.js',
        '--data-root', dataRoot,
        '--config', configPath,
        '--install-root', installRoot,
        '--modules', modulesArg,
        '--disk-variant', diskVariant,
        '--registration', registration,
        '--port', String(port),
        '--json'
      ]);
      assert.equal(init.code, 0, `${combo.name} init 失败：\n${init.stdout}\n${init.stderr}`);
      const summary = parseJson(init.stdout, `${combo.name} init`);
      assert.equal(summary.ok, true);
      assert.equal(summary.wrote, true, `${combo.name} 正式初始化应写盘`);
      assert.deepEqual(sorted(summary.modules), sorted(combo.modules), `${combo.name} 模块清单不符`);
      assert.equal(summary.port, port, `${combo.name} 端口未写入配置`);

      const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
      assert.deepEqual(sorted(config.modules), sorted(combo.modules), `${combo.name} config.modules 与摘要不一致`);
      assert.equal(config.port, port);
      assert.equal(config.disk.variant, diskVariant);
      assert.equal(config.registration.mode, registration);
      for (const moduleId of Object.keys(config.moduleConfig || {})) {
        assert.ok(combo.modules.includes(moduleId), `${combo.name} 未装 ${moduleId} 却存在隐式模块配置`);
      }

      const checked = await runNode(installRoot, ['deploy/docker/entrypoints/app.js', '--config', configPath, '--check']);
      assert.equal(checked.code, 0, `${combo.name} 入口离线校验失败：\n${checked.stdout}\n${checked.stderr}`);
      const check = parseJson(checked.stdout, `${combo.name} --check`);
      assert.equal(check.ok, true);
      assert.equal(check.check, 'app');
      assert.deepEqual(sorted(check.modules), sorted(combo.modules), `${combo.name} 入口看到的模块不一致`);
      assert.equal(check.port, port, `${combo.name} 入口端口与配置不一致`);

      const deployment = startProcess(
        installRoot,
        'deploy/docker/entrypoints/app.js',
        ['--config', configPath, '--host', '127.0.0.1'],
        {
          env: {
            PAGESAI_MONGO_URL: mongo.uri,
            PAGESAI_BOOTSTRAP_TOKEN: `token-${slug}`
          },
          timeoutMs: 120000
        }
      );
      try {
        const listening = await deployment.waitEvent('listening');
        assert.equal(listening.port, port, `${combo.name} 监听端口与配置不一致`);
        assert.deepEqual(sorted(listening.modules), sorted(combo.modules), `${combo.name} 运行时模块清单不符`);

        const base = `http://127.0.0.1:${port}`;
        const health = await waitForHttp(`${base}/healthz`);
        assert.equal(health.status, 200);
        assert.deepEqual(health.body, { ok: true });

        const ready = await waitForHttp(`${base}/readyz`, {
          predicate: (response, body) => response.status === 200 && body && body.ok === true
        });
        const readyModules = ready.body.modules;
        assert.equal(readyModules.length, combo.modules.length, `${combo.name} /readyz 模块数量不符`);
        for (const described of readyModules) {
          assert.ok(combo.modules.includes(described.id), `${combo.name} /readyz 出现未安装模块 ${described.id}`);
          assert.equal(described.installed, true, `${combo.name} ${described.id} 未安装`);
          assert.equal(described.enabled, true, `${combo.name} ${described.id} 未启用`);
          assert.equal(described.ready, true, `${combo.name} ${described.id} 未就绪：${described.startError || ''}`);
          assert.ok(!described.startError, `${combo.name} ${described.id} 启动错误：${described.startError}`);
        }

        const api = client(base);
        const moduleList = await api.call('/api/modules');
        assert.equal(moduleList.status, 200);
        assert.deepEqual(sorted(moduleList.body.installed), sorted(combo.modules));

        // 未选模块没有隐式路由；已装模块的公开健康探针可用。
        const absent = ['disk', 'survey', 'glim'].filter((moduleId) => !combo.modules.includes(moduleId));
        for (const moduleId of absent) {
          const probe = await api.call(`/api/${moduleId}/health`);
          assert.equal(probe.status, 404, `${combo.name} 未装 ${moduleId} 却暴露了 /api/${moduleId}/health`);
          assert.equal(probe.body.code, 'NOT_FOUND');
        }
        if (combo.modules.includes('disk')) {
          const disk = await api.call('/api/disk/health');
          assert.equal(disk.status, 200);
          assert.equal(disk.body.module, 'disk');
        }
        if (combo.modules.includes('survey')) {
          const survey = await api.call('/api/survey/health');
          assert.equal(survey.status, 200);
          assert.equal(survey.body.module, 'survey');
        }
        if (combo.modules.includes('glim')) {
          const glim = await api.call('/api/glim/health');
          assert.equal(glim.status, 401, `${combo.name} Glim 匿名健康探针应要求身份`);
          assert.equal(glim.body.code, 'glim.unauthenticated');
        }

        if (combo.name === 'full-generic') {
          await fullBusinessAcceptance(api, config, combo.name);
        }
      } finally {
        const stopped = await deployment.stop();
        assert.equal(stopped.code, 0, `${combo.name} 进程未优雅退出：${JSON.stringify(deployment.output())}`);
        // 每个组合使用独立的空数据库，避免身份/元数据跨组合串扰。
        await mongo.client.db('pagesai').dropDatabase();
      }
    }
  } finally {
    await stopMongo(mongo);
    await fs.promises.rm(work, { recursive: true, force: true });
  }
});

async function fullBusinessAcceptance(api, config, label) {
  const missingToken = await api.call('/api/admin/bootstrap', {
    method: 'POST',
    json: { username: 'acceptance-admin', password: 'Admin-Pass-2026', bootstrapToken: 'wrong' }
  });
  assert.equal(missingToken.status, 403, `${label} 错误引导令牌不应通过`);

  const bootstrap = await api.call('/api/admin/bootstrap', {
    method: 'POST',
    json: { username: 'acceptance-admin', password: 'Admin-Pass-2026', bootstrapToken: 'token-full-generic' }
  });
  assert.equal(bootstrap.status, 201, `${label} 引导管理员失败：${JSON.stringify(bootstrap.body)}`);
  const again = await api.call('/api/admin/bootstrap', {
    method: 'POST',
    json: { username: 'admin2', password: 'Admin-Pass-2026', bootstrapToken: 'token-full-generic' }
  });
  assert.equal(again.status, 409, `${label} 二次引导应关闭`);
  assert.equal(again.body.code, 'BOOTSTRAP_CLOSED');

  assert.equal((await api.call('/api/me')).status, 401, `${label} 匿名 /api/me 应拒绝`);
  const session = await api.login('acceptance-admin', 'Admin-Pass-2026');
  const me = await api.call('/api/me', { cookie: session.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, 'acceptance-admin');

  const modules = await api.call('/api/admin/modules', { cookie: session.cookie });
  assert.equal(modules.status, 200);
  assert.deepEqual(sorted(modules.body.modules.map((item) => item.id)), sorted(ALL_MODULES));

  const detail = await api.call('/api/admin/modules/glim', { cookie: session.cookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.module.id, 'glim');

  // Glim 未配置 moduleDirectoryUrl：只看本地，不发外部请求，也不能从目录创建连接。
  const discovery = await api.call('/api/glim/discovery', { cookie: session.cookie });
  assert.equal(discovery.status, 200);
  assert.equal(discovery.body.configured, false);
  assert.equal(discovery.body.source, null);
  assert.equal(discovery.body.modules.length, 5);
  for (const item of discovery.body.modules) {
    assert.equal(item.status, 'not-installed');
  }
  const connector = await api.call('/api/glim/connectors/from-module', {
    method: 'POST',
    cookie: session.cookie,
    json: { moduleId: 'paper', name: 'paper-connector' }
  });
  assert.equal(connector.status, 409);
  assert.equal(connector.body.code, 'glim.discovery_not_configured');

  // 停用/启用不删除数据；模块状态在 /readyz 中如实反映。
  const regionDirs = Object.values(config.storage);
  const before = await Promise.all(regionDirs.map((dir) => statTree(dir)));
  const disabled = await api.call('/api/admin/modules/disk/disable', { method: 'POST', cookie: session.cookie });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.module.enabled, false);
  const readyDisabled = await api.call('/readyz');
  const diskState = readyDisabled.body.modules.find((item) => item.id === 'disk');
  assert.equal(diskState.enabled, false);
  const services = await api.call('/api/disk/health');
  assert.equal(services.status, 404, '停用后不应继续提供 Disk 业务路由');
  const afterDisabled = await Promise.all(regionDirs.map((dir) => statTree(dir)));
  assert.deepEqual(afterDisabled, before, '停用模块不应删除区域目录');
  const enabled = await api.call('/api/admin/modules/disk/enable', { method: 'POST', cookie: session.cookie });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.module.enabled, true);
  assert.equal((await api.call('/api/disk/health')).status, 200);
}

test('升级、备份恢复、卸载与重装演练', { skip: !MONGO_ENABLED, timeout: 300000 }, async () => {
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pagesai-deploy-ops-'));
  const mongo = await startMongo(work);
  try {
    const installRoot = await copyInstall(path.join(work, 'install'));
    const dataRoot = path.join(work, 'data');
    const configPath = path.join(work, 'config.json');
    const port = await unusedPort();
    const token = 'token-ops-drill';

    const init = await runNode(installRoot, [
      'tools/init.js',
      '--data-root', dataRoot,
      '--config', configPath,
      '--install-root', installRoot,
      '--modules', 'all',
      '--port', String(port),
      '--json'
    ]);
    assert.equal(init.code, 0, `init 失败：\n${init.stdout}\n${init.stderr}`);

    const deployment = startProcess(
      installRoot,
      'deploy/docker/entrypoints/app.js',
      ['--config', configPath, '--host', '127.0.0.1'],
      {
        env: {
          PAGESAI_MONGO_URL: mongo.uri,
          PAGESAI_BOOTSTRAP_TOKEN: token
        },
        timeoutMs: 120000
      }
    );
    try {
      await deployment.waitEvent('listening');
      const api = client(`http://127.0.0.1:${port}`);
      const bootstrap = await api.call('/api/admin/bootstrap', {
        method: 'POST',
        json: { username: 'acceptance-admin', password: 'Admin-Pass-2026', bootstrapToken: token }
      });
      assert.equal(bootstrap.status, 201);
      const session = await api.login('acceptance-admin', 'Admin-Pass-2026');
      const disabled = await api.call('/api/admin/modules/pages/disable', { method: 'POST', cookie: session.cookie });
      assert.equal(disabled.status, 200);
      const enabled = await api.call('/api/admin/modules/pages/enable', { method: 'POST', cookie: session.cookie });
      assert.equal(enabled.status, 200);
    } finally {
      const stopped = await deployment.stop();
      assert.equal(stopped.code, 0, `演练部署未优雅退出：${JSON.stringify(deployment.output())}`);
    }

    const check = await runNode(installRoot, ['tools/upgrade.js', '--config', configPath, '--check', '--json']);
    assert.equal(check.code, 0, `升级检查失败：\n${check.stdout}\n${check.stderr}`);
    const checkBody = parseJson(check.stdout, 'upgrade --check');
    assert.equal(checkBody.ok, true);
    assert.deepEqual(checkBody.check.incompatible, []);
    assert.deepEqual(checkBody.check.errors, []);

    const upgradeBackupOut = path.join(work, 'upgrade-backup');
    const upgrade = await runNode(installRoot, [
      'tools/upgrade.js', '--config', configPath, '--step', 'all', '--backup-out', upgradeBackupOut, '--json'
    ], { timeout: 120000 });
    assert.equal(upgrade.code, 0, `升级失败：\n${upgrade.stdout}\n${upgrade.stderr}`);
    const upgraded = parseJson(upgrade.stdout, 'upgrade all');
    assert.equal(upgraded.ok, true);
    assert.ok(upgraded.backup && fs.existsSync(upgraded.backup.backupDir), '升级前备份未落盘');
    assert.equal(upgraded.verify.ok, true, `升级后验证失败：${JSON.stringify(upgraded.verify.problems)}`);

    const backupOut = path.join(work, 'backups');
    const backupRun = await runNode(installRoot, [
      'tools/backup.js', '--config', configPath, '--out', backupOut, '--label', 'acceptance', '--json'
    ], { timeout: 120000 });
    assert.equal(backupRun.code, 0, `备份失败：\n${backupRun.stdout}\n${backupRun.stderr}`);
    const backup = parseJson(backupRun.stdout, 'backup');
    assert.equal(backup.ok, true);
    assert.ok(fs.existsSync(backup.backupDir), '备份目录不存在');
    for (const name of ['manifest.json', 'files.sha256', 'config.snapshot.json', 'references.json']) {
      assert.ok(fs.existsSync(path.join(backup.backupDir, name)), `备份缺少 ${name}`);
    }
    assert.ok(fs.existsSync(path.join(backup.backupDir, 'database')));
    assert.ok(fs.existsSync(path.join(backup.backupDir, 'data')));
    // 已知限制：tools/backup.js 只快照 stateDir，不导出外部 MongoDB 的业务集合。
    // 这里只验证工具如实报告引擎与提示，不伪造“已导出用户/配额”的结论。
    assert.equal(backup.database.engine, 'mongodb');
    assert.ok(backup.database.files >= 1, '数据库状态目录应有可校验快照');
    const backupManifest = JSON.parse(await fs.promises.readFile(path.join(backup.backupDir, 'manifest.json'), 'utf8'));
    const baseConfig = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
    assert.equal(backupManifest.backupId, backup.backupId);
    assert.equal(backupManifest.deployment.deploymentId, baseConfig.deploymentId);
    assert.ok(Array.isArray(backupManifest.roots) && backupManifest.roots.length >= 6);

    const verifyOnly = await runNode(installRoot, [
      'tools/restore.js', '--backup', backup.backupDir, '--verify-only', '--json'
    ], { timeout: 120000 });
    assert.equal(verifyOnly.code, 0, `恢复校验失败：\n${verifyOnly.stdout}\n${verifyOnly.stderr}`);
    const verifyBody = parseJson(verifyOnly.stdout, 'restore --verify-only');
    assert.equal(verifyBody.ok, true);
    assert.equal(verifyBody.verifyOnly, true);

    const restoreTarget = path.join(work, 'restored');
    const restored = await runNode(installRoot, [
      'tools/restore.js', '--backup', backup.backupDir, '--target-data-root', restoreTarget, '--json'
    ], { timeout: 120000 });
    assert.equal(restored.code, 0, `恢复失败：\n${restored.stdout}\n${restored.stderr}`);
    const restoredBody = parseJson(restored.stdout, 'restore');
    assert.equal(restoredBody.ok, true);
    assert.equal(restoredBody.movedAside, null);
    assert.ok(fs.existsSync(restoredBody.configRestoredPath), '恢复后缺少 config.restored.json');
    const restoredConfig = JSON.parse(await fs.promises.readFile(restoredBody.configRestoredPath, 'utf8'));
    assert.equal(restoredConfig.dataRoot, restoreTarget);
    assert.equal(restoredConfig.deploymentId, backupManifest.deployment.deploymentId);

    const refuse = await runNode(installRoot, [
      'tools/restore.js', '--backup', backup.backupDir, '--target-data-root', restoreTarget, '--json'
    ], { timeout: 120000 });
    assert.notEqual(refuse.code, 0, '目标非空且未加 --replace-existing 时应拒绝');
    const refuseBody = parseJson(refuse.stdout, 'restore refuse');
    assert.equal(refuseBody.ok, false);
    assert.match(refuseBody.problems.join('\n'), /拒绝覆盖|replace-existing/);

    const replaced = await runNode(installRoot, [
      'tools/restore.js', '--backup', backup.backupDir, '--target-data-root', restoreTarget, '--replace-existing', '--json'
    ], { timeout: 120000 });
    assert.equal(replaced.code, 0, `--replace-existing 恢复失败：\n${replaced.stdout}\n${replaced.stderr}`);
    const replacedBody = parseJson(replaced.stdout, 'restore --replace-existing');
    assert.equal(replacedBody.ok, true);
    assert.ok(replacedBody.movedAside && fs.existsSync(replacedBody.movedAside), '旧数据应改名保留而非删除');

    // 模式不兼容：升级必须停下且不改文件；备份仍可用来校验恢复路径。
    const incompatiblePath = path.join(work, 'config.incompatible.json');
    const incompatibleConfig = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
    incompatibleConfig.schemaVersion = 999;
    await fs.promises.writeFile(incompatiblePath, `${JSON.stringify(incompatibleConfig, null, 2)}\n`);
    const incompatible = await runNode(installRoot, [
      'tools/upgrade.js', '--config', incompatiblePath, '--check', '--json'
    ]);
    assert.equal(incompatible.code, 2, '不兼容模式应以退出码 2 停止');
    const incompatibleBody = parseJson(incompatible.stdout, 'upgrade incompatible');
    assert.equal(incompatibleBody.ok, false);
    assert.ok(incompatibleBody.check.incompatible.length >= 1);
    assert.match(incompatibleBody.check.incompatible[0], /版本|schema/i);
    assert.ok(!fs.existsSync(path.join(path.dirname(configPath), 'state')), '不兼容检查不应写入数据根外的新状态');
    assert.equal((await runNode(installRoot, [
      'tools/restore.js', '--backup', backup.backupDir, '--verify-only', '--json'
    ])).code, 0, '不兼容失败后应能回到备份校验路径');

    // 卸载：默认只停用并保留；数据目录与状态完整。
    const dryUninstall = await runNode(installRoot, ['tools/uninstall.js', '--config', configPath, '--dry-run', '--json']);
    assert.equal(dryUninstall.code, 0);
    const dryBody = parseJson(dryUninstall.stdout, 'uninstall --dry-run');
    assert.equal(dryBody.ok, true);
    assert.equal(dryBody.dryRun, true);
    assert.ok(fs.existsSync(configPath), '--dry-run 不应移动配置');

    const uninstall = await runNode(installRoot, ['tools/uninstall.js', '--config', configPath, '--json']);
    assert.equal(uninstall.code, 0, `卸载失败：\n${uninstall.stdout}\n${uninstall.stderr}`);
    const uninstalled = parseJson(uninstall.stdout, 'uninstall');
    assert.equal(uninstalled.ok, true);
    assert.equal(uninstalled.purged, false);
    assert.ok(uninstalled.configMovedTo && fs.existsSync(uninstalled.configMovedTo), '配置应改名保留');
    assert.ok(!fs.existsSync(configPath), '卸载后正式配置应已移走');
    assert.ok(fs.existsSync(path.join(dataRoot, 'state', 'uninstall-record.json')), '缺少卸载记录');
    assert.ok(fs.existsSync(path.join(dataRoot, 'state', 'deployment.json')), '卸载不应删除部署标记');
    // 存储区域是 dataRoot 下的扁平目录（见 tools/init.js#buildRegions），
    // 卸载默认只停用，业务区域必须原地保留。
    const survivingRegions = Object.entries(baseConfig.storage);
    assert.ok(survivingRegions.length >= 6, '配置应登记至少六个存储区域');
    for (const [key, dir] of survivingRegions) {
      assert.ok(fs.existsSync(dir), `卸载不应删除业务区域 ${key}：${dir}`);
    }

    // 重装：同一数据根与部署标识，配置生成后可以再次真实启动。
    const reinstallPort = await unusedPort();
    const reinstall = await runNode(installRoot, [
      'tools/init.js',
      '--data-root', dataRoot,
      '--config', configPath,
      '--install-root', installRoot,
      '--modules', 'all',
      '--port', String(reinstallPort),
      '--json'
    ]);
    assert.equal(reinstall.code, 0, `重装初始化失败：\n${reinstall.stdout}\n${reinstall.stderr}`);
    const reinstalled = parseJson(reinstall.stdout, 'reinstall init');
    assert.equal(reinstalled.deploymentId, baseConfig.deploymentId, '重装应沿用数据根内的部署标识');
    assert.ok(fs.existsSync(configPath), '重装后应重新生成配置');

    const recheck = await runNode(installRoot, ['deploy/docker/entrypoints/app.js', '--config', configPath, '--check']);
    assert.equal(recheck.code, 0, `重装后入口校验失败：\n${recheck.stdout}\n${recheck.stderr}`);

    const restart = startProcess(
      installRoot,
      'deploy/docker/entrypoints/app.js',
      ['--config', configPath, '--host', '127.0.0.1'],
      {
        env: {
          PAGESAI_MONGO_URL: mongo.uri,
          PAGESAI_BOOTSTRAP_TOKEN: token
        },
        timeoutMs: 120000
      }
    );
    try {
      const listening = await restart.waitEvent('listening');
      assert.equal(listening.port, reinstallPort);
      assert.equal((await waitForHttp(`http://127.0.0.1:${reinstallPort}/healthz`)).status, 200);
    } finally {
      const stopped = await restart.stop();
      assert.equal(stopped.code, 0);
    }
  } finally {
    await stopMongo(mongo);
    await fs.promises.rm(work, { recursive: true, force: true });
  }
});