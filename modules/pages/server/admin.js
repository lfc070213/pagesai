'use strict';
// Pages 后台贡献（C29）。
//
// describe() 只把 health() 已计算的事实与部署配置标量整理成状态卡：
//   - 不读取 aiAdapter、模型密钥、站点内容或任何用户数据；
//   - 不访问 JsonStore / MongoDB，不产生副作用；
//   - consolePath 必须与核心静态页面一致（/pages）。
// 限额缺省值与本模块 DEFAULT_* 保持一致，保证展示的是实际生效口径。

const CONSOLE_PATH = '/pages';

const STORAGE_LABELS = Object.freeze({
  'mongodb+content-store': 'MongoDB + 内容存储',
  file: '文件（JsonStore）',
  memory: '内存（重启即清空）'
});

const DEFAULTS = Object.freeze({
  publicBasePath: '/api/pages/public',
  maxFileBytes: 1024 * 1024,
  maxFilesPerSite: 200,
  maxSitesPerUser: 20,
  maxVersions: 50
});

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function intOr(value, fallback) {
  return Number.isSafeInteger(value) ? value : fallback;
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
      value: STORAGE_LABELS[facts.storage]
        || (typeof facts.storage === 'string' && facts.storage ? facts.storage : '未报告')
    },
    { label: 'AI 修改', value: facts.aiConfigured === true ? '适配器已注入' : '未配置（写入返回 409）' }
  ];
  if (Number.isSafeInteger(facts.sites)) {
    statusItems.push({ label: '站点数', value: facts.sites });
  }

  const publicBasePath = typeof cfg.publicBasePath === 'string' && cfg.publicBasePath.trim()
    ? cfg.publicBasePath.trim()
    : DEFAULTS.publicBasePath;

  const limitItems = [
    { label: '单用户站点上限', value: intOr(cfg.maxSitesPerUser, DEFAULTS.maxSitesPerUser) },
    { label: '单站点文件上限', value: intOr(cfg.maxFilesPerSite, DEFAULTS.maxFilesPerSite) },
    { label: '单文件上限', value: formatBytes(intOr(cfg.maxFileBytes, DEFAULTS.maxFileBytes)) },
    { label: '每站点保留版本数', value: intOr(cfg.maxVersions, DEFAULTS.maxVersions) },
    { label: '公开访问前缀', value: publicBasePath }
  ];

  return {
    title: 'Pages 站点托管',
    summary: Number.isSafeInteger(facts.sites)
      ? `AI 建站与静态发布；当前 ${facts.sites} 个站点。`
      : 'AI 建站、文件管理与静态发布。',
    consolePath: CONSOLE_PATH,
    sections: [
      { title: '运行状态', items: statusItems },
      { title: '配额与公开访问', items: limitItems }
    ]
  };
}

module.exports = { describe };