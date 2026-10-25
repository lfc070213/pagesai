'use strict';
// 模块共享的轻量 JSON 存储：原子替换写、可注入路径、可纯内存运行。
// 定位：让每个业务模块在「不装 MongoDB」时也能独立运行与测试（方案 §4.1 首版沿用 MongoDB，
//      但 M3「单装可运行」允许先用文件实现；后续 MongoDB 适配器实现同一方法集即可替换）。
//
// 不是数据库：不做并发控制与事务。写入方必须已经通过 operationId 去重（见文件变更契约）。

const fs = require('node:fs');
const path = require('node:path');

class JsonStore {
  /**
   * @param {object} options
   * @param {string|null} [options.filePath] null = 纯内存（测试/试用）
   * @param {object} [options.initial] 初始数据（文件不存在时使用）
   */
  constructor({ filePath = null, initial = null } = {}) {
    this.filePath = filePath ? path.resolve(filePath) : null;
    this.data = initial && typeof initial === 'object' ? JSON.parse(JSON.stringify(initial)) : {};
    if (this.filePath) this.load();
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return { restored: false };
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`JSON 存储格式非法: ${this.filePath}`);
    }
    this.data = raw;
    return { restored: true };
  }

  save() {
    if (!this.filePath) return { persisted: false };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    return { persisted: true };
  }

  get(collection) {
    if (!(collection in this.data)) this.data[collection] = {};
    return this.data[collection];
  }

  /** 追加一条记录并按 id 去重（同一 id 重复写入返回既有记录）。 */
  put(collection, id, value) {
    const bucket = this.get(collection);
    if (id in bucket) return bucket[id];
    bucket[id] = value;
    this.save();
    return value;
  }

  update(collection, id, patch) {
    const bucket = this.get(collection);
    if (!(id in bucket)) return null;
    bucket[id] = { ...bucket[id], ...patch };
    this.save();
    return bucket[id];
  }

  remove(collection, id) {
    const bucket = this.get(collection);
    if (!(id in bucket)) return false;
    delete bucket[id];
    this.save();
    return true;
  }

  has(collection, id) {
    return id in this.get(collection);
  }

  list(collection) {
    return Object.values(this.get(collection));
  }

  count(collection) {
    return Object.keys(this.get(collection)).length;
  }
}

module.exports = { JsonStore };