'use strict';
/*
 * PagesAI 公共后台外壳（P6 / 方案 §8）
 *
 * 硬性约束：
 *  - 原生 JS，零第三方依赖，不引入任何外部资源；
 *  - 只调用公共核心 API：/healthz、/readyz、/api/me、/api/modules、
 *    /api/auth/*、/api/admin/users（含按用户 ID 的 PATCH）、
 *    /api/admin/modules（含按模块 ID 的详情与 enable/disable）；
 *  - 菜单与状态卡只按 /api/modules 的 installed/已登记模块装配；未安装模块
 *    既不渲染菜单，也不请求其接口，更不请求其后台贡献；
 *  - 模块专属页面只来自模块自身的后台贡献（adminContribution）；贡献不可用时
 *    只展示真实原因，不渲染占位菜单或占位按钮；
 *  - 展示一律使用 textContent / createTextNode，不拼接 HTML；
 *  - 只有一个管理员层级（user / admin），没有第二级管理员或子角色；
 *  - 安装与升级属于部署操作，后台不做网页端安装或执行代码；启用/停用只对
 *    已登记模块调用核心既有接口，不触碰未安装模块。
 *
 * 状态语义（与 core/registry/host.js 对齐，另预留核心未来的升级标记）：
 *  未安装   not declared && not registered
 *  待配置   installed && configured === false，或已声明但核心未登记
 *  未启用   installed && configured && !enabled
 *  启动中   enabled && !ready && 无 startError
 *  可用     ready === true
 *  故障     startError 非空（含 start()/入口/迁移失败）
 *  升级中   核心返回 upgrading:true 或 state:'upgrading'（当前核心无此字段）
 */

(function () {
  // ------------------------------------------------------------ 静态展示目录
  // 仅用于展示名称与一句话用途；不含任何模块 API 路径、路由或请求逻辑。
  const MODULE_LABELS = Object.freeze({
    pages: 'Pages 建站',
    disk: 'Disk 网盘',
    glim: 'Glim 智能体',
    mail: 'Mail 邮箱',
    survey: 'Survey 问卷',
    paper: 'Paper 论文'
  });

  const MODULE_HINTS = Object.freeze({
    pages: '站点创建、文件管理与发布',
    disk: '统一逻辑盘与客户端同步',
    glim: '可独立使用的智能体与可选连接',
    mail: '验证码与通知发信、邮箱客户端能力',
    survey: '问卷创建、发布与答卷统计',
    paper: '论文阅读、翻译与问答'
  });

  const STATUS = Object.freeze({
    uninstalled: 'uninstalled',
    disabled: 'disabled',
    needsConfig: 'needs-config',
    starting: 'starting',
    ready: 'ready',
    error: 'error',
    upgrading: 'upgrading'
  });

  const STATUS_LABELS = Object.freeze({
    uninstalled: '未安装',
    disabled: '未启用',
    'needs-config': '待配置',
    starting: '启动中',
    ready: '可用',
    error: '故障',
    upgrading: '升级中'
  });

  const STATUS_HINTS = Object.freeze({
    uninstalled: '未登记且未在部署配置中声明；不装配菜单、路由与任务。',
    disabled: '已登记、配置完整，但当前未启用；可由部署侧启用。',
    'needs-config': '配置不完整或尚未完成登记；业务入口不可用。',
    starting: '已启用，尚未就绪；start() 可能仍在执行。',
    ready: 'start() 成功且健康检查为真。',
    error: '启动或健康检查异常，请查看启动错误并修复。',
    upgrading: '核心标记为升级中；完成前不要依赖该模块的状态卡。'
  });

  const ROLE_LABELS = Object.freeze({ user: '普通用户', admin: '管理员' });
  const ACCOUNT_STATUS_LABELS = Object.freeze({
    active: '正常',
    disabled: '已停用',
    pending_email: '待验证邮箱'
  });

  const ERROR_HINTS = Object.freeze({
    INVALID_CREDENTIALS: '用户名或口令不正确',
    ACCOUNT_DISABLED: '账号已被停用，请联系其他管理员',
    EMAIL_UNVERIFIED: '邮箱尚未验证，验证后才能登录',
    SESSION_INVALID: '会话已失效，请重新登录',
    SESSION_REVOKED: '会话已被撤销，请重新登录',
    FORBIDDEN: '需要管理员权限',
    LAST_ADMIN_PROTECTED: '这是最后一名有效管理员，不能降级或停用',
    REGISTRATION_CLOSED: '公开注册已关闭',
    MAIL_MODULE_REQUIRED: '启用邮箱验证注册需要先安装 Mail 模块',
    MAIL_NOT_CONFIGURED: 'Mail 模块尚未配置发信',
    MAIL_MODULE_UNAVAILABLE: '邮件模块当前不可用',
    NETWORK_ERROR: '无法连接核心服务',
    NO_USER: '核心未返回当前用户'
  });

  // ------------------------------------------------------------ 纯函数（可测试）

  function moduleLabel(id) {
    return Object.prototype.hasOwnProperty.call(MODULE_LABELS, id) ? MODULE_LABELS[id] : String(id || '');
  }

  function moduleHint(id) {
    return Object.prototype.hasOwnProperty.call(MODULE_HINTS, id) ? MODULE_HINTS[id] : '模块自述信息由模块自身提供';
  }

  function statusLabel(status) {
    return Object.prototype.hasOwnProperty.call(STATUS_LABELS, status) ? STATUS_LABELS[status] : String(status || '未知');
  }

  function roleLabel(role) {
    return Object.prototype.hasOwnProperty.call(ROLE_LABELS, role) ? ROLE_LABELS[role] : String(role || '未知');
  }

  function accountStatusLabel(status) {
    return Object.prototype.hasOwnProperty.call(ACCOUNT_STATUS_LABELS, status)
      ? ACCOUNT_STATUS_LABELS[status]
      : String(status || '未知');
  }

  function normalizeIdList(list) {
    const seen = new Set();
    const out = [];
    for (const value of Array.isArray(list) ? list : []) {
      const id = String(value === null || value === undefined ? '' : value).trim();
      if (id === '' || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  /**
   * 由核心返回的模块状态推导后台展示状态。
   * @param {{installed?:boolean,declared?:boolean,registered?:boolean,enabled?:boolean,configured?:boolean,ready?:boolean,startError?:string|null,state?:string,upgrading?:boolean}} entry
   * @returns {string} STATUS 之一
   */
  function deriveModuleStatus(entry) {
    const item = entry && typeof entry === 'object' ? entry : {};
    const declared = item.installed === true || item.declared === true;
    const registered = item.registered !== false;
    if (!declared && !registered) return STATUS.uninstalled;

    const hasStartError = typeof item.startError === 'string' && item.startError.trim() !== '';
    const stateText = String(item.state || '').trim().toLowerCase();
    const upgrading = item.upgrading === true || stateText === 'upgrading' || stateText === 'upgrade';

    if (hasStartError) return STATUS.error;
    if (upgrading) return STATUS.upgrading;
    if (item.ready === true) return STATUS.ready;
    if (item.enabled === true) return STATUS.starting;
    if (item.configured !== true) return STATUS.needsConfig;
    return STATUS.disabled;
  }

  /**
   * 解释「无副作用注册探测」的结果。
   * 探测请求固定提交空用户名 + 空口令，核心必然在校验阶段拒绝，不会创建账号：
   *  - 403 REGISTRATION_CLOSED        → 注册关闭
   *  - 409 MAIL_MODULE_REQUIRED /
   *        MAIL_NOT_CONFIGURED        → 邮箱验证注册但 Mail 不可用
   *  - 400 且提示含「邮箱」           → 邮箱验证注册
   *  - 400 且提示含「用户名」         → 用户名 + 口令注册
   */
  function classifyRegistrationProbe(result) {
    const status = Number(result && result.status) || 0;
    const code = String((result && result.code) || '');
    const message = String((result && result.message) || '');

    if (status === 403 && code === 'REGISTRATION_CLOSED') {
      return {
        mode: 'closed',
        switchLabel: '关闭',
        methodLabel: '不开放注册',
        detail: '核心返回 REGISTRATION_CLOSED：公开注册已关闭，已有账号仍可登录。',
        code
      };
    }
    if (status === 409 && (code === 'MAIL_MODULE_REQUIRED' || code === 'MAIL_NOT_CONFIGURED')) {
      return {
        mode: 'email-blocked',
        switchLabel: '开启',
        methodLabel: '邮箱验证（当前不可用）',
        detail: '核心要求邮箱验证注册，但 Mail 模块未安装或未配置发信，注册会失败。',
        code
      };
    }
    if (status === 400 && message.indexOf('邮箱') !== -1) {
      return {
        mode: 'email',
        switchLabel: '开启',
        methodLabel: '邮箱验证',
        detail: '核心要求邮箱验证后才能登录；允许的邮箱域名未在接口中暴露。',
        code
      };
    }
    if (status === 400 && message.indexOf('用户名') !== -1) {
      return {
        mode: 'username',
        switchLabel: '开启',
        methodLabel: '用户名 + 口令',
        detail: '核心按用户名 + 口令直接创建可用账号。',
        code
      };
    }
    return {
      mode: 'unknown',
      switchLabel: '无法判定',
      methodLabel: '无法判定',
      detail: '探测返回未预期结果，请检查核心版本与日志。',
      code
    };
  }

  /**
   * 菜单只装配 /api/modules 的 installed 列表；已登记但未声明的模块不进菜单。
   * @returns {{id:string,label:string,status:string}[]}
   */
  function selectMenuModules(installedIds, entries) {
    const byId = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry && typeof entry.id === 'string' && entry.id !== '') byId.set(entry.id, entry);
    }
    return normalizeIdList(installedIds).map((id) => {
      const entry = byId.get(id) || { id, installed: true, registered: false, configured: false };
      return { id, label: moduleLabel(id), status: deriveModuleStatus(entry) };
    });
  }

  function countStatuses(entries) {
    const counts = {
      uninstalled: 0,
      disabled: 0,
      'needs-config': 0,
      starting: 0,
      ready: 0,
      error: 0,
      upgrading: 0
    };
    for (const entry of Array.isArray(entries) ? entries : []) {
      counts[deriveModuleStatus(entry)] += 1;
    }
    return counts;
  }

  // 模块专属控制台路径与核心 host 的约定一致；不匹配的一律不生成链接。
  const CONSOLE_PATHS = Object.freeze({
    pages: '/pages',
    disk: '/disk',
    glim: '/glim',
    mail: '/mail',
    survey: '/survey',
    paper: '/paper'
  });

  function safeConsolePath(id, value) {
    const expected = Object.prototype.hasOwnProperty.call(CONSOLE_PATHS, id) ? CONSOLE_PATHS[id] : null;
    return expected && value === expected ? expected : null;
  }

  function clipText(value, max) {
    return String(value === null || value === undefined ? '' : value).slice(0, max);
  }

  /**
   * 收敛核心返回的后台贡献，防止越界长度或异常结构进入 DOM。
   * 核心已做一次规范化，这里仍按展示上限截断，保持外壳独立可测。
   */
  function normalizeContribution(id, raw) {
    if (!raw || typeof raw !== 'object') return null;
    const sections = [];
    for (const section of Array.isArray(raw.sections) ? raw.sections : []) {
      if (!section || typeof section !== 'object' || sections.length >= 7) continue;
      const items = [];
      for (const item of Array.isArray(section.items) ? section.items : []) {
        if (!item || typeof item !== 'object' || items.length >= 12) continue;
        items.push({ label: clipText(item.label, 40), value: clipText(item.value, 200) });
      }
      sections.push({ title: clipText(section.title, 80), items });
    }
    return {
      title: clipText(raw.title, 80),
      summary: clipText(raw.summary, 300),
      consolePath: safeConsolePath(id, raw.consolePath),
      sections
    };
  }

  /**
   * 收敛 /api/admin/modules 的 admin 数组项。
   * 未登记模块不应出现在这里；id 为空或 installed=false 的项直接丢弃。
   */
  function normalizeAdminEntry(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const id = String(source.id === undefined || source.id === null ? '' : source.id).trim();
    if (id === '' || source.installed !== true) return null;
    return {
      id,
      enabled: source.enabled === true,
      available: source.available === true,
      error: typeof source.error === 'string' && source.error.trim() !== '' ? source.error : null,
      contribution: normalizeContribution(id, source.contribution)
    };
  }

  function formatTimestamp(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = (n) => String(n).padStart(2, '0');
    return (
      date.getFullYear() +
      '-' +
      pad(date.getMonth() + 1) +
      '-' +
      pad(date.getDate()) +
      ' ' +
      pad(date.getHours()) +
      ':' +
      pad(date.getMinutes()) +
      ':' +
      pad(date.getSeconds())
    );
  }

  const internals = Object.freeze({
    STATUS,
    STATUS_LABELS,
    MODULE_LABELS,
    moduleLabel,
    moduleHint,
    statusLabel,
    roleLabel,
    accountStatusLabel,
    normalizeIdList,
    deriveModuleStatus,
    classifyRegistrationProbe,
    selectMenuModules,
    countStatuses,
    normalizeContribution,
    normalizeAdminEntry,
    safeConsolePath,
    formatTimestamp
  });

  // 只读调试导出：便于在 Node 里用 vm 直接验证纯函数，不产生任何请求或写入。
  if (typeof window !== 'undefined') window.__pagesaiAdminInternals = internals;

  if (typeof document === 'undefined' || !document || typeof document.getElementById !== 'function') return;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init(), { once: true });
  } else {
    init();
  }

  // ------------------------------------------------------------ DOM 外壳

  function init() {
    const state = {
      me: null,
      modules: [],
      installed: [],
      adminModules: null,
      adminModulesNote: null,
      users: [],
      probe: null,
      diagnostics: null,
      activePanel: 'overview',
      refreshing: false
    };

    const byId = (id) => document.getElementById(id);

    const dom = {
      sessionUser: byId('session-user'),
      logout: byId('logout'),
      globalMessage: byId('global-message'),
      views: {
        login: byId('view-login'),
        denied: byId('view-denied'),
        dashboard: byId('view-dashboard')
      },
      loginForm: byId('login-form'),
      loginUsername: byId('login-username'),
      loginPassword: byId('login-password'),
      loginSubmit: byId('login-submit'),
      loginError: byId('login-error'),
      loginHealth: byId('login-health'),
      deniedUser: byId('denied-user'),
      deniedRecheck: byId('denied-recheck'),
      deniedLogout: byId('denied-logout'),
      navModules: byId('nav-modules'),
      modulesSummary: byId('modules-summary'),
      modulesInstalled: byId('modules-installed'),
      modulesUninstalled: byId('modules-uninstalled'),
      modulesRefresh: byId('modules-refresh'),
      usersCount: byId('users-count'),
      usersBody: byId('users-body'),
      usersEmpty: byId('users-empty'),
      usersRefresh: byId('users-refresh'),
      regSwitch: byId('reg-switch'),
      regMethod: byId('reg-method'),
      regMail: byId('reg-mail'),
      regDomains: byId('reg-domains'),
      regTime: byId('reg-time'),
      regDetail: byId('reg-detail'),
      regProbe: byId('reg-probe'),
      diagHealth: byId('diag-health'),
      diagReady: byId('diag-ready'),
      diagDataroot: byId('diag-dataroot'),
      diagModcount: byId('diag-modcount'),
      diagInstalledcount: byId('diag-installedcount'),
      diagCapcount: byId('diag-capcount'),
      diagTime: byId('diag-time'),
      diagRefresh: byId('diag-refresh'),
      overviewUser: byId('overview-user'),
      overviewRole: byId('overview-role'),
      overviewEmail: byId('overview-email'),
      overviewCreated: byId('overview-created'),
      overviewModules: byId('overview-modules'),
      overviewUsers: byId('overview-users'),
      overviewDiagnostics: byId('overview-diagnostics'),
      overviewRefresh: byId('overview-refresh')
    };

    if (!dom.views.login || !dom.views.dashboard || !dom.loginForm || !dom.globalMessage) {
      // 页面被裁剪或加载了错误资源时，不抛异常，只在控制台提示。
      window.console.warn('[admin] 页面结构不完整，后台脚本已退出。');
      return;
    }

    // ---------------------------------------------------------- 基础工具

    function h(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = String(text);
      return node;
    }

    function clear(node) {
      if (!node) return;
      while (node.firstChild) node.removeChild(node.firstChild);
    }

    function nowMs() {
      return typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    }

    function describeError(err) {
      if (!err) return '未知错误';
      const code = err.code ? String(err.code) : '';
      const message = err.message ? String(err.message) : '请求失败';
      const hint = code && ERROR_HINTS[code] ? ERROR_HINTS[code] : '';
      if (hint && hint !== message) return message + '（' + code + '）— ' + hint;
      return code ? message + '（' + code + '）' : message;
    }

    // ---------------------------------------------------------- 网络层
    // 唯一的 fetch 出口：所有请求都经过这里，便于自检脚本静态核对。

    class ApiError extends Error {
      constructor(message, options) {
        super(message);
        const opts = options || {};
        this.name = 'ApiError';
        this.status = Number(opts.status) || 0;
        this.code = opts.code ? String(opts.code) : '';
        this.details = opts.details === undefined ? null : opts.details;
      }
    }

    async function callApi(path, options) {
      const opts = options || {};
      const init = {
        method: opts.method || 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        cache: 'no-store'
      };
      if (opts.body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
      }

      let response;
      try {
        response = await fetch(path, init);
      } catch (err) {
        throw new ApiError('无法连接核心服务，请确认服务在运行且同源可访问', {
          status: 0,
          code: 'NETWORK_ERROR'
        });
      }

      let payload = null;
      const text = await response.text();
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch (err) {
          payload = null;
        }
      }

      if (!response.ok) {
        const data = payload && typeof payload === 'object' ? payload : {};
        // 模块启用/停用失败时核心返回 { module, error: { code, message, details } }。
        const body = data.error && typeof data.error === 'object' ? data.error : data;
        throw new ApiError(body.message ? String(body.message) : '请求失败', {
          status: response.status,
          code: body.code ? String(body.code) : 'HTTP_' + response.status,
          details: body.details === undefined ? null : body.details
        });
      }
      return payload && typeof payload === 'object' ? payload : {};
    }

    /** 探测单个端点：失败也返回结果，不抛异常，便于诊断页展示。 */
    async function probeEndpoint(path) {
      const started = nowMs();
      try {
        const data = await callApi(path);
        return { ok: true, status: 200, ms: Math.max(0, Math.round(nowMs() - started)), data };
      } catch (err) {
        return {
          ok: false,
          status: err && err.status ? err.status : 0,
          ms: Math.max(0, Math.round(nowMs() - started)),
          code: err && err.code ? err.code : '',
          message: err && err.message ? err.message : '探测失败'
        };
      }
    }

    // ---------------------------------------------------------- 视图与提示

    function setGlobalMessage(kind, text) {
      const box = dom.globalMessage;
      if (!box) return;
      clear(box);
      box.hidden = !text;
      box.className = 'banner' + (kind ? ' banner--' + kind : '');
      if (!text) return;
      box.appendChild(h('span', 'banner__text', text));
      if (kind === 'error') {
        const close = h('button', 'banner__close', '关闭');
        close.type = 'button';
        close.addEventListener('click', () => {
          box.hidden = true;
        });
        box.appendChild(close);
      }
    }

    function setLoginError(text) {
      const node = dom.loginError;
      if (!node) return;
      node.textContent = text ? String(text) : '';
      node.hidden = !text;
    }

    function clearLoginError() {
      setLoginError('');
    }

    function showView(name) {
      Object.keys(dom.views).forEach((key) => {
        const node = dom.views[key];
        if (node) node.hidden = key !== name;
      });
    }

    function showPanel(name) {
      const target = name || 'overview';
      state.activePanel = target;
      const sections = document.querySelectorAll('[data-panel]');
      for (const section of sections) {
        const active = section.getAttribute('data-panel') === target;
        section.hidden = !active;
        if (active) section.setAttribute('aria-current', 'true');
        else section.removeAttribute('aria-current');
      }
      const buttons = document.querySelectorAll('[data-panel-target]');
      for (const button of buttons) {
        if (button.getAttribute('data-panel-target') === target) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      }
    }

    function showLogin(message) {
      showView('login');
      if (message) setLoginError(message);
      else clearLoginError();
      renderSession();
      probeLoginHealth();
    }

    function showDenied() {
      showView('denied');
      if (dom.deniedUser) {
        dom.deniedUser.textContent = state.me
          ? state.me.username + '（' + roleLabel(state.me.role) + '）'
          : '—';
      }
      renderSession();
    }

    function handleSessionLost() {
      state.me = null;
      state.users = [];
      state.modules = [];
      state.installed = [];
      state.adminModules = null;
      state.adminModulesNote = null;
      state.probe = null;
      state.diagnostics = null;
      renderSession();
      showLogin('会话已失效，请重新登录。');
    }

    function handleError(err, prefix) {
      if (err && err.status === 401) {
        handleSessionLost();
        return;
      }
      const text = prefix ? prefix + '：' + describeError(err) : describeError(err);
      setGlobalMessage('error', text);
    }

    function renderSession() {
      if (dom.sessionUser) {
        dom.sessionUser.textContent = state.me
          ? state.me.username + '（' + roleLabel(state.me.role) + '）'
          : '未登录';
      }
      if (dom.logout) dom.logout.hidden = !state.me;
    }

    // ---------------------------------------------------------- 数据加载

    async function refreshModules() {
      const data = await callApi('/api/modules');
      const rawModules = Array.isArray(data.modules) ? data.modules : [];
      state.modules = rawModules
        .map((raw) => normalizeModuleEntry(raw))
        .filter((entry) => entry.id !== '');
      state.installed = normalizeIdList(data.installed);
    }

    /**
     * 读取模块后台贡献。只有管理员可访问；核心较旧（404）或当前会话无权（403）时
     * 记一条真实原因，不阻塞其他面板，也不渲染任何占位内容。
     */
    async function refreshAdminModules() {
      try {
        const data = await callApi('/api/admin/modules');
        const map = new Map();
        for (const raw of Array.isArray(data.admin) ? data.admin : []) {
          const entry = normalizeAdminEntry(raw);
          if (entry) map.set(entry.id, entry);
        }
        state.adminModules = map;
        state.adminModulesNote = null;
      } catch (err) {
        state.adminModules = new Map();
        if (err && err.status === 404) {
          state.adminModulesNote = '核心未提供 /api/admin/modules（404），模块后台信息不可用。';
          return;
        }
        if (err && err.status === 403) {
          state.adminModulesNote = '当前会话无权读取模块后台贡献（403）。';
          return;
        }
        throw err;
      }
    }

    async function refreshUsers() {
      const data = await callApi('/api/admin/users');
      state.users = Array.isArray(data.users) ? data.users.filter((user) => user && typeof user === 'object') : [];
    }

    async function refreshDiagnostics() {
      const health = await probeEndpoint('/healthz');
      const ready = await probeEndpoint('/readyz');
      state.diagnostics = { health, ready, at: new Date().toISOString() };
    }

    async function refreshProbe() {
      try {
        await callApi('/api/auth/register', {
          method: 'POST',
          body: { username: '', password: '', email: '' }
        });
        // 当前核心的校验必然拒绝空用户名/空口令；走到这里说明校验被改动，需要人工确认。
        state.probe = {
          mode: 'unexpected',
          switchLabel: '无法判定',
          methodLabel: '无法判定',
          detail: '无副作用探测意外成功：核心可能改动了注册校验，请立即检查核心版本与新增账号。',
          code: 'UNEXPECTED_SUCCESS',
          at: new Date().toISOString()
        };
      } catch (err) {
        if (err && err.status === 401) throw err;
        const classified = classifyRegistrationProbe(err);
        state.probe = {
          mode: classified.mode,
          switchLabel: classified.switchLabel,
          methodLabel: classified.methodLabel,
          detail: classified.detail,
          code: classified.code,
          at: new Date().toISOString()
        };
      }
    }

    async function refreshAll(options) {
      const opts = options || {};
      if (!state.me || state.me.role !== 'admin' || state.refreshing) return;
      state.refreshing = true;
      const failures = [];
      try {
        const tasks = [
          { name: '模块状态', run: refreshModules },
          { name: '模块后台', run: refreshAdminModules },
          { name: '账号列表', run: refreshUsers },
          { name: '运行诊断', run: refreshDiagnostics },
          { name: '注册配置', run: refreshProbe }
        ];
        for (const task of tasks) {
          try {
            await task.run();
          } catch (err) {
            if (err && err.status === 401) {
              handleSessionLost();
              return;
            }
            failures.push(task.name + '：' + describeError(err));
          }
        }
      } finally {
        state.refreshing = false;
      }

      renderAll();
      if (failures.length > 0) {
        setGlobalMessage('error', '部分数据刷新失败 — ' + failures.join('；'));
      } else if (!opts.silent) {
        setGlobalMessage('success', '已刷新：模块与后台贡献、账号、注册配置与运行诊断。');
      }
    }

    async function start(options) {
      const opts = options || {};
      try {
        const data = await callApi('/api/me');
        const user = data && data.user ? data.user : null;
        if (!user || typeof user !== 'object') {
          throw new ApiError('核心未返回当前用户', { status: 500, code: 'NO_USER' });
        }
        state.me = user;
        renderSession();
        if (user.role !== 'admin') {
          showDenied();
          return;
        }
        showView('dashboard');
        showPanel(state.activePanel || 'overview');
        await refreshAll({ silent: true });
        if (opts.notice) setGlobalMessage('success', opts.notice);
      } catch (err) {
        state.me = null;
        renderSession();
        if (err && err.status === 401) {
          showLogin();
          return;
        }
        showLogin(describeError(err));
      }
    }

    // ---------------------------------------------------------- 登录 / 退出

    async function login() {
      clearLoginError();
      const username = dom.loginUsername ? String(dom.loginUsername.value || '').trim() : '';
      const password = dom.loginPassword ? String(dom.loginPassword.value || '') : '';
      if (username.length < 3) {
        setLoginError('用户名至少 3 位。');
        return;
      }
      if (password.length < 8) {
        setLoginError('口令至少 8 位。');
        return;
      }
      if (dom.loginSubmit) dom.loginSubmit.disabled = true;
      try {
        await callApi('/api/auth/login', { method: 'POST', body: { username, password } });
        if (dom.loginPassword) dom.loginPassword.value = '';
        await start({ notice: '登录成功。' });
      } catch (err) {
        setLoginError(describeError(err));
      } finally {
        if (dom.loginSubmit) dom.loginSubmit.disabled = false;
      }
    }

    async function logout() {
      const buttons = [dom.logout, dom.deniedLogout].filter(Boolean);
      for (const button of buttons) button.disabled = true;
      try {
        await callApi('/api/auth/logout', { method: 'POST' });
      } catch (err) {
        if (err && err.status && err.status !== 401) setGlobalMessage('error', describeError(err));
      } finally {
        for (const button of buttons) button.disabled = false;
      }
      state.me = null;
      state.users = [];
      state.modules = [];
      state.installed = [];
      state.adminModules = null;
      state.adminModulesNote = null;
      state.probe = null;
      state.diagnostics = null;
      renderSession();
      showLogin('已退出登录。');
    }

    async function probeLoginHealth() {
      if (!dom.loginHealth) return;
      dom.loginHealth.textContent = '核心存活探测中…';
      const result = await probeEndpoint('/healthz');
      dom.loginHealth.textContent = result.ok
        ? '核心存活：是（' + result.ms + ' ms）'
        : '核心存活：否（' + (result.code || result.status || '未知') + '）';
    }

    // ---------------------------------------------------------- 渲染：菜单

    function buildEntries() {
      const registered = new Map(state.modules.map((entry) => [entry.id, entry]));
      const installed = normalizeIdList(state.installed);
      const out = [];
      const seen = new Set();
      for (const id of installed) {
        seen.add(id);
        const raw = registered.get(id);
        if (raw) {
          out.push(Object.assign({}, raw, { declared: true, registered: true }));
        } else {
          out.push({
            id,
            declared: true,
            registered: false,
            installed: true,
            enabled: false,
            configured: false,
            ready: false,
            startError: null,
            state: '',
            upgrading: false,
            capabilities: []
          });
        }
      }
      for (const entry of state.modules) {
        if (seen.has(entry.id)) continue;
        out.push(Object.assign({}, entry, { declared: false, registered: true }));
      }
      return out.sort((a, b) => a.id.localeCompare(b.id));
    }

    function renderMenu() {
      const nav = dom.navModules;
      if (!nav) return;
      clear(nav);

      const title = h('p', 'nav__title', '模块');
      nav.appendChild(title);

      const items = selectMenuModules(state.installed, buildEntries());
      if (items.length === 0) {
        nav.appendChild(
          h('p', 'hint hint--small', '当前部署未安装任何业务模块（core-only）：不渲染模块菜单，也不请求模块接口。')
        );
        return;
      }

      for (const item of items) {
        const button = h('button', 'nav__item nav__item--module');
        button.type = 'button';
        const dot = h('span', 'dot dot--' + item.status);
        dot.setAttribute('aria-hidden', 'true');
        button.appendChild(dot);
        button.appendChild(h('span', 'nav__item-label', item.label));
        button.appendChild(h('span', 'nav__item-state', statusLabel(item.status)));
        button.addEventListener('click', () => {
          showPanel('modules');
          focusModule(item.id);
        });
        nav.appendChild(button);
      }
    }

    function focusModule(id) {
      const card = document.getElementById('module-card-' + id);
      if (!card) return;
      card.classList.add('is-highlight');
      if (typeof card.scrollIntoView === 'function') card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      window.setTimeout(() => card.classList.remove('is-highlight'), 1800);
    }

    // ---------------------------------------------------------- 渲染：模块状态

    function renderModules() {
      const entries = buildEntries();
      const counts = countStatuses(entries);

      if (dom.modulesSummary) {
        dom.modulesSummary.textContent =
          '已声明/已登记 ' +
          entries.length +
          ' 个：可用 ' +
          counts.ready +
          '，故障 ' +
          counts.error +
          '，启动中 ' +
          counts.starting +
          '，待配置 ' +
          counts['needs-config'] +
          '，未启用 ' +
          counts.disabled +
          '，升级中 ' +
          counts.upgrading;
      }

      if (dom.modulesInstalled) {
        clear(dom.modulesInstalled);
        if (entries.length === 0) {
          dom.modulesInstalled.appendChild(h('p', 'empty', '当前没有已登记或已声明的模块。'));
        } else {
          for (const entry of entries) dom.modulesInstalled.appendChild(renderModuleCard(entry));
        }
      }

      if (dom.modulesUninstalled) {
        clear(dom.modulesUninstalled);
        const present = new Set(entries.map((entry) => entry.id));
        const absent = Object.keys(MODULE_LABELS).filter((id) => !present.has(id));
        if (absent.length === 0) {
          dom.modulesUninstalled.appendChild(h('p', 'empty', '已知模块均已安装或已声明。'));
        } else {
          const list = h('ul', 'list');
          for (const id of absent) {
            const item = h('li');
            item.appendChild(h('span', 'badge badge--uninstalled', statusLabel(STATUS.uninstalled)));
            item.appendChild(document.createTextNode(' ' + moduleLabel(id) + '（' + id + '）：不渲染菜单，也不请求其接口。'));
            list.appendChild(item);
          }
          dom.modulesUninstalled.appendChild(list);
        }
      }
    }

    function renderModuleCard(entry) {
      const status = deriveModuleStatus(entry);
      const card = h('article', 'card module-card');
      card.id = 'module-card-' + entry.id;

      const head = h('div', 'module-card__head');
      const title = h('div', 'module-card__title-wrap');
      title.appendChild(h('h3', 'module-card__title', moduleLabel(entry.id)));
      title.appendChild(h('p', 'module-card__id', entry.id));
      head.appendChild(title);

      const badge = h('span', 'badge badge--' + status, statusLabel(status));
      badge.title = STATUS_HINTS[status] || '';
      head.appendChild(badge);
      card.appendChild(head);

      card.appendChild(h('p', 'module-card__hint', moduleHint(entry.id)));

      const facts = h('dl', 'facts facts--compact');
      appendFact(facts, '部署声明', entry.declared ? '是' : '否（核心已登记，部署配置未声明）');
      appendFact(facts, '已登记', entry.registered ? '是' : '否（清单未登记）');
      appendFact(facts, '已启用', entry.enabled ? '是' : '否');
      appendFact(facts, '配置完整', entry.configured ? '是' : '否');
      appendFact(facts, '就绪', entry.ready ? '是' : '否');
      appendFact(facts, '状态说明', STATUS_HINTS[status] || '—');
      card.appendChild(facts);

      if (entry.startError) {
        card.appendChild(h('p', 'module-card__error', '启动错误：' + entry.startError));
      }
      if (status === STATUS.error) {
        card.appendChild(
          h(
            'p',
            'module-card__action',
            '修复动作：检查模块配置、依赖与启动日志；修复后由部署工具重新启用。若为数据库迁移失败，不得重建空库，应先备份再按迁移脚本处理。'
          )
        );
      }

      const adminBlock = renderModuleAdmin(entry);
      if (adminBlock) card.appendChild(adminBlock);

      const caps = h('div', 'capabilities');
      caps.appendChild(h('p', 'facts__title', '可用能力（仅 implemented=true）'));
      if (!entry.capabilities || entry.capabilities.length === 0) {
        caps.appendChild(h('p', 'empty', '无已实现能力'));
      } else {
        const list = h('ul', 'chips');
        for (const capability of entry.capabilities) {
          const chip = h('li', 'chip');
          chip.appendChild(h('span', 'chip__name', capability.name));
          chip.appendChild(h('span', 'chip__access', capability.access === 'write' ? '写' : '读'));
          if (capability.externalEffect) chip.appendChild(h('span', 'chip__effect', '对外后果'));
          list.appendChild(chip);
        }
        caps.appendChild(list);
      }
      card.appendChild(caps);
      card.appendChild(renderModuleControls(entry));
      return card;
    }

    /**
     * 模块后台贡献：只展示核心已收敛的数据与模块自身声明的控制台路径。
     * 未启用/不可用时只说明真实原因，不生成空菜单或占位链接。
     */
    function renderModuleAdmin(entry) {
      if (!entry.registered) {
        return h('p', 'hint hint--small', '核心尚未登记该模块：不加载后台贡献。');
      }

      const wrap = h('div', 'module-card__admin');
      wrap.appendChild(h('p', 'facts__title', '模块后台'));

      if (state.adminModules === null) {
        wrap.appendChild(h('p', 'empty', '后台贡献尚未加载。'));
        return wrap;
      }
      if (state.adminModulesNote) {
        wrap.appendChild(h('p', 'empty', state.adminModulesNote));
        return wrap;
      }

      const record = state.adminModules.get(entry.id);
      if (!record) {
        wrap.appendChild(h('p', 'empty', '核心未返回该模块的后台信息。'));
        return wrap;
      }

      if (!entry.enabled) {
        wrap.appendChild(h('p', 'empty', '模块未启用：启用后才加载后台贡献。'));
        return wrap;
      }
      if (!record.available || !record.contribution) {
        wrap.appendChild(
          h('p', 'empty', '后台贡献不可用：' + (record.error || '未声明后台贡献'))
        );
        return wrap;
      }

      const contribution = record.contribution;
      if (contribution.summary) {
        wrap.appendChild(h('p', 'module-card__hint', contribution.summary));
      }
      if (contribution.consolePath) {
        if (entry.ready) {
          const link = h(
            'a',
            'btn btn--small',
            '打开「' + (contribution.title || moduleLabel(entry.id)) + '」控制台'
          );
          link.href = contribution.consolePath;
          wrap.appendChild(link);
        } else {
          wrap.appendChild(h('p', 'hint hint--small', '控制台在模块就绪后可用。'));
        }
      }
      for (const section of contribution.sections) {
        const block = h('section', 'module-card__admin-section');
        block.appendChild(h('h4', 'facts__title', section.title || '—'));
        if (section.items.length === 0) {
          block.appendChild(h('p', 'empty', '暂无条目'));
        } else {
          const facts = h('dl', 'facts facts--compact');
          for (const item of section.items) appendFact(facts, item.label || '—', item.value || '—');
          block.appendChild(facts);
        }
        wrap.appendChild(block);
      }
      return wrap;
    }

    /**
     * 启用/停用只调用核心既有接口，且只对已登记模块显示。
     * 安装与升级仍属于部署操作，这里没有对应按钮。
     */
    function renderModuleControls(entry) {
      const wrap = h('div', 'module-card__actions');
      if (!entry.registered) {
        wrap.appendChild(
          h('span', 'hint hint--small', '部署侧完成登记后才可从后台启用或停用。')
        );
        return wrap;
      }

      const enabled = entry.enabled === true;
      const button = h(
        'button',
        'btn btn--small ' + (enabled ? 'btn--danger' : 'btn--ghost'),
        enabled ? '停用模块' : '启用模块'
      );
      button.type = 'button';
      button.addEventListener('click', () => toggleModule(entry, button));
      wrap.appendChild(button);
      wrap.appendChild(
        h(
          'span',
          'hint hint--small',
          enabled
            ? '停用先执行 stop()，再摘除路由与任务；数据与登记状态保留。'
            : '启用按部署配置校验并执行 start()；失败时保留登记与数据。'
        )
      );
      return wrap;
    }

    async function toggleModule(entry, button) {
      const enabled = entry.enabled === true;
      const label = moduleLabel(entry.id);
      const prompt = enabled
        ? '停用「' + label + '」？已挂载的路由与任务会停止，数据与登记状态保留。'
        : '启用「' + label + '」？将按部署配置校验并启动模块。';
      if (!window.confirm(prompt)) return;

      button.disabled = true;
      try {
        await callApi(
          '/api/admin/modules/' + encodeURIComponent(entry.id) + '/' + (enabled ? 'disable' : 'enable'),
          { method: 'POST' }
        );
        setGlobalMessage('success', '已' + (enabled ? '停用' : '启用') + '「' + label + '」。');
        await refreshModules();
        await refreshAdminModules();
        renderMenu();
        renderModules();
        renderOverview();
      } catch (err) {
        if (!err || err.status !== 401) {
          handleError(err, (enabled ? '停用' : '启用') + '模块失败');
        } else {
          handleSessionLost();
        }
        button.disabled = false;
      }
    }

    function appendFact(list, term, value) {
      const row = h('div', 'facts__row');
      row.appendChild(h('dt', null, term));
      row.appendChild(h('dd', null, value));
      list.appendChild(row);
    }

    // ---------------------------------------------------------- 渲染：账号

    function activeAdminCount() {
      return state.users.filter(
        (user) => user && user.role === 'admin' && user.status === 'active'
      ).length;
    }

    function sortUsers(users) {
      return users.slice().sort((a, b) => {
        const aAdmin = a && a.role === 'admin' ? 0 : 1;
        const bAdmin = b && b.role === 'admin' ? 0 : 1;
        if (aAdmin !== bAdmin) return aAdmin - bAdmin;
        return String((a && a.username) || '').localeCompare(String((b && b.username) || ''), 'zh-Hans-CN');
      });
    }

    function renderAccounts() {
      if (dom.usersCount) {
        dom.usersCount.textContent =
          '共 ' + state.users.length + ' 个账号（有效管理员 ' + activeAdminCount() + '）';
      }
      const body = dom.usersBody;
      if (!body) return;
      clear(body);

      const users = sortUsers(state.users);
      if (dom.usersEmpty) dom.usersEmpty.hidden = users.length > 0;
      if (users.length === 0) return;

      for (const user of users) body.appendChild(renderUserRow(user));
    }

    function renderUserRow(user) {
      const row = h('tr');
      const isSelf = Boolean(state.me && user.id === state.me.id);
      const admins = activeAdminCount();
      const soleActiveAdmin =
        admins === 1 && user.role === 'admin' && user.status === 'active';

      const nameCell = h('td');
      nameCell.appendChild(h('strong', null, String(user.username || '—')));
      if (isSelf) nameCell.appendChild(h('span', 'tag tag--self', '当前账号'));
      row.appendChild(nameCell);

      const roleCell = h('td');
      const select = document.createElement('select');
      select.className = 'select';
      select.setAttribute('aria-label', '角色：' + String(user.username || ''));
      for (const value of ['user', 'admin']) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = roleLabel(value);
        select.appendChild(option);
      }
      select.value = user.role === 'admin' ? 'admin' : 'user';
      select.disabled = isSelf || soleActiveAdmin;
      if (isSelf) select.title = '不能在这里修改当前登录账号的角色';
      else if (soleActiveAdmin) select.title = '最后一名有效管理员不可降级';
      select.addEventListener('change', () => changeRole(user, select));
      roleCell.appendChild(select);
      row.appendChild(roleCell);

      const statusCell = h('td');
      const statusBadge = h(
        'span',
        'badge badge--' + (user.status === 'active' ? 'ready' : user.status === 'disabled' ? 'disabled' : 'needs-config'),
        accountStatusLabel(user.status)
      );
      statusCell.appendChild(statusBadge);
      const toggle = h(
        'button',
        'btn btn--small ' + (user.status === 'disabled' ? 'btn--ghost' : 'btn--danger'),
        user.status === 'disabled' ? '启用' : '停用'
      );
      toggle.type = 'button';
      toggle.disabled = isSelf || soleActiveAdmin;
      if (isSelf) toggle.title = '不能停用当前登录账号';
      else if (soleActiveAdmin) toggle.title = '最后一名有效管理员不可停用';
      toggle.addEventListener('click', () => toggleStatus(user, toggle));
      statusCell.appendChild(document.createTextNode(' '));
      statusCell.appendChild(toggle);
      row.appendChild(statusCell);

      const emailCell = h('td');
      if (user.email) {
        emailCell.appendChild(document.createTextNode(String(user.email)));
        emailCell.appendChild(
          h('span', 'tag', user.emailVerified ? '已验证' : '未验证')
        );
      } else {
        emailCell.textContent = '—';
      }
      row.appendChild(emailCell);

      row.appendChild(h('td', 'mono', formatTimestamp(user.createdAt)));

      const idCell = h('td', 'mono mono--id');
      const idText = String(user.id || '');
      idCell.textContent = idText ? idText.slice(0, 8) + '…' : '—';
      idCell.title = idText;
      row.appendChild(idCell);

      return row;
    }

    async function changeRole(user, select) {
      const previous = user.role === 'admin' ? 'admin' : 'user';
      const next = select.value;
      if (next === previous) return;

      const confirmed = window.confirm(
        '确认把「' + String(user.username || '') + '」的角色改为 ' + roleLabel(next) + '？'
      );
      if (!confirmed) {
        select.value = previous;
        return;
      }

      select.disabled = true;
      try {
        await callApi(`/api/admin/users/${encodeURIComponent(user.id)}`, {
          method: 'PATCH',
          body: { role: next }
        });
        setGlobalMessage('success', '已把「' + String(user.username || '') + '」的角色改为 ' + roleLabel(next) + '。');
        await refreshUsers();
        renderAccounts();
        renderOverview();
      } catch (err) {
        select.value = previous;
        handleError(err, '修改角色失败');
        select.disabled = false;
      }
    }

    async function toggleStatus(user, button) {
      const disabling = user.status !== 'disabled';
      const prompt = disabling
        ? '停用「' + String(user.username || '') + '」？该账号的全部会话会被清除，直到重新启用。'
        : '启用「' + String(user.username || '') + '」？启用后该账号可用原口令登录。';
      if (!window.confirm(prompt)) return;

      button.disabled = true;
      try {
        await callApi(`/api/admin/users/${encodeURIComponent(user.id)}`, {
          method: 'PATCH',
          body: { status: disabling ? 'disabled' : 'active' }
        });
        setGlobalMessage('success', '已' + (disabling ? '停用' : '启用') + '「' + String(user.username || '') + '」。');
        await refreshUsers();
        renderAccounts();
        renderOverview();
      } catch (err) {
        handleError(err, '更新账号状态失败');
        button.disabled = false;
      }
    }

    // ---------------------------------------------------------- 渲染：注册配置

    function renderRegistration() {
      const installedSet = new Set(normalizeIdList(state.installed));
      if (dom.regMail) {
        dom.regMail.textContent = installedSet.has('mail')
          ? '已安装'
          : '未安装（邮箱验证注册不可用）';
      }

      const probe = state.probe;
      if (!probe) {
        if (dom.regSwitch) dom.regSwitch.textContent = '尚未探测';
        if (dom.regMethod) dom.regMethod.textContent = '尚未探测';
        if (dom.regDomains) dom.regDomains.textContent = '—';
        if (dom.regTime) dom.regTime.textContent = '—';
        if (dom.regDetail) dom.regDetail.textContent = '尚未探测。';
        return;
      }

      if (dom.regSwitch) dom.regSwitch.textContent = probe.switchLabel;
      if (dom.regMethod) dom.regMethod.textContent = probe.methodLabel;
      if (dom.regDomains) dom.regDomains.textContent = '接口未提供（不猜测）';
      if (dom.regTime) dom.regTime.textContent = formatTimestamp(probe.at);
      if (dom.regDetail) {
        dom.regDetail.textContent = probe.code ? probe.detail + '（' + probe.code + '）' : probe.detail;
      }
    }

    // ---------------------------------------------------------- 渲染：诊断

    function renderEndpointResult(node, result) {
      if (!node) return;
      clear(node);
      if (!result) {
        node.textContent = '—';
        return;
      }
      if (result.ok) {
        node.appendChild(h('span', 'badge badge--ready', '200'));
        node.appendChild(document.createTextNode(' · ' + result.ms + ' ms'));
        return;
      }
      node.appendChild(h('span', 'badge badge--error', String(result.status || '失败')));
      const detail = [result.code, result.message].filter(Boolean).join(' ');
      node.appendChild(document.createTextNode(' · ' + (detail || '探测失败')));
    }

    function renderDiagnostics() {
      const diag = state.diagnostics;
      if (!diag) {
        renderEndpointResult(dom.diagHealth, null);
        renderEndpointResult(dom.diagReady, null);
        if (dom.diagDataroot) dom.diagDataroot.textContent = '—';
        if (dom.diagModcount) dom.diagModcount.textContent = '—';
        if (dom.diagInstalledcount) dom.diagInstalledcount.textContent = '—';
        if (dom.diagCapcount) dom.diagCapcount.textContent = '—';
        if (dom.diagTime) dom.diagTime.textContent = '—';
        return;
      }

      renderEndpointResult(dom.diagHealth, diag.health);
      renderEndpointResult(dom.diagReady, diag.ready);

      const readyData = diag.ready && diag.ready.ok && diag.ready.data ? diag.ready.data : null;
      if (dom.diagDataroot) {
        dom.diagDataroot.textContent = readyData && readyData.dataRoot ? String(readyData.dataRoot) : '—';
      }
      if (dom.diagModcount) {
        dom.diagModcount.textContent =
          readyData && Array.isArray(readyData.modules) ? String(readyData.modules.length) : '—';
      }
      if (dom.diagInstalledcount) dom.diagInstalledcount.textContent = String(normalizeIdList(state.installed).length);
      if (dom.diagCapcount) {
        const total = state.modules.reduce(
          (sum, entry) => sum + (Array.isArray(entry.capabilities) ? entry.capabilities.length : 0),
          0
        );
        dom.diagCapcount.textContent = String(total);
      }
      if (dom.diagTime) dom.diagTime.textContent = formatTimestamp(diag.at);
    }

    // ---------------------------------------------------------- 渲染：概览

    function renderOverview() {
      const me = state.me;
      if (dom.overviewUser) dom.overviewUser.textContent = me ? String(me.username || '—') : '—';
      if (dom.overviewRole) dom.overviewRole.textContent = me ? roleLabel(me.role) : '—';
      if (dom.overviewEmail) {
        dom.overviewEmail.textContent = me && me.email
          ? String(me.email) + (me.emailVerified ? '（已验证）' : '（未验证）')
          : '—（用户名注册）';
      }
      if (dom.overviewCreated) dom.overviewCreated.textContent = me ? formatTimestamp(me.createdAt) : '—';

      const counts = countStatuses(buildEntries());
      if (dom.overviewModules) {
        dom.overviewModules.textContent =
          '已安装/已声明 ' +
          normalizeIdList(state.installed).length +
          '，已登记 ' +
          state.modules.length +
          '，可用 ' +
          counts.ready +
          '，异常 ' +
          counts.error;
      }
      if (dom.overviewUsers) {
        dom.overviewUsers.textContent =
          state.users.length > 0
            ? '共 ' + state.users.length + ' 个账号，有效管理员 ' + activeAdminCount()
            : '尚未加载';
      }
      if (dom.overviewDiagnostics) {
        const ready = state.diagnostics && state.diagnostics.ready;
        if (!ready) dom.overviewDiagnostics.textContent = '尚未完成';
        else if (ready.ok) {
          const dataRoot = ready.data && ready.data.dataRoot ? String(ready.data.dataRoot) : '—';
          dom.overviewDiagnostics.textContent = '就绪（' + ready.ms + ' ms），数据根 ' + dataRoot;
        } else {
          dom.overviewDiagnostics.textContent = '就绪探测失败（' + (ready.code || ready.status || '未知') + '）';
        }
      }
    }

    function renderAll() {
      renderSession();
      renderMenu();
      renderModules();
      renderAccounts();
      renderRegistration();
      renderDiagnostics();
      renderOverview();
    }

    // ---------------------------------------------------------- 事件绑定

    dom.loginForm.addEventListener('submit', (event) => {
      event.preventDefault();
      login();
    });

    if (dom.logout) dom.logout.addEventListener('click', logout);
    if (dom.deniedLogout) dom.deniedLogout.addEventListener('click', logout);
    if (dom.deniedRecheck) dom.deniedRecheck.addEventListener('click', () => start());

    for (const button of document.querySelectorAll('[data-panel-target]')) {
      button.addEventListener('click', () => showPanel(button.getAttribute('data-panel-target')));
    }

    const refreshButtons = [
      dom.overviewRefresh,
      dom.modulesRefresh,
      dom.usersRefresh,
      dom.diagRefresh
    ].filter(Boolean);
    for (const button of refreshButtons) {
      button.addEventListener('click', () => {
        for (const other of refreshButtons) other.disabled = true;
        refreshAll().finally(() => {
          for (const other of refreshButtons) other.disabled = false;
        });
      });
    }

    if (dom.regProbe) {
      dom.regProbe.addEventListener('click', async () => {
        dom.regProbe.disabled = true;
        try {
          await refreshProbe();
          renderRegistration();
          renderOverview();
          setGlobalMessage('success', '已重新探测注册配置。');
        } catch (err) {
          handleError(err, '注册配置探测失败');
        } finally {
          dom.regProbe.disabled = false;
        }
      });
    }

    // ---------------------------------------------------------- 启动

    showView('login');
    renderSession();
    probeLoginHealth();
    start();
  }

  // 把 normalizeModuleEntry 放在 init 外，保持纯函数区域简洁。
  function normalizeModuleEntry(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const capabilities = Array.isArray(source.capabilities)
      ? source.capabilities
          .filter((cap) => cap && typeof cap.name === 'string' && cap.name !== '')
          .map((cap) => ({
            name: cap.name,
            access: cap.access === 'write' ? 'write' : 'read',
            externalEffect: cap.externalEffect === true
          }))
      : [];
    return {
      id: String(source.id === undefined || source.id === null ? '' : source.id).trim(),
      installed: source.installed === true,
      enabled: source.enabled === true,
      configured: source.configured === true,
      ready: source.ready === true,
      startError:
        typeof source.startError === 'string' && source.startError.trim() !== ''
          ? source.startError
          : null,
      state: typeof source.state === 'string' ? source.state : '',
      upgrading: source.upgrading === true,
      capabilities
    };
  }
}());