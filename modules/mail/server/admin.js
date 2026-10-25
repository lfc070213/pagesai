'use strict';
// Mail 后台贡献（C29）。
//
// 只展示 health() 与配置标量：不读取 transport / imap 对象、凭据解析器、
// 邮箱密码、消息内容或收件箱数据。provider 仅显示协议名，不显示主机、账号。
// 验证码与附件缺省值与本模块 VERIFICATION_DEFAULTS / MAX_TOTAL_ATTACHMENT_BYTES 一致。

const CONSOLE_PATH = '/mail';

const VERIFICATION_DEFAULTS = Object.freeze({
  windowMs: 10 * 60 * 1000,
  maxPerWindow: 5,
  ttlMs: 10 * 60 * 1000,
  maxAttempts: 5,
  public: false
});

const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
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

function formatDuration(ms) {
  if (!Number.isSafeInteger(ms) || ms <= 0) return null;
  if (ms % 3600000 === 0) return `${ms / 3600000} 小时（${ms} 毫秒）`;
  if (ms % 60000 === 0) return `${ms / 60000} 分钟（${ms} 毫秒）`;
  return `${ms} 毫秒`;
}

function providerLabel(provider) {
  if (provider === 'smtp' || provider === 'imap') return provider.toUpperCase();
  if (provider === 'custom') return '自定义适配器';
  return '已配置';
}

function describe({ config, health } = {}) {
  const cfg = asObject(config);
  const facts = asObject(health);

  const statusItems = [
    { label: '服务', value: facts.ok === true ? '运行中' : '未就绪' },
    {
      label: '发信',
      value: facts.transportConfigured === true
        ? `已配置（${providerLabel(facts.transportProvider)}）`
        : '未配置（发信返回 409）'
    },
    {
      label: '收件',
      value: facts.imapConfigured === true
        ? `已配置（${providerLabel(facts.imapProvider)}）`
        : '未配置（收件返回 409）'
    },
    { label: '系统发件身份', value: facts.fromConfigured === true ? '已配置' : '未配置' },
    { label: '用户发信', value: facts.userSendEnabled === true ? '允许' : '关闭（验证码发信不受影响）' },
    {
      label: '存储',
      value: facts.storage === 'file' ? '文件（JsonStore）' : facts.storage === 'memory' ? '内存（重启即清空）' : '未报告'
    }
  ];

  const verification = asObject(cfg.verification);
  const windowMs = clampInt(verification.windowMs, VERIFICATION_DEFAULTS.windowMs, 1000, 86400000);
  const maxPerWindow = clampInt(verification.maxPerWindow, VERIFICATION_DEFAULTS.maxPerWindow, 1, 100);
  const ttlMs = clampInt(verification.ttlMs, VERIFICATION_DEFAULTS.ttlMs, 1000, 3600000);
  const maxAttempts = clampInt(verification.maxAttempts, VERIFICATION_DEFAULTS.maxAttempts, 1, 20);

  const verificationItems = [
    { label: '验证码有效期', value: formatDuration(ttlMs) },
    { label: '频率窗口', value: formatDuration(windowMs) },
    { label: '窗口内最多发送', value: `${maxPerWindow} 次` },
    { label: '最多尝试次数', value: `${maxAttempts} 次` },
    { label: '未登录可请求', value: verification.public === true ? '允许' : '关闭' }
  ];

  const attachments = asObject(cfg.attachments);
  const attachmentItems = [
    {
      label: '附件大小上限',
      value: formatBytes(clampInt(attachments.maxBytes, MAX_TOTAL_ATTACHMENT_BYTES, 1024, 50 * 1024 * 1024))
    }
  ];

  return {
    title: 'Mail 邮件',
    summary: facts.transportConfigured === true
      ? '系统发信、验证码与可选收件；发信通道已配置。'
      : '系统发信未配置：验证码与通知邮件不可用。',
    consolePath: CONSOLE_PATH,
    sections: [
      { title: '运行状态', items: statusItems },
      { title: '验证码策略', items: verificationItems },
      { title: '附件', items: attachmentItems }
    ]
  };
}

module.exports = { describe };