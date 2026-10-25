'use strict';
// Disk 后台贡献（C29）。
//
// 只展示 health() 与部署配置标量；不扫描文件、不读取配额用量、不暴露存储路径或凭据。
// 限额缺省值与本模块 DEFAULT_* 保持一致。

const CONSOLE_PATH = '/disk';

const DEFAULT_QUOTA_BYTES = 1024 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 5 * 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const DEFAULT_SHARE_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_SHARE_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

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

function formatDuration(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  if (seconds % 86400 === 0) return `${seconds / 86400} 天（${seconds} 秒）`;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时（${seconds} 秒）`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟（${seconds} 秒）`;
  return `${seconds} 秒`;
}

function describe({ config, health } = {}) {
  const cfg = asObject(config);
  const facts = asObject(health);

  const adapter = typeof cfg.storageAdapter === 'string' ? cfg.storageAdapter : 'json';
  const regions = Array.isArray(cfg.regions) && cfg.regions.length > 0
    ? cfg.regions.filter((region) => typeof region === 'string')
    : ['disk.user-files'];

  const statusItems = [
    { label: '服务', value: facts.ok === true ? '运行中' : '未就绪' },
    {
      label: '存储适配器',
      value: adapter === 'json' ? 'json（内置）' : `${adapter}（未实现；数据请求返回 409）`
    },
    {
      label: '数据文件',
      value: typeof cfg.dataFile === 'string' && cfg.dataFile.trim() ? '已配置' : '内存（仅测试，重启即清空）'
    },
    { label: '暴露区域', value: regions.length > 0 ? regions.join('、') : 'disk.user-files' }
  ];

  const quotaItems = [
    { label: '每用户逻辑配额', value: formatBytes(intOr(cfg.quotaBytes, DEFAULT_QUOTA_BYTES)) },
    {
      label: '单文件上限',
      value: intOr(cfg.maxFileBytes, 0) > 0 ? formatBytes(cfg.maxFileBytes) : '沿用每用户配额'
    },
    { label: '建议分块大小', value: formatBytes(intOr(cfg.chunkSizeBytes, DEFAULT_CHUNK_BYTES)) },
    { label: '最大分块大小', value: formatBytes(intOr(cfg.maxChunkBytes, MAX_CHUNK_BYTES)) }
  ];

  const share = asObject(cfg.share);
  const shareItems = [
    {
      label: '分享默认有效期',
      value: formatDuration(intOr(share.defaultTtlSeconds, DEFAULT_SHARE_TTL_SECONDS))
    },
    {
      label: '分享最长有效期',
      value: formatDuration(intOr(share.maxTtlSeconds, DEFAULT_SHARE_MAX_TTL_SECONDS))
    }
  ];

  return {
    title: 'Disk 单逻辑盘',
    summary: `单盘 ${regions[0] || 'disk.user-files'}；每用户配额 ${formatBytes(intOr(cfg.quotaBytes, DEFAULT_QUOTA_BYTES))}。`,
    consolePath: CONSOLE_PATH,
    sections: [
      { title: '运行状态', items: statusItems },
      { title: '配额与分块', items: quotaItems },
      { title: '只读分享', items: shareItems }
    ]
  };
}

module.exports = { describe };