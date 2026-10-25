# 升级指南

升级遵循固定顺序：**检查兼容性 → 备份 → 幂等迁移 → 启动 → 验证**。数据模式不兼容时，代码回退必须配合备份恢复或已验证的逆向迁移，不能只换回旧代码。

> **现状**：核心与六个模块都已实现服务端闭环，`tools/upgrade.js` 提供 `check → backup → migrate → verify` 流程与内置迁移台账；`coreCompatibility` 仍只做格式校验，没有与核心版本比对。MongoDB 引擎下区域、修订与变更事件由数据库持久化；外部数据库转储仍需运维配合。

## 1. 升级前必须确认

| 检查项 | 怎么查 | 现状 |
| --- | --- | --- |
| 模块清单兼容范围 | 契约校验（§2.1） | 仅格式校验，**无版本比对** |
| 数据根是否会被改动 | `StorageRegistry` 拒绝隐式换根（§2.2） | 已实现 |
| 核心持久化格式 | 文件版 `PersistentStorageRegistry` 的 `formatVersion`（§2.3） | 当前 `1`；MongoDB 引擎下区域/修订/事件在 `storage_*` 集合 |
| 模块数据文件 | `JsonStore` JSON，无版本字段 | 备份即升级前快照 |
| 迁移清单 | `data.migrations`（有序、幂等） | 契约已定义；`tools/upgrade.js` 内置迁移与 `stateDir/migrations.json` 台账 |
| 备份 | 见 [`backup-restore`](backup-restore.md) | `tools/backup.js` 已实现；迁移前自动执行 |

## 2. 可立即复跑的检查

### 2.1 兼容范围只做格式校验

```bash
cd source/site/public-release/pagesai
node -e '
const { validateManifest } = require("./core/registry/manifest.js");
const base = { id: "paper", version: "0.2.0", activation: { serverEntry: "index.js" }, data: { namespace: "paper" }, lifecycle: { start: "start", stop: "stop", health: "health" } };
try { validateManifest({ ...base, coreCompatibility: "1.0" }); console.log("意外通过"); }
catch (e) { console.log("拒绝:", e.code, e.details.errors[0].path); }
validateManifest({ ...base, coreCompatibility: "^1.0.0" });
console.log("格式合法的 coreCompatibility 通过");
'
```

预期：

```text
拒绝: CONFIG_INVALID $.coreCompatibility
格式合法的 coreCompatibility 通过
```

这**只说明字段格式**。核心没有对外版本号，也没有「清单声明 ^1.0.0、核心是 2.x 就拒绝安装」的比对逻辑；升级前必须人工核对。

### 2.2 数据根变更会被拒绝

```bash
node -e '
const { StorageRegistry } = require("./core/storage/registry.js");
const reg = new StorageRegistry({ dataRoot: "/tmp/pagesai-upgrade", configValues: { "storage.paper.uploads": "/tmp/pagesai-upgrade/paper-a" } });
reg.registerRegion({ regionId: "paper.uploads", module: "paper", physicalRoot: { configKey: "storage.paper.uploads", defaultSubpath: "paper-uploads", allowImplicitChange: false }, ownership: { rule: "per-user", ownerField: "ownerId" }, allowedOperations: ["read","write","delete"], disk: { visible: false, syncable: false } });
try { reg.applyConfig({ "storage.paper.uploads": "/tmp/pagesai-upgrade/paper-b" }); console.log("意外通过"); }
catch (e) { console.log("拒绝:", e.code); console.log("物理根仍为:", reg.describe("paper.uploads").physicalRoot); }
'
```

预期：

```text
拒绝: IMPLICIT_DATA_ROOT_CHANGE
物理根仍为: /tmp/pagesai-upgrade/paper-a
```

### 2.3 核心持久化格式

若使用 `PersistentStorageRegistry` 产出的状态文件：

```bash
python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["formatVersion"])' /srv/pagesai/state/storage.json
```

- 必须是受支持版本（当前 `1`）。
- 版本不支持或文件损坏 → `PersistentStorageRegistry` **拒绝加载**（`CONFIG_INVALID`），不静默重建。
- 复核：`node --test tests/contracts/persistence.test.js`。

### 2.4 模块数据文件

模块的 `dataFile` 是 `JsonStore` 的 JSON 快照，**没有 `formatVersion` 字段**。升级前：

```bash
cp /srv/pagesai/pages/pages.json /srv/pagesai/backup/pages-$(date +%Y%m%d%H%M%S).json
python3 -c 'import json,sys;json.load(open(sys.argv[1]));print("JSON 可解析")' /srv/pagesai/pages/pages.json
```

损坏或不可解析时，模块应拒绝启动而不是重建空库（Pages/Paper/Glim/Mail/Survey 均有对应用例或实现；以各模块 README 为准）。

## 3. 升级流程（`tools/upgrade.js` 执行）

默认一次跑完 `check → backup → migrate → verify`：

```bash
node tools/upgrade.js --check      # 只做兼容性检查
node tools/upgrade.js --dry-run    # 打印计划，不写盘
node tools/upgrade.js              # check → backup → migrate → verify
node tools/upgrade.js --verify     # 迁移后复核台账、区域目录与可写性
```

1. **冻结写入**：维护状态；暂停同步（不是删除）。工具不会替你停进程。
2. **备份**：迁移前自动调用 `tools/backup.js`；数据库转储需运维另行放入。
3. **检查兼容性**：配置结构版本、部署标记、数据根变化、迁移台账与已知迁移签名。
4. **执行迁移**：有序、幂等；写入 `stateDir/migrations.json`；失败时停止并给出修复动作，**不得**静默重建空库。
5. **启动**：`app.js --check` 后启动；就绪后才挂载路由。
6. **验证**：登录、权限、关键业务路径、文件哈希与业务引用、Glim 连接状态。
7. **解除维护**：确认无失败项后恢复写入与同步。

## 4. 回退策略

| 变更类型 | 回退方式 | 风险 |
| --- | --- | --- |
| 仅代码、数据模式未变 | 换回旧代码，按同一数据格式启动 | 低；确认无新字段写入 |
| 只加可选字段 | 换回旧代码，保留数据 | 中；旧代码必须忽略新字段 |
| 数据模式不兼容 | 恢复版本匹配的备份，或执行已验证的逆向迁移 | 高；**不能**只回退镜像 |
| 核心 `formatVersion` 升级 | 使用升级前备份文件 | 文件格式不向后兼容 |
| 模块数据文件损坏 | 从备份恢复；不要删除文件让模块重建 | 高；重建会丢业务数据 |
| 误改数据根 | 恢复备份并重新登记区域；不得手工移动目录冒充恢复 | 高 |

回退验收：恢复后校验用户归属、文件哈希与业务引用，不能只看「进程能启动」。

## 5. 升级检查清单

- [ ] 升级前后核心与模块版本已记录。
- [ ] 升级前备份完成，并有恢复演练记录。
- [ ] 迁移可重复执行且不重复写入。
- [ ] 隐式数据根变更被拒绝，显式变更有人工确认记录。
- [ ] 失败模块被标记不可用，业务入口明确提示，不提供半可用状态。
- [ ] 回退路径已在本环境验证（至少一次恢复到备份）。
- [ ] 模块 `dataFile` 与原件/附件目录一起备份，保持一致时间点。

## 6. 已知缺口

| ID | 与本篇相关的影响 |
| --- | --- |
| K2 | ~~核心未接入持久化存储注册表~~（已关闭）：MongoDB 引擎下区域/修订/事件已持久化；备份工具不直接转储数据库 |
| K5 | **部分**：`tools/upgrade.js` 已提供升级与迁移台账，C33 演练通过；外部数据库转储与容器内 `mongodump` 仍需宿主机支持 |
| K6 | 无配额与用量统计，升级前后容量不可比较 |
| K13 | 基线硬编码数据根会导致「改了配置但仍读写旧根」 |
| K14 | **部分**：Disk 已有统一 `fileId`；跨模块统一文件 ID 未接，升级后仍需按业务引用抽查 |

补充（非清单内）：`coreCompatibility` 只有格式校验，没有与核心版本比对；模块 `dataFile` 无格式版本字段。

完整清单与来源见 [`docs/README.md`](../README.md#已知缺口清单)。