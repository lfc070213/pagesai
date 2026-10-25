'use strict';
// 存储区域与变更日志的文件持久化适配器（C02 补充）。
// 依据：方案 §6.1「初始化与升级必须拒绝未经确认的隐式数据根变更」、§6.3「索引可通过受限对账恢复」、
//       §10.2 M1b「纯核心能登记和持久保存区域」。
//
// 说明：这是最小持久化实现（单进程、原子替换写），用于满足 M1b 的「持久保存」；
//       MongoDB 适配器后续实现同一接口，届时本文件可作为冷启动导出/导入工具。

const fs = require('node:fs');
const path = require('node:path');
const { StorageRegistry } = require('./registry');
const { CoreError, codes } = require('../errors');

const FORMAT_VERSION = 1;

class PersistentStorageRegistry extends StorageRegistry {
  constructor({ filePath, dataRoot, configValues = {}, clock } = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new CoreError(codes.INVALID_INPUT, 'PersistentStorageRegistry 需要 filePath', { status: 500 });
    }
    super({ dataRoot, configValues, clock });
    this.filePath = path.resolve(filePath);
    this.load();
  }

  /** 从磁盘恢复；文件不存在视为全新部署。 */
  load() {
    if (!fs.existsSync(this.filePath)) return { restored: false };
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (err) {
      throw new CoreError(codes.CONFIG_INVALID, `持久化文件不可读: ${err.message}`, { status: 500, details: { filePath: this.filePath } });
    }
    if (raw.formatVersion !== FORMAT_VERSION) {
      throw new CoreError(codes.CONFIG_INVALID, `持久化格式版本不支持: ${raw.formatVersion}`, { status: 500 });
    }
    this.regions = new Map(raw.regions.map((entry) => [entry.declaration.regionId, entry]));
    this.revisions = new Map(raw.revisions);
    this.changeLog = raw.changeLog.slice();
    this.changes = new Map(raw.changes);
    this.cursorSeq = raw.cursorSeq;
    return { restored: true, regions: this.regions.size, changes: this.changeLog.length };
  }

  /** 原子落盘：先写临时文件再 rename，避免半截 JSON 被当成有效状态。 */
  persist() {
    const payload = {
      formatVersion: FORMAT_VERSION,
      savedAt: new Date(this.clock()).toISOString(),
      dataRoot: this.dataRoot,
      regions: [...this.regions.entries()].map(([regionId, entry]) => ({ declaration: entry.declaration, rootAbs: entry.rootAbs })),
      revisions: [...this.revisions.entries()],
      changeLog: this.changeLog,
      changes: [...this.changes.entries()],
      cursorSeq: this.cursorSeq
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    return { filePath: this.filePath, regions: this.regions.size, changes: this.changeLog.length };
  }

  registerRegion(declaration, options) {
    const result = super.registerRegion(declaration, options);
    this.persist();
    return result;
  }

  applyConfig(nextValues, options) {
    const result = super.applyConfig(nextValues, options);
    this.persist();
    return result;
  }

  recordChange(input) {
    const record = super.recordChange(input);
    if (record.idempotent !== true) this.persist();
    return record;
  }
}

module.exports = { PersistentStorageRegistry, FORMAT_VERSION };