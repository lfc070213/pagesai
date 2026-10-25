'use strict';
// 五个真实连接器的本地注册表。
// 连接器只在 connector 显式声明 moduleId 时才启用，避免把同名但来源不同的能力误接到本机实现。

const pages = require('./pages.js');
const disk = require('./disk.js');
const mail = require('./mail.js');
const survey = require('./survey.js');
const paper = require('./paper.js');

const ADAPTERS = new Map([
  [pages.MODULE_ID, pages],
  [disk.MODULE_ID, disk],
  [mail.MODULE_ID, mail],
  [survey.MODULE_ID, survey],
  [paper.MODULE_ID, paper]
]);

function adapterFor(moduleId) {
  if (typeof moduleId !== 'string') return null;
  return ADAPTERS.get(moduleId) || null;
}

function handlerFor(moduleId, name) {
  const adapter = adapterFor(moduleId);
  if (!adapter || typeof adapter.handlers[name] !== 'function') return null;
  return adapter.handlers[name];
}

function capabilitiesFor(moduleId) {
  const adapter = adapterFor(moduleId);
  return adapter ? adapter.capabilities.map((item) => ({ ...item, implemented: true })) : [];
}

function supports(moduleId) {
  return ADAPTERS.has(moduleId);
}

module.exports = { adapterFor, handlerFor, capabilitiesFor, supports, MODULE_IDS: [...ADAPTERS.keys()] };
