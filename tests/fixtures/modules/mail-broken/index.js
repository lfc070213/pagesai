'use strict';
// 测试夹具：缺少 stop()，用于验证入口形状校验。
module.exports = {
  async start() {},
  async health() { return { ok: true }; }
};
