'use strict';
// 测试夹具：完整的生命周期入口。
globalThis.__fixtureLoads = (globalThis.__fixtureLoads || 0) + 1;
let started = false;
module.exports = {
  async start() { started = true; },
  async stop() { started = false; },
  async health() { return { ok: started, reason: started ? null : 'not-started' }; }
};
