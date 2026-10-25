# P1 / M1a 与 P2 / M1b 历史进展报告

> 2026-10-24 起按续建方案重新判定：下述通过项仅是原型和单进程契约证据，不构成正式持久化、真实文件数据面或生产部署完成。当前状态见 [`continuation-baseline.md`](continuation-baseline.md)。

- 日期：2026-10-23
- 范围：公共核心（身份、简单注册、单层管理员）、模块清单与生命周期、存储与文件变更契约、core-only 启动
- 验证：`node --test tests/contracts/*.test.js tests/integration/*.test.js` → **37/37 通过**
- 依赖：仅 Node 内置模块（`node:crypto`、`node:http`、`node:test`），不需要数据库、模型、邮箱或任何业务数据根

## 1. 交付内容

| 任务 | 交付物 | 对应方案 |
| --- | --- | --- |
| B04 最小核心启动、配置 schema、数据库基础 | `core/config/index.js`、`core/server.js`、`core/errors.js` | §4.3、§5.2 |
| B05 新用户模型、认证、会话撤销、单层管理员 | `core/identity/{passwords,store,service}.js` | §5.1、§5.3 |
| B06 简单注册、初始化管理员、邮箱注册依赖 | `core/identity/service.js`（`register`/`bootstrapAdmin`/`verifyEmail`） | §5.2 |
| B07 模块清单、按需加载、生命周期 | `core/registry/{manifest,host}.js` | §4.2、§4.3 |
| C01 存储区域、文件 ID、修订、文件适配器契约 | `core/storage/registry.js` + `contracts/*.schema.json` | §6.1–§6.3 |
| C02 区域与变更日志持久化 | `core/storage/persistence.js`（原子替换写、格式版本、0600） | §6.1、M1b「持久保存区域」 |
| 契约校验基础设施 | `core/contracts/validate.js`（零依赖 JSON Schema 子集） | §4.2 |

## 2. 验收证据（M1a）

| 放行条件 | 证据 |
| --- | --- |
| core-only 可启动 | `tests/integration/core-boot.test.js`：`/healthz` 200、`/readyz` 200 且模块清单为空 |
| 无任何业务模块依赖 | 同测试断言 `/api/pages|disk|survey|paper|glim|mail` 全部 404（未安装模块无路由） |
| 简单注册有效 | 注册→登录→`/api/me`→退出 全链路 200/201，登出后 401 |
| 单层管理员有效 | 首名管理员引导成功；第二次引导 409 `BOOTSTRAP_CLOSED`；普通用户访问 `/api/admin/users` 403 |
| 角色只有 user/admin | `core/identity/service.js` 的 `ROLES`；`setRole` 拒绝非法角色 |
| 最后管理员保护 | 删除/停用/降级唯一管理员 → `LAST_ADMIN_PROTECTED`；有两名管理员时允许 |
| 邮箱注册依赖 Mail | `loadConfig` 在启用邮箱验证且未安装 Mail 时**启动即失败**；注册时 Mail 未配置 → `MAIL_NOT_CONFIGURED`，Mail 故障时不允许跳过验证 |
| 口令不落明文 | 存储中仅 `scrypt$` 哈希；错误响应中不含哈希/口令 |
| 并发初始化只产生一次有效结果 | 三个并发 `bootstrapAdmin` → 1 成功 2 拒绝，管理员数=1 |

## 3. 验收证据（M1b）

| 放行条件 | 证据 |
| --- | --- |
| 纯核心能登记区域 | `StorageRegistry.registerRegion` + 契约校验（非法区域 ID / 缺 disk 字段被拒） |
| 隐式数据根变更被拒绝 | `applyConfig` 变更已登记区域根 → `IMPLICIT_DATA_ROOT_CHANGE`，且内存配置回滚 |
| 未安装 Disk 时写入与变更记录有效 | `recordChange` 不依赖 Disk；幂等重放返回 `idempotent:true`；基础修订不符 → 409 冲突不覆盖；墓碑只能由明确 delete 产生 |
| 游标语义 | 首次调用 `reset:true`；游标过期 `reset:true, reason:'cursor-expired'`，不会被当成「远端为空」 |
| 授权边界 | 区域模块归属、允许操作、按用户所有权、Disk 只读视图四类拒绝均有用例 |
| 路径越界 | `..`、绝对路径、`.` 段一律 `PATH_ESCAPE` |
| 区域与变更日志跨重启保留 | `tests/contracts/persistence.test.js`：重建实例后区域根、修订号、变更记录与游标仍在；重启后仍拒绝隐式换根；文件损坏拒绝启动而非静默重建；权限 0600 |

## 4. 已知缺口（不得宣称已完成）

| 缺口 | 影响 | 归属 |
| --- | --- | --- |
| ~~身份存储只有内存实现~~（已关闭） | `database.engine=mongodb` 时用户、会话与验证码写入 MongoDB（`identity_sessions` 带 TTL）；`state/identity.json` 只是启动与每次变更时重写的导出快照，供离线备份/恢复校验归属。内存实现仅用于默认开发模式 | B04 后续 |
| ~~区域登记与变更日志未持久化~~（已关闭） | MongoDB 引擎下区域、修订与变更事件写入 `storage_regions` / `storage_file_revisions` / `storage_file_events`（`core/storage/mongo-metadata.js`）；文件实现 `PersistentStorageRegistry` 保留作离线导入导出。备份工具仍不能直接转储 MongoDB 集合，需运维另放数据库转储 | C02 后续 |
| ~~模块实现为空~~（已关闭） | 六个模块均有入口、路由、配置 schema 与测试；后台贡献见 C29 | P3 |
| ~~无后台外壳与管理页~~（已关闭） | `admin/` 外壳与六个模块的管理贡献已落地（C29） | P6 |
| ~~无安装器与编排生成~~（已关闭） | `tools/init.js` 生成配置，`deploy/presets` 与安装器同源；升级、备份、恢复、卸载与重装演练由 `tests/integration/deploy-acceptance.test.js` 真实执行（C30–C33） | P6 |
| 配额与用量统计未实现 | Disk 已有单盘配额；跨模块统一用量统计仍缺（K6） | P2 |
| 公开仓库/LICENSE 未决 | M0 阻断项 B1/B2 仍待负责人决策 D1 | P7 |
| 依赖图与许可结论引用 M0 文档 | 不重复记录，见 `docs/m0/M0-report.md`；当前许可清单见 `docs/licenses/dependency-licenses.md` | — |

## 5. 如何复跑

```bash
cd source/site/public-release/pagesai

# 全部核心测试
node --test tests/contracts/*.test.js tests/integration/*.test.js

# 契约 JSON 语法
for f in contracts/*.json; do python3 -c "import json;json.load(open('$f'))"; done

# 归属表与基线不变验证（M0 证据）
./tools/merge-ownership.sh --check
./tools/verify-no-change.sh
```

## 6. 回退方法

- 本阶段只新增 `core/`、`contracts/`、`tests/`、`docs/` 下的文件，未改动既有实现，回退 = 删除/忽略这些新增文件。
- `verify-no-change.sh` 全程 exit 0，可证明既有 `source/site/` 源码未被改动（唯一白名单外部变更为 Nexus 10s 修复，见 `docs/m0/allowed-external-changes.txt`）。