'use strict';
// 模块生命周期宿主（B07）。
// 依据：方案 §4.2（模块清单契约）、§4.3（状态语义）、§8（后台按需装配）。
//
// 状态语义严格区分：
//   installed   已登记（清单通过校验），但未导入代码
//   enabled     已启用（准备启动）
//   configured  配置完整（模块 config schema 校验通过）
//   ready       依赖可用、start() 已成功、health() 为真
//
// 未安装/未启用的模块：不 import 代码、不注册路由、不启动任务。
// 停用：先 stop()，再保留数据与已登记状态。

const path = require('node:path');
const { CoreError, codes } = require('../errors');
const { validateManifest } = require('./manifest');
const { normalizeAdminContribution } = require('./admin-contribution');

class ModuleHost {
  /**
   * @param {object} options
   * @param {string} options.modulesRoot 模块根目录（模块清单内路径相对于模块自身目录解析）
   * @param {(id: string) => (object|null)} [options.configProvider] 返回该模块的配置对象
   * @param {object} [options.logger]
   */
  constructor({ modulesRoot, configProvider = null, startContext = null, logger = null } = {}) {
    if (typeof modulesRoot !== 'string' || modulesRoot.length === 0) {
      throw new CoreError(codes.INVALID_INPUT, 'ModuleHost 需要 modulesRoot', { status: 500 });
    }
    this.modulesRoot = modulesRoot;
    this.configProvider = configProvider;
    this.startContext = startContext;
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.entries = new Map(); // id -> { manifest, dir, state, instance, lastError }
  }

  /** 登记模块（仅校验清单，不导入代码）。 */
  install(manifest, { dir = null } = {}) {
    validateManifest(manifest);
    if (this.entries.has(manifest.id)) {
      throw new CoreError(codes.CONFLICT, `模块 ${manifest.id} 已登记`, { status: 409 });
    }
    const moduleDir = dir ? path.resolve(dir) : path.resolve(this.modulesRoot, manifest.id);
    const entry = {
      manifest,
      dir: moduleDir,
      state: { installed: true, enabled: false, configured: false, ready: false },
      instance: null,
      admin: null,
      adminError: null,
      startError: null
    };
    this.entries.set(manifest.id, entry);
    return this.describe(manifest.id);
  }

  describe(id) {
    const entry = this.entries.get(id);
    if (!entry) return { id, installed: false, enabled: false, configured: false, ready: false };
    return {
      id,
      version: typeof entry.manifest.version === 'string' ? entry.manifest.version : null,
      routePrefix: entry.manifest.activation && typeof entry.manifest.activation.routePrefix === 'string'
        ? entry.manifest.activation.routePrefix
        : null,
      installed: entry.state.installed,
      enabled: entry.state.enabled,
      configured: entry.state.configured,
      ready: entry.state.ready,
      startError: entry.startError,
      capabilities: ((entry.manifest.capabilities || {}).tools || [])
        .filter((t) => t.implemented === true)
        .map((t) => ({ name: t.name, access: t.access, externalEffect: t.externalEffect === true }))
    };
  }

  list() {
    return [...this.entries.keys()].sort().map((id) => this.describe(id));
  }

  /** 配置是否完整：有 schema 就校验，没有 schema 视为已配置。 */
  checkConfig(entry, config) {
    const schemaRel = entry.manifest.config && entry.manifest.config.schema;
    if (!schemaRel) return { ok: true, errors: [] };
    const schemaPath = path.resolve(entry.dir, schemaRel);
    if (!schemaPath.startsWith(entry.dir + path.sep)) {
      throw new CoreError(codes.PATH_ESCAPE, 'config.schema 越出模块目录', { status: 500 });
    }
    let schema;
    try {
      schema = JSON.parse(require('node:fs').readFileSync(schemaPath, 'utf8'));
    } catch (err) {
      return { ok: false, errors: [{ path: '$', message: 'config schema 不可读: ' + err.message }] };
    }
    const { validate } = require('../contracts/validate');
    const result = validate(schema, config === undefined ? {} : config);
    return { ok: result.valid, errors: result.errors };
  }

  /**
   * 启用模块：校验配置 → 懒加载入口 → start()。
   * 未安装模块调用 enable 会直接失败（MODULE_NOT_INSTALLED）。
   */
  async enable(id) {
    const entry = this.entries.get(id);
    if (!entry) throw new CoreError(codes.MODULE_NOT_INSTALLED, `模块 ${id} 未安装`, { status: 409 });
    if (entry.state.ready) return this.describe(id);

    const config = this.configProvider ? this.configProvider(id) : undefined;
    const check = this.checkConfig(entry, config);
    entry.state.configured = check.ok;
    if (!check.ok) {
      entry.state.enabled = false;
      entry.state.ready = false;
      throw new CoreError(codes.CONFIG_INVALID, `模块 ${id} 配置不完整`, { status: 409, details: { errors: check.errors } });
    }

    entry.state.enabled = true;
    entry.startError = null;
    const entryPath = path.resolve(entry.dir, entry.manifest.activation.serverEntry);
    if (!entryPath.startsWith(entry.dir + path.sep)) {
      entry.state.ready = false;
      throw new CoreError(codes.PATH_ESCAPE, 'serverEntry 越出模块目录', { status: 500 });
    }
    // 只有 enable 时才 require：未启用模块的代码不会进入进程。
    let mod;
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      mod = require(entryPath);
    } catch (err) {
      entry.state.ready = false;
      entry.startError = '入口加载失败: ' + err.message;
      throw new CoreError(codes.MODULE_NOT_READY, `模块 ${id} ${entry.startError}`, { status: 500 });
    }
    for (const fn of ['start', 'stop', 'health']) {
      if (typeof mod[fn] !== 'function') {
        entry.state.ready = false;
        entry.startError = `入口缺少 ${fn}()`;
        throw new CoreError(codes.MODULE_NOT_READY, `模块 ${id} 入口缺少 ${fn}()`, { status: 500 });
      }
    }
    try {
      const runtimeContext = this.startContext ? await this.startContext(id, entry) : {};
      await mod.start({ config: config === undefined ? {} : config, manifest: entry.manifest, ...runtimeContext });
      entry.instance = mod;
      entry.state.ready = true;
    } catch (err) {
      entry.instance = mod;
      entry.state.ready = false;
      entry.startError = 'start 失败: ' + err.message;
      throw new CoreError(codes.MODULE_NOT_READY, `模块 ${id} 启动失败: ${err.message}`, { status: 500 });
    }
    this.loadAdminContribution(entry);
    this.logger.info(`[module-host] ${id} ready`);
    return this.describe(id);
  }

  /**
   * 装载后台贡献（只读状态页）。失败不阻断业务模块，但会记录为不可用，
   * 后台只显示真实原因，不渲染空菜单或占位页面。
   */
  loadAdminContribution(entry) {
    entry.admin = null;
    entry.adminError = null;
    const relative = entry.manifest.activation && entry.manifest.activation.adminContribution;
    if (!relative) return;
    const target = path.resolve(entry.dir, relative);
    if (!target.startsWith(entry.dir + path.sep)) {
      entry.adminError = 'adminContribution 越出模块目录';
      this.logger.warn(`[module-host] ${entry.manifest.id} ${entry.adminError}`);
      return;
    }
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const loaded = require(target);
      if (!loaded || typeof loaded.describe !== 'function') {
        throw new Error('后台贡献必须导出 describe()');
      }
      entry.admin = loaded;
    } catch (err) {
      entry.adminError = '后台贡献加载失败: ' + err.message;
      this.logger.warn(`[module-host] ${entry.manifest.id} ${entry.adminError}`);
    }
  }

  /**
   * 后台贡献：仅在模块已启用且贡献可用时返回；未登记/未启用模块不 require 任何模块代码。
   * 返回的 contribution 已由核心收敛，可直接序列化给后台页面。
   */
  async adminFor(id) {
    const entry = this.entries.get(id);
    if (!entry) {
      return { id, installed: false, enabled: false, available: false, contribution: null, error: null };
    }
    if (!entry.state.enabled) {
      return { id, installed: true, enabled: false, available: false, contribution: null, error: null };
    }
    if (!entry.admin) {
      return {
        id,
        installed: true,
        enabled: true,
        available: false,
        contribution: null,
        error: entry.adminError || '未声明后台贡献'
      };
    }
    const config = this.configProvider ? this.configProvider(id) : undefined;
    let health;
    try {
      health = await this.health(id);
    } catch (err) {
      health = { id, ok: false, reason: err.message };
    }
    try {
      const raw = await entry.admin.describe({
        id,
        config: config === undefined ? {} : config,
        manifest: entry.manifest,
        health,
        instance: entry.instance
      });
      return {
        id,
        installed: true,
        enabled: true,
        available: true,
        contribution: normalizeAdminContribution(raw, { id }),
        error: null
      };
    } catch (err) {
      return {
        id,
        installed: true,
        enabled: true,
        available: false,
        contribution: null,
        error: '后台贡献读取失败: ' + err.message
      };
    }
  }

  /** 已登记模块的后台贡献，顺序与 list() 一致。 */
  async adminList() {
    const out = [];
    for (const summary of this.list()) out.push(await this.adminFor(summary.id));
    return out;
  }

  /** 健康探测：ready 且 health().ok 才为真。 */
  async health(id) {
    const entry = this.entries.get(id);
    if (!entry || !entry.state.enabled) return { id, ok: false, reason: entry ? 'not-enabled' : 'not-installed' };
    if (!entry.instance) return { id, ok: false, reason: 'not-started' };
    try {
      const result = await entry.instance.health();
      return { id, ok: result && result.ok === true, reason: result ? result.reason : null };
    } catch (err) {
      return { id, ok: false, reason: err.message };
    }
  }

  /** 已启用模块导出的路由（未安装/未启用模块不会出现在这里，核心据此装配）。 */
  routesFor(id) {
    const entry = this.entries.get(id);
    if (!entry || !entry.state.enabled || !entry.instance || !Array.isArray(entry.instance.routes)) return [];
    return entry.instance.routes.slice();
  }

  /** 聚合所有已启用模块的路由，供公共核心统一挂载。 */
  allRoutes() {
    const out = [];
    for (const id of [...this.entries.keys()].sort()) {
      for (const route of this.routesFor(id)) out.push({ ...route, moduleId: id });
    }
    return out;
  }

  /** 已启用模块导出的工具（供 Glim 连接层使用；只暴露 implemented 的工具）。 */
  toolsFor(id) {
    const entry = this.entries.get(id);
    if (!entry || !entry.state.enabled || !entry.instance) return {};
    return entry.instance.tools && typeof entry.instance.tools === 'object' ? entry.instance.tools : {};
  }

  /** 停用：先 stop 再标记；默认保留已登记状态与数据。 */
  async disable(id) {
    const entry = this.entries.get(id);
    if (!entry) throw new CoreError(codes.MODULE_NOT_INSTALLED, `模块 ${id} 未安装`, { status: 409 });
    if (entry.instance && typeof entry.instance.stop === 'function') {
      await entry.instance.stop();
    }
    entry.instance = null;
    entry.admin = null;
    entry.adminError = null;
    entry.state.enabled = false;
    entry.state.ready = false;
    return this.describe(id);
  }

  /** 卸载：先停用，再移除登记（数据与存储区域默认保留，由部署工具处理）。 */
  async uninstall(id) {
    if (!this.entries.has(id)) throw new CoreError(codes.MODULE_NOT_INSTALLED, `模块 ${id} 未安装`, { status: 409 });
    await this.disable(id);
    this.entries.delete(id);
    return { id, installed: false, enabled: false, configured: false, ready: false };
  }
}

module.exports = { ModuleHost };
