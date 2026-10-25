'use strict';
// Glim 后台贡献（C29）。
//
// 只展示 health() 与部署配置标量：不读取会话、消息、记忆、工作区文件或 audit，
// 也不转发 chatAdapter（含密钥）与 systemPrompt 正文。
// 限额缺省值与 normalizeConfig / DEFAULTS 保持一致。

const CONSOLE_PATH = '/glim';

const DEFAULTS = Object.freeze({
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
});

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) return fallback;
  return number;
}

function formatBytes(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
  for (const [unit, size] of [['GiB', 1024 ** 3], ['MiB', 1024 ** 2], ['KiB', 1024]]) {
    if (bytes >= size) {
      const value = Math.round((bytes / size) * 100) / 100;
      return `${value} ${unit}（${bytes} 字节）`;
    }
  }
  return `${bytes} 字节`;
}

function describe({ config, health } = {}) {
  const cfg = asObject(config);
  const facts = asObject(health);

  const statusItems = [
    { label: '服务', value: facts.ok === true ? '运行中' : '未就绪' },
    {
      label: '存储',
      value: facts.storage === 'file' ? '文件（JsonStore）' : facts.storage === 'memory' ? '内存（重启即清空）' : '未报告'
    },
    {
      label: '模型',
      value: facts.model === 'configured' ? '已配置' : '未配置（对话返回 409）'
    },
    { label: '工作区', value: facts.workspace === true ? '已配置' : '未启用（工具不可用）' },
    { label: '模块发现', value: facts.discovery === true ? '已配置' : '未启用' },
    {
      label: '可连接模块',
      value: Array.isArray(facts.connectors) && facts.connectors.length > 0
        ? facts.connectors.join('、')
        : '无'
    }
  ];
  const active = Number.isSafeInteger(facts.tasks && facts.tasks.active) ? facts.tasks.active : null;
  if (active !== null) statusItems.push({ label: '运行中任务', value: `${active} 个` });

  const policyItems = [
    { label: 'connector 登记', value: cfg.allowConnectorRegistration === false ? '关闭' : '允许' },
    { label: '登记需管理员', value: cfg.requireAdminForConnectorRegistration === true ? '是' : '否' },
    {
      label: '受信来源',
      value: Array.isArray(cfg.trustedConnectorOrigins) && cfg.trustedConnectorOrigins.length > 0
        ? `${cfg.trustedConnectorOrigins.length} 个白名单`
        : '未限制（由登记动作作为信任）'
    },
    { label: '每用户 connector 上限', value: clampInt(cfg.maxConnectorsPerUser, DEFAULTS.maxConnectorsPerUser, 1, 500) },
    { label: '同时运行任务上限', value: clampInt(cfg.maxRunningTasksPerUser, DEFAULTS.maxRunningTasksPerUser, 1, 4) },
    { label: '单次工具轮次', value: clampInt(cfg.maxToolRounds, DEFAULTS.maxToolRounds, 1, 8) },
    { label: '每用户审计保留', value: clampInt(cfg.auditLimit, DEFAULTS.auditLimit, 10, 10000) }
  ];

  const limitItems = [
    { label: '长期记忆上限', value: `${clampInt(cfg.memoryMaxChars, DEFAULTS.memoryMaxChars, 1, 100000)} 字符` },
    { label: '单条消息上限', value: `${clampInt(cfg.messageMaxChars, DEFAULTS.messageMaxChars, 1, 50000)} 字符` },
    { label: '历史消息条数', value: clampInt(cfg.historyLimit, DEFAULTS.historyLimit, 1, 500) },
    { label: '工作区单文件上限', value: formatBytes(clampInt(cfg.maxWorkspaceFileBytes, DEFAULTS.maxWorkspaceFileBytes, 1024, 32 * 1024 * 1024)) },
    { label: '每用户工作区文件数', value: clampInt(cfg.maxWorkspaceFiles, DEFAULTS.maxWorkspaceFiles, 1, 5000) },
    { label: '每用户工作区总容量', value: formatBytes(clampInt(cfg.maxWorkspaceTotalBytes, DEFAULTS.maxWorkspaceTotalBytes, 1024, 1024 * 1024 * 1024)) }
  ];

  return {
    title: 'Glim 智能体',
    summary: facts.model === 'configured'
      ? '可独立使用的智能体；模型已配置。'
      : '可独立使用的智能体；模型未配置时对话不可用。',
    consolePath: CONSOLE_PATH,
    sections: [
      { title: '运行状态', items: statusItems },
      { title: '连接与任务策略', items: policyItems },
      { title: '会话与工作区限额', items: limitItems }
    ]
  };
}

module.exports = { describe };