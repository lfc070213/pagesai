'use strict';
// Survey 后台贡献（C29）。
//
// 只展示 health() 与配置标量：不读取问卷、答卷、统计或附件内容。
// 目录与限额缺省值与本模块 normalizeConfig 保持一致。

const CONSOLE_PATH = '/survey';

const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
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
  const dataFileConfigured = typeof cfg.dataFile === 'string' && cfg.dataFile.trim() !== '';
  const maxAttachmentBytes = Number.isSafeInteger(cfg.maxAttachmentBytes)
    ? cfg.maxAttachmentBytes
    : DEFAULT_MAX_ATTACHMENT_BYTES;

  return {
    title: 'Survey 问卷',
    summary: '问卷创建、发布、答卷与统计；不依赖外部数据库或适配器。',
    consolePath: CONSOLE_PATH,
    sections: [
      {
        title: '运行状态',
        items: [
          { label: '服务', value: facts.ok === true ? '运行中' : '未就绪' },
          {
            label: '存储',
            value: dataFileConfigured ? '文件（JsonStore）' : '内存（重启即清空）'
          },
          {
            label: '附件目录',
            value: dataFileConfigured ? '数据文件同级的 attachments/' : '不落盘（仅内存）'
          }
        ]
      },
      {
        title: '限额',
        items: [{ label: '单个附件上限', value: formatBytes(maxAttachmentBytes) }]
      }
    ]
  };
}

module.exports = { describe };