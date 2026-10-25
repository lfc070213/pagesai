'use strict';
// 模块清单契约实现（B07）。
// 依据：contracts/module-manifest.schema.json、方案 §4.2、§4.3、§4.3 状态语义。
//
// 关键约束：
//  - 模块登记只能由构建与管理员配置产生，不从不可信请求动态安装；
//  - 未安装的模块不得被 import，不得注册路由/后台任务/模块专属配置校验；
//  - 「未实现能力」不得登记为可用。

const fs = require('node:fs');
const path = require('node:path');
const { validate } = require('../contracts/validate');
const { CoreError, codes } = require('../errors');

const MANIFEST_SCHEMA_PATH = path.join(__dirname, '..', '..', 'contracts', 'module-manifest.schema.json');
const MODULE_IDS = Object.freeze(['pages', 'disk', 'glim', 'mail', 'survey', 'paper']);

let cachedSchema = null;
function manifestSchema() {
  if (!cachedSchema) cachedSchema = JSON.parse(fs.readFileSync(MANIFEST_SCHEMA_PATH, 'utf8'));
  return cachedSchema;
}

/** 路径必须是模块内相对路径：不允许绝对路径、不允许 `..` 越界。 */
function assertSafeRelativePath(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CoreError(codes.INVALID_INPUT, `${field} 必须是非空字符串`, { status: 500 });
  }
  if (path.isAbsolute(value) || value.includes('\\')) {
    throw new CoreError(codes.PATH_ESCAPE, `${field} 不得是绝对路径或反斜杠路径`, { status: 500 });
  }
  const segments = value.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new CoreError(codes.PATH_ESCAPE, `${field} 含非法路径段`, { status: 500 });
  }
  return value;
}

/** 校验模块清单；失败抛 CONFIG_INVALID 并附全部错误。 */
function validateManifest(manifest) {
  const result = validate(manifestSchema(), manifest);
  if (!result.valid) {
    throw new CoreError(codes.CONFIG_INVALID, '模块清单不符合契约', { status: 500, details: { errors: result.errors } });
  }
  const activation = manifest.activation;
  assertSafeRelativePath(activation.serverEntry, 'activation.serverEntry');
  if (activation.webEntry) assertSafeRelativePath(activation.webEntry, 'activation.webEntry');
  if (activation.adminContribution) assertSafeRelativePath(activation.adminContribution, 'activation.adminContribution');
  if (manifest.config && manifest.config.schema) assertSafeRelativePath(manifest.config.schema, 'config.schema');
  for (const m of (manifest.data.migrations || [])) {
    assertSafeRelativePath(m.up, 'data.migrations.up');
    if (m.down) assertSafeRelativePath(m.down, 'data.migrations.down');
  }
  // 未实现能力不得声明为可用（防止「模拟数据适配器」通过验收）
  const tools = (manifest.capabilities && manifest.capabilities.tools) || [];
  for (const tool of tools) {
    if (tool.implemented === true && tool.externalEffect === true && !tool.access) {
      throw new CoreError(codes.CONFIG_INVALID, `能力 ${tool.name} 声明了外部后果但缺少访问权限`, { status: 500 });
    }
  }
  return manifest;
}

module.exports = { validateManifest, assertSafeRelativePath, MODULE_IDS, MANIFEST_SCHEMA_PATH };
