'use strict';
// 存储区域登记与文件变更契约实现（C01 / P2）。
// 依据：contracts/storage-region.schema.json、contracts/file-change.schema.json；
//       方案 §6.1（数据根与文件区域）、§6.2（Disk 是授权视图）、§6.3（写入一致性）、§6.4（装卸验收）。
//
// 硬性规则：
//  - 安装/卸载 Disk 不改变任何区域的数据位置；
//  - 初始化与升级拒绝未经确认的隐式数据根变更；
//  - 物理根只供服务端使用，浏览器与 Glim 不接受任意宿主路径；
//  - 所有写入都要有 operationId（幂等）与修订号（条件写入）。

const fs = require('node:fs');
const path = require('node:path');
const { validate } = require('../contracts/validate');
const { CoreError, codes } = require('../errors');

const REGION_SCHEMA_PATH = path.join(__dirname, '..', '..', 'contracts', 'storage-region.schema.json');
let cachedRegionSchema = null;
function regionSchema() {
  if (!cachedRegionSchema) cachedRegionSchema = JSON.parse(fs.readFileSync(REGION_SCHEMA_PATH, 'utf8'));
  return cachedRegionSchema;
}

function validateRegion(declaration) {
  const result = validate(regionSchema(), declaration);
  if (!result.valid) {
    throw new CoreError(codes.CONFIG_INVALID, '存储区域声明不符合契约', { status: 500, details: { errors: result.errors } });
  }
  return declaration;
}

function assertSafeRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new CoreError(codes.PATH_ESCAPE, '相对路径不能为空', { status: 400 });
  }
  if (path.isAbsolute(relPath) || relPath.includes('\\') || relPath.includes('\0')) {
    throw new CoreError(codes.PATH_ESCAPE, '不允许绝对路径、反斜杠或空字节', { status: 400 });
  }
  const segments = relPath.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new CoreError(codes.PATH_ESCAPE, '路径含非法路径段', { status: 400 });
  }
  return relPath;
}

class StorageRegistry {
  /**
   * @param {object} options
   * @param {string} options.dataRoot 统一父目录（新部署默认）
   * @param {Record<string,string>} [options.configValues] configKey -> 物理根
   * @param {() => number} [options.clock]
   */
  constructor({ dataRoot, configValues = {}, clock = () => Date.now() } = {}) {
    if (typeof dataRoot !== 'string' || dataRoot.length === 0) {
      throw new CoreError(codes.INVALID_INPUT, 'StorageRegistry 需要 dataRoot', { status: 500 });
    }
    this.dataRoot = path.resolve(dataRoot);
    this.configValues = { ...configValues };
    this.clock = clock;
    this.regions = new Map(); // regionId -> {declaration, rootAbs}
    this.changes = new Map(); // operationId -> record
    this.changeLog = []; // 有序变更记录
    this.revisions = new Map(); // `${regionId}\0${fileId}` -> revision
    this.cursorSeq = 0;
  }

  /** 立即可用的区域根：配置优先，否则使用统一父目录下的 defaultSubpath。 */
  rootFor(declaration) {
    const key = declaration.physicalRoot.configKey;
    const configured = this.configValues[key];
    if (configured !== undefined && configured !== null && configured !== '') return path.resolve(String(configured));
    if (declaration.physicalRoot.defaultSubpath) return path.resolve(this.dataRoot, declaration.physicalRoot.defaultSubpath);
    throw new CoreError(codes.CONFIG_INVALID, `区域 ${declaration.regionId} 缺少物理根配置 ${key}`, { status: 409 });
  }

  registerRegion(declaration, { confirmDataRootChange = false } = {}) {
    validateRegion(declaration);
    const existing = this.regions.get(declaration.regionId);
    const rootAbs = this.rootFor(declaration);
    if (existing) {
      if (existing.rootAbs !== rootAbs && !confirmDataRootChange) {
        throw new CoreError(codes.IMPLICIT_DATA_ROOT_CHANGE, `区域 ${declaration.regionId} 的物理根发生变化，需要显式确认`, { status: 409, details: { from: existing.rootAbs, to: rootAbs } });
      }
      this.regions.set(declaration.regionId, { declaration, rootAbs });
      return { ...this.describe(declaration.regionId) };
    }
    this.regions.set(declaration.regionId, { declaration, rootAbs });
    return { ...this.describe(declaration.regionId) };
  }

  /** 升级/重配：批量应用配置值。任何已登记区域根变化都要求显式确认。 */
  applyConfig(nextValues, { confirmDataRootChange = false } = {}) {
    const next = { ...this.configValues, ...nextValues };
    const changed = [];
    for (const [key, value] of Object.entries(nextValues)) if (this.configValues[key] !== value) changed.push(key);
    const previous = this.configValues;
    this.configValues = next;
    const drifted = [];
    for (const [regionId, entry] of this.regions) {
      const rootAbs = this.rootFor(entry.declaration);
      if (rootAbs !== entry.rootAbs) drifted.push({ regionId, from: entry.rootAbs, to: rootAbs });
    }
    if (drifted.length > 0 && !confirmDataRootChange) {
      this.configValues = previous; // 回滚内存值，保持已验证状态
      throw new CoreError(codes.IMPLICIT_DATA_ROOT_CHANGE, '配置变更会移动已有数据根，需要显式确认', { status: 409, details: { drifted } });
    }
    for (const item of drifted) this.regions.get(item.regionId).rootAbs = item.to;
    return { changedKeys: changed, drifted };
  }

  describe(regionId) {
    const entry = this.regions.get(regionId);
    if (!entry) throw new CoreError(codes.REGION_UNKNOWN, `区域 ${regionId} 未登记`, { status: 404 });
    const d = entry.declaration;
    return {
      regionId,
      module: d.module,
      physicalRoot: entry.rootAbs,
      ownership: d.ownership,
      allowedOperations: d.allowedOperations.slice(),
      disk: d.disk,
      quota: d.quota || null
    };
  }

  list() {
    return [...this.regions.keys()].sort().map((id) => this.describe(id));
  }

  region(regionId) {
    const entry = this.regions.get(regionId);
    if (!entry) throw new CoreError(codes.REGION_UNKNOWN, `区域 ${regionId} 未登记`, { status: 404 });
    return entry;
  }

  /** 权限检查：区域模块归属、允许操作、所有权规则。Disk 视图另有 readOnly/visible 约束。 */
  authorize({ regionId, moduleId, operation, userId = null, viaDisk = false } = {}) {
    const entry = this.region(regionId);
    const d = entry.declaration;
    if (!d.allowedOperations.includes(operation)) {
      throw new CoreError(codes.REGION_NOT_AUTHORIZED, `区域 ${regionId} 不允许操作 ${operation}`, { status: 403 });
    }
    const ownedByModule = moduleId === d.module;
    const diskView = viaDisk && moduleId === 'disk' && d.disk.visible === true;
    if (!ownedByModule && !diskView) {
      throw new CoreError(codes.REGION_NOT_AUTHORIZED, '调用方无权访问该区域', { status: 403 });
    }
    if (viaDisk && d.disk.readOnly === true && ['write', 'delete', 'rename', 'mkdir'].includes(operation)) {
      throw new CoreError(codes.REGION_NOT_AUTHORIZED, '该区域在 Disk 视图中为只读', { status: 403 });
    }
    if (d.ownership.rule === 'per-user' && !userId) {
      throw new CoreError(codes.REGION_NOT_AUTHORIZED, '按用户所有权区域必须指定用户', { status: 403 });
    }
    return { regionId, module: d.module, rootAbs: entry.rootAbs, ownership: d.ownership, declaration: d };
  }

  /** 解析相对路径为区域内绝对路径；词法上拒绝越界（符号链接由服务层再做 realpath 校验）。 */
  resolvePath({ regionId, userId = null, relPath }) {
    const auth = this.authorize({ regionId, moduleId: this.region(regionId).declaration.module, operation: 'read', userId });
    assertSafeRelPath(relPath);
    const base = auth.ownership.rule === 'per-user' ? path.resolve(auth.rootAbs, String(userId)) : auth.rootAbs;
    const abs = path.resolve(base, relPath);
    if (abs !== base && !abs.startsWith(base + path.sep)) {
      throw new CoreError(codes.PATH_ESCAPE, '路径越出区域根', { status: 400 });
    }
    return abs;
  }

  revisionKey(regionId, fileId) {
    return regionId + '\0' + fileId;
  }

  currentRevision(regionId, fileId) {
    return this.revisions.get(this.revisionKey(regionId, fileId)) || 0;
  }

  /**
   * 记录一次文件变更。
   * - operationId 幂等：重复提交返回首次结果；同 ID 不同内容 → CONFLICT。
   * - baseRevision 条件写入：与当前修订不符 → CONFLICT（不默认最后写入覆盖）。
   */
  recordChange(input) {
    const { operationId, regionId, fileId, op, baseRevision = null, actor, path: relPath = null, tombstone = false } = input || {};
    if (typeof operationId !== 'string' || operationId.length < 8) {
      throw new CoreError(codes.INVALID_INPUT, 'operationId 至少 8 个字符', { status: 400 });
    }
    if (!['create', 'update', 'rename', 'delete', 'restore'].includes(op)) {
      throw new CoreError(codes.INVALID_INPUT, 'op 非法', { status: 400 });
    }
    this.region(regionId);
    if (relPath) assertSafeRelPath(relPath);
    if (tombstone === true && op !== 'delete') {
      throw new CoreError(codes.INVALID_INPUT, '只有明确删除才可以写墓碑', { status: 400 });
    }

    const fingerprint = JSON.stringify({ regionId, fileId, op, baseRevision, actor: actor || null, path: relPath });
    const existing = this.changes.get(operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new CoreError(codes.CONFLICT, '同一 operationId 携带了不同内容', { status: 409, details: { operationId } });
      }
      return { ...existing.record, idempotent: true };
    }

    const current = this.currentRevision(regionId, fileId);
    if (baseRevision !== null && baseRevision !== current) {
      const record = {
        operationId,
        regionId,
        fileId,
        op,
        baseRevision,
        revision: current,
        status: 'conflict',
        conflict: { kind: op === 'delete' ? 'modify-vs-delete' : 'both-modified', resolution: 'keep-both' }
      };
      throw new CoreError(codes.CONFLICT, '基础修订与当前修订不符，已保留冲突', { status: 409, details: record });
    }

    const revision = current + 1;
    this.revisions.set(this.revisionKey(regionId, fileId), revision);
    this.cursorSeq += 1;
    const record = {
      operationId,
      regionId,
      fileId,
      op,
      path: relPath,
      baseRevision,
      revision,
      cursor: String(this.cursorSeq),
      actor: actor || null,
      tombstone: tombstone === true,
      status: 'committed',
      recordedAt: new Date(this.clock()).toISOString()
    };
    this.changes.set(operationId, { fingerprint, record });
    this.changeLog.push(record);
    return { ...record, idempotent: false };
  }

  /**
   * 增量读取变更。游标过期（早于日志起点或不可解析）必须返回 reset，调用方做全量对账；
   * 绝不能把「游标过期」当成「远端目录为空」。
   */
  changesSince({ regionId, cursor = null, limit = 1000 } = {}) {
    this.region(regionId);
    const scoped = this.changeLog.filter((r) => r.regionId === regionId);
    if (cursor === null || cursor === undefined) {
      return { reset: true, records: scoped.slice(0, limit), nextCursor: scoped.length ? scoped[Math.min(limit, scoped.length) - 1].cursor : null };
    }
    const seq = Number(cursor);
    if (!Number.isSafeInteger(seq) || seq < 0 || (scoped.length > 0 && seq < Number(scoped[0].cursor) - 1)) {
      return { reset: true, reason: 'cursor-expired', records: [], nextCursor: scoped.length ? scoped[scoped.length - 1].cursor : null };
    }
    const records = scoped.filter((r) => Number(r.cursor) > seq).slice(0, limit);
    return { reset: false, records, nextCursor: records.length ? records[records.length - 1].cursor : cursor };
  }
}

module.exports = { StorageRegistry, validateRegion, assertSafeRelPath };
