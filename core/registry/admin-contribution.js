'use strict';
// 模块后台贡献规范化（C29）。
//
// 模块在 manifest.activation.adminContribution 中声明一个模块内文件；该文件导出
// describe({ id, config, manifest, health, instance }) -> 后台贡献。
// 本文件只做形状收敛与安全上限：
//   - 只保留可展示的标题、摘要、状态分组与唯一控制台入口；
//   - 不转发配置对象、适配器函数、Health 原始对象或任何密钥；
//   - 控制台入口必须与核心实际提供的同源页面一致，避免渲染占位链接。

const { CoreError, codes } = require('../errors');

// 核心已提供静态页面的模块；未列出的模块不得声明 consolePath。
const CONSOLE_PATHS = Object.freeze({
  pages: '/pages',
  disk: '/disk',
  glim: '/glim',
  mail: '/mail',
  survey: '/survey',
  paper: '/paper'
});

const MAX_TITLE = 80;
const MAX_SUMMARY = 300;
const MAX_SECTIONS = 7;
const MAX_ITEMS = 12;
const MAX_LABEL = 40;
const MAX_VALUE = 200;

function plainText(value, max) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function normalizeItems(rawItems, sectionTitle) {
  if (!Array.isArray(rawItems)) {
    throw new CoreError(codes.CONFIG_INVALID, `后台贡献 ${sectionTitle} 的 items 必须是数组`, { status: 500 });
  }
  const items = [];
  for (const raw of rawItems.slice(0, MAX_ITEMS)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const label = plainText(raw.label, MAX_LABEL);
    const value = plainText(raw.value, MAX_VALUE);
    if (!label || value === null) continue;
    items.push({ label, value });
  }
  return items;
}

/**
 * 校验并收敛模块返回的后台贡献。
 * 形状非法直接失败，由宿主记录为「后台贡献不可用」，不影响模块业务能力。
 */
function normalizeAdminContribution(raw, { id } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CoreError(codes.CONFIG_INVALID, '后台贡献必须是对象', { status: 500 });
  }
  const title = plainText(raw.title, MAX_TITLE);
  if (!title) throw new CoreError(codes.CONFIG_INVALID, '后台贡献缺少 title', { status: 500 });

  let summary = null;
  if (raw.summary !== undefined && raw.summary !== null) {
    summary = plainText(raw.summary, MAX_SUMMARY);
    if (summary === null) throw new CoreError(codes.CONFIG_INVALID, '后台贡献 summary 必须是字符串', { status: 500 });
  }

  let consolePath = null;
  if (raw.consolePath !== undefined && raw.consolePath !== null) {
    const expected = CONSOLE_PATHS[id];
    if (typeof raw.consolePath !== 'string' || !expected || raw.consolePath !== expected) {
      throw new CoreError(codes.CONFIG_INVALID, `模块 ${id} 声明的控制台入口与核心页面不一致`, { status: 500 });
    }
    consolePath = expected;
  }

  const sectionList = raw.sections === undefined || raw.sections === null ? [] : raw.sections;
  if (!Array.isArray(sectionList)) {
    throw new CoreError(codes.CONFIG_INVALID, '后台贡献 sections 必须是数组', { status: 500 });
  }
  const sections = [];
  for (const section of sectionList.slice(0, MAX_SECTIONS)) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
    const sectionTitle = plainText(section.title, MAX_LABEL);
    if (!sectionTitle) continue;
    const items = normalizeItems(section.items, sectionTitle);
    if (items.length === 0) continue;
    sections.push({ title: sectionTitle, items });
  }

  return { title, summary, consolePath, sections };
}

module.exports = { normalizeAdminContribution, CONSOLE_PATHS };