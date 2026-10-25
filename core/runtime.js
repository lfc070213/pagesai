'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config/index.js');
const { createCore, createServer } = require('./server.js');
const { CoreError, codes } = require('./errors.js');

async function startRuntime({ configPath, env = process.env, port, host = '127.0.0.1' } = {}) {
  if (!configPath || !path.isAbsolute(configPath)) throw new CoreError(codes.CONFIG_INVALID, '启动需要绝对路径 --config', { status: 500 });
  const document = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
  const runtimeEnv = {
    ...env,
    PAGESAI_MONGO_DB: document.database.name,
    PAGESAI_DATABASE_INITIALIZE: document.database.initialize ? '1' : '0',
    PAGESAI_REGISTRATION_ENABLED: document.registration.enabled ? '1' : '0',
    PAGESAI_EMAIL_REGISTRATION: document.registration.requireEmailVerification ? '1' : '0',
    PAGESAI_EMAIL_DOMAINS: (document.registration.allowedEmailDomains || []).join(','),
    PAGESAI_SESSION_TTL_MS: String(document.sessionTtlMs)
  };
  const config = loadConfig({
    env: runtimeEnv,
    dataRoot: document.dataRoot,
    installRoot: document.installRoot,
    installedModules: document.modules,
    deploymentId: document.deploymentId,
    databaseEngine: document.database.engine,
    regions: document.regions,
    storage: document.storage,
    moduleConfig: document.moduleConfig || {}
  });
  const core = createCore({ config, env: runtimeEnv, identitySnapshotPath: path.join(document.dataRoot, 'state', 'identity.json') });
  await core.initialize();
  try {
    for (const id of config.installedModules) {
      const moduleDir = path.join(config.installRoot, 'modules', id);
      const manifest = JSON.parse(await fs.promises.readFile(path.join(moduleDir, 'manifest.json'), 'utf8'));
      core.modules.install(manifest, { dir: moduleDir });
      await core.modules.enable(id);
    }
    const app = createServer(core);
    const address = await app.listen({ port: port === undefined ? document.port : port, host });
    return { app, core, config, ...address };
  } catch (error) {
    for (const item of core.modules.list()) if (item.ready) await core.modules.disable(item.id).catch(() => {});
    if (core.storageMetadata && core.storageMetadata.close) await core.storageMetadata.close();
    if (core.store && core.store.close) await core.store.close();
    throw error;
  }
}

module.exports = { startRuntime };
