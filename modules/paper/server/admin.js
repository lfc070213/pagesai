'use strict';
// Paper 后台贡献（C29）。
//
// 只展示 health() 与配置标量：不读取论文正文、提取结果、翻译或问答记录，
// 也不转发适配器密钥。适配器只报告配置项是否声明 endpoint；进程内注入的适配器
// 无法从配置判断，因此不把“未声明”描述成“不可用”。

const CONSOLE_PATH = '/paper';

const DEFAULTS = Object.freeze({
  maxUploadBytes: 32 * 1024 * 1024,
  defaultTargetLang: 'zh',
  qaTopK: 6,
  translateBatchSize: 20
});

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function intInRange(value, fallback, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
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

function adapterState(value) {
  const adapter = asObject(value);
  return typeof adapter.endpoint === 'string' && adapter.endpoint.trim()
    ? '已声明 endpoint'
    : '配置项未声明（可由部署代码注入）';
}

function describe({ config, health } = {}) {
  const cfg = asObject(config);
  const facts = asObject(health);

  const statusItems = [
    { label: '服务', value: facts.ok === true ? '运行中' : '未就绪' },
    { label: '存储', value: facts.storage === 'json-file' ? '文件（JsonStore）' : '内存（重启即清空）' },
    { label: '原件', value: facts.uploads === 'disk' ? '落盘保存' : '不落盘（仅内存）' }
  ];
  if (Number.isSafeInteger(facts.docs)) statusItems.push({ label: '文档数', value: facts.docs });

  const adapterItems = [
    { label: '翻译适配器', value: adapterState(cfg.translateAdapter) },
    { label: '问答适配器', value: adapterState(cfg.qaAdapter) },
    {
      label: '检索适配器',
      value: typeof asObject(cfg.searchAdapter).endpoint === 'string' && asObject(cfg.searchAdapter).endpoint.trim()
        ? '已声明 endpoint'
        : '未声明（问答降级为本地关键词检索）'
    }
  ];

  const targetLang = typeof cfg.defaultTargetLang === 'string' && /^[A-Za-z-]{2,32}$/.test(cfg.defaultTargetLang)
    ? cfg.defaultTargetLang
    : DEFAULTS.defaultTargetLang;

  return {
    title: 'Paper 论文精读',
    summary: '论文上传、阅读、逐句翻译与问答；适配器未配置时明确降级，不伪造结果。',
    consolePath: CONSOLE_PATH,
    sections: [
      { title: '运行状态', items: statusItems },
      { title: '模型适配器', items: adapterItems },
      {
        title: '阅读限额',
        items: [
          { label: '上传文件上限', value: formatBytes(intInRange(cfg.maxUploadBytes, DEFAULTS.maxUploadBytes, 1024, 128 * 1024 * 1024)) },
          { label: '默认目标语言', value: targetLang },
          { label: '问答引用上限', value: intInRange(cfg.qaTopK, DEFAULTS.qaTopK, 1, 20) },
          { label: '翻译批量', value: intInRange(cfg.translateBatchSize, DEFAULTS.translateBatchSize, 1, 50) }
        ]
      }
    ]
  };
}

module.exports = { describe };