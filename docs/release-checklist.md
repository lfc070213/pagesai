# 完整版历史发布检查单（M0–M6）

> 2026-10-31 范围说明：下文为 2026-10-25 的完整版验收快照，包含本轮已暂缓的客户端、签名与校园链路。它不作为网页预览版的当前判定；最新范围与门禁结果见 [web-preview.md](web-preview.md)。旧 LICENSE、许可及镜像状态不能沿用为当前事实。

> 本检查单把方案 §10.2 的放行条件逐条落到**证据路径**上。任何一行标 `X` 即表示该项未满足，必须写明阻断原因与归属；**存在任何 `X` 时不得宣称可发布**，也不得用"其它项都过了"折抵。

- 判定规则：7 个里程碑的**每一行**都是 `✅` 或 `X`；`部分` 只用于说明"有产物但不足以放行"，等价于未满足。
- 快照时间：**2026-10-25（+08:00）**。下文"本快照实际"一列都是这次运行的真实结果；2026-10-23 的历史记录保留在 §13，不覆盖。
- 结论（一句话）：**不可发布**。服务端、五连接、后台、安装器与同步引擎已有可复跑证据；余下阻断为根 `LICENSE`（D1）、`docs/m0/**` 内网地址、容器镜像 digest（本机无容器运行时）、逐包许可确认、真实设备与签名验收。
- 工具入口：`tools/verify-release.js`（发布物证明）、`tools/verify-no-change.sh`（既有环境不变）、`tools/check-imports.js`（导入闭包）、`tools/export-public.js`（白名单导出与哈希）、`tools/merge-ownership.sh`（归属表）、`deploy/validate-presets.js`（编排组合）、`tools/test-all.js`（全量测试聚合）。

## 0. 总览

| 里程碑 | 放行条件（§10.2 摘要） | 结果 | 主要阻断 |
| --- | --- | --- | --- |
| M0 | 未知项逐项归属；运行时可获取性与同步范围确认；不包含对现有环境的修改 | 部分 | 私有基础镜像未替换、镜像 digest 未锁（K12）；`docs/m0/**` 内网地址仍在仓库内（发布物已 deny） |
| M1a | core-only 启动；无任何业务模块依赖；简单注册与单层管理员有效 | ✅ | — |
| M1b | 纯核心能登记并持久保存区域；Disk 未安装时写入与变更记录有效 | ✅ | MongoDB 引擎下区域/修订/事件入库（K2）；文件版保留作离线导入导出 |
| M2 | 每个模块单独运行，不调用私人平台 | ✅ | 进程级单装与互调验证通过；容器级未验证（归 M5） |
| M3 | 两平台实机同步与数据安全场景；北大版真实链路 | 部分 | 引擎与 Tauri 壳已实现（24 个 Rust 用例）；真实设备、签名与校园链路缺材料（C39） |
| M4 | Glim 对 1/2/4/5/6 五类连接真实闭环、撤销与降级 | ✅ | 五个 HTTP 连接器 + 授权/撤销/能力发现/调用用例 |
| M5 | 必测组合通过；未选模块不加载；邮箱注册依赖严格生效 | 部分 | 后台、安装器与预设矩阵已落地；容器编排与 digest 未验证（K12） |
| M6 | 干净环境可复现；敏感信息/版权处理完；发布范围明确授权 | X | 根 `LICENSE` 缺失（B1/K7/D1）；`docs/m0` 地址；逐包许可确认未完成 |

## 1. 每次发布必须重跑的门禁

| # | 命令 | 通过标准 | 本快照实际 |
| --- | --- | --- | --- |
| G1 | `node tools/verify-release.js` | 退出码 0、0 项阻断 | **退出码 1**：`block 18 / warn 12 / ok 8`；阻断为 `license-root` 1 项 + `address-scan` 17 项（全部位于 `docs/m0/**`）。加 `--exclude docs/m0` 后 `block 1 / warn 8 / ok 8`（只剩根许可证） |
| G2 | `./tools/verify-no-change.sh` | 退出码 0 | **退出码 0**：既有文件 1313 → 1315（2 个白名单新增）；11 项外部变更均已在白名单登记（`docs/audits/**`、`ops/**`） |
| G3 | `node --test tests/contracts/*.test.js tests/integration/*.test.js` | 全部通过 | **退出码 0**：113 例 / 105 通过 / 0 失败 / 8 跳过（跳过项需 MongoDB）；`PAGESAI_MONGO_TEST=1` 时 124/124 通过 |
| G4 | `node tools/check-imports.js` | 0 违规 | **退出码 0**：扫描 227 个文件、0 违规（15 个豁免、1 个关键词豁免） |
| G5 | `node deploy/validate-presets.js` | 退出码 0 | **退出码 0 PASS**：12/12 预设、64 种组合、96 次版本检查、64 项负例；digest 锁定 0 / 本地构建 2 / 基础标签 1 待办（K12） |
| G6 | `./tools/merge-ownership.sh --check` | 退出码 0 | **通过**：1,313 个文件覆盖完整、无重复、8 列合法 |
| G7 | `node tools/export-public.js --out /tmp/pagesai-export-check --dry-run` | 退出码 0 且 missing/unmapped/collisions 为 0 | **通过**：导出 671、待定 34、不导出 608、实际 670（硬排除 1 = `glim/server/.env.example`）；missing 0 / unmapped 0 / collisions 0；敏感 47；`inventoryHash=59928caf…`，基线 `bd343100…` |
| G8 | `node --test modules/*/tests/*.test.js` | 全部通过 | **退出码 0**：185 例 / 179 通过 / 0 失败 / 6 跳过；`PAGESAI_MONGO_TEST=1` 时 199/199 通过 |
| G9 | `node tools/test-all.js` | 退出码 0、0 失败 | **退出码 0**：51/51 文件、298 例 / 284 通过 / 0 失败 / 14 跳过 |

复跑记录（时间、命令、退出码、结论）必须写进 §13，不允许只写"已跑过"。

## 2. M0 — 基线与可行性审计

放行条件：未知项逐项归属；运行时可获取性与同步范围确认；不包含对现有环境的修改。

| # | 条件 | 证据路径 | 结果 | 说明 / 阻断原因 |
| --- | --- | --- | --- | --- |
| M0-1 | 精确基线可解析 | `docs/m0/A01-scope-baseline.md`；基线 `a8af402bba75` | ✅ | 基线提交与文件数 1,313 在 A01 与 `ownership/summary.md` 中一致 |
| M0-2 | 范围白名单冻结 | `docs/m0/A01-scope-baseline.md`、`docs/m0/ownership/ownership-map.tsv` | ✅ | 1,313 行、8 列、无重复；`merge-ownership.sh --check` 通过 |
| M0-3 | 依赖图 | `docs/m0/A02-dependency-graph.md` | ✅ | 外部服务 21 类、待验证 V1–V18 |
| M0-4 | 文件写入图 | `docs/m0/A03-data-roots-writes.md` | ✅ | 数据根、写入入口、W1–W5 高危写入面已登记 |
| M0-5 | 客户端同步差距 | `docs/m0/A04-client-sync-gap.md` | ✅ | 结论：需新建同步引擎（不是改造现有设备盘代理） |
| M0-6 | 许可与敏感信息清单 | `docs/m0/A05-license-sensitive.md`、`docs/licenses/dependency-licenses.md` | ✅ | 审计完成；许可清单已生成（npm 49 已确认，cargo/asset 待确认，见 B2） |
| M0-7 | 未知项逐项归属 | A02 的 V1–V18、A05 的 B1–B8、`docs/m0/checks/XCHECK-A02A03.md`、`XCHECK-A04A05.md` | ✅ | 每条都有归属阶段与关闭条件 |
| M0-8 | 运行时依赖可获取性确认 | `docs/m0/A02-dependency-graph.md`、`docs/m0/A05-license-sensitive.md` §1.5、`contracts/runtime-topology.json` | X | 私有 `node24-base` 基础镜像不可用于公开构建；预设改用 `pagesai/app:local` / `pagesai/gateway:local` 并登记 `blocked-no-container-runtime-on-host`；宿主无 docker/podman/nerdctl/colima，镜像从未构建或拉取 → 干净环境不可复现（K12） |
| M0-9 | 同步范围确认 | `docs/m0/A04-client-sync-gap.md`、`docs/modules/disk.md`、`modules/disk/sync/` | ✅ | 范围明确为"新建映射级双向同步引擎"，引擎已落地并有 24 个 Rust 用例；实机验收归 M3 |
| M0-10 | 不包含对现有环境的修改 | `tools/verify-no-change.sh` | ✅ | **退出码 0**：既有文件数 1313→1315（2 个白名单新增）；11 项外部变更（`docs/audits/**` 1 项、`ops/**` 3 项及其伴生行）均已在白名单登记 |

## 3. M1 — 最小核心、身份与单层管理员（M1a）

放行条件：core-only 启动；无任何业务模块依赖；简单注册与单层管理员有效。

| # | 条件 | 证据路径 | 结果 | 说明 |
| --- | --- | --- | --- | --- |
| M1a-1 | core-only 可启动（`/healthz`、`/readyz`） | `tests/integration/core-boot.test.js` | ✅ | 通过 |
| M1a-2 | 无业务模块依赖（未安装即 404） | `tests/integration/core-boot.test.js` | ✅ | 断言 `/api/pages|disk|survey|paper|glim|mail` 全 404 |
| M1a-3 | 简单注册有效 | `tests/contracts/identity.test.js`、`core/identity/service.js` | ✅ | 注册→登录→`/api/me`→登出全链路 |
| M1a-4 | 单层管理员（只有 user/admin） | `core/identity/service.js`（`ROLES`）、`tests/contracts/identity.test.js` | ✅ | 非法角色被拒 |
| M1a-5 | 首名管理员只能引导一次 | `tests/integration/core-boot.test.js` | ✅ | 第二次 409 `BOOTSTRAP_CLOSED`；并发引导只成功一次 |
| M1a-6 | 最后管理员保护 | `core/identity/service.js`（三处判定）、`tests/contracts/identity.test.js` | ✅ | 删除/停用/降级唯一管理员 → `LAST_ADMIN_PROTECTED` |
| M1a-7 | 邮箱注册强依赖 Mail | `core/config`、`core/identity/service.js`、`tests/integration/core-boot.test.js` | ✅ | 启用邮箱验证但未装 Mail → 启动即失败；Mail 未配置 → `MAIL_NOT_CONFIGURED` |
| M1a-8 | 口令不落明文 | `core/identity/passwords.js`、`tests/contracts/identity.test.js` | ✅ | 存储只有 `scrypt$` 前缀；错误响应不含哈希 |
| M1a-9 | 回归全绿 | G3 | ✅ | 113 例 / 105 通过 / 0 失败 / 8 跳过；Mongo 模式 124/124。`tests/contracts/imports.test.js` 与 `tests/integration/module-mount.test.js` 均已通过 |

## 4. M1b — 存储区域与文件变更契约

放行条件：纯核心能登记并持久保存区域；Disk 未安装时写入与变更记录有效。

| # | 条件 | 证据路径 | 结果 | 说明 |
| --- | --- | --- | --- | --- |
| M1b-1 | 纯核心可登记区域并做契约校验 | `core/storage/registry.js`、`contracts/storage-region.schema.json`、`tests/contracts/storage.test.js` | ✅ | 非法区域 ID / 缺 disk 字段被拒 |
| M1b-2 | 区域与变更日志持久化（跨重启） | `core/storage/persistence.js`、`tests/contracts/persistence.test.js` | ✅ | 重启后区域根、修订号、变更记录与游标仍在；权限 `0600`；损坏拒绝启动 |
| M1b-3 | 拒绝隐式换根 | `core/storage/registry.js`、`core/storage/persistence.js`、`tests/contracts/persistence.test.js` | ✅ | `IMPLICIT_DATA_ROOT_CHANGE`，内存配置回滚 |
| M1b-4 | Disk 未安装时写入与变更记录有效 | `tests/contracts/storage.test.js` | ✅ | `recordChange` 不依赖 Disk |
| M1b-5 | 变更幂等 | `core/storage/registry.js`、`tests/contracts/storage.test.js` | ✅ | 重放返回 `idempotent: true`；不重复落盘 |
| M1b-6 | 修订冲突不覆盖 | 同上 | ✅ | 基础修订不符 → 409 |
| M1b-7 | 路径越界拒绝 | `core/storage/registry.js`、`core/registry/manifest.js`、`tests/contracts/storage.test.js` | ✅ | 绝对路径、反斜杠、空字节、`.`/`..` 段一律 `PATH_ESCAPE` |
| M1b-8 | 游标语义（过期不当作"远端为空"） | `tests/contracts/storage.test.js` | ✅ | `reset:true, reason:'cursor-expired'` |
| M1b-9 | 持久化接入核心 HTTP 入口 | `core/storage/mongo-metadata.js`、`tests/integration/core-boot.test.js`、`tests/integration/storage-mongodb.test.js` | ✅ | `database.engine=mongodb` 时区域、修订与变更事件写入 `storage_regions` / `storage_file_revisions` / `storage_file_events`（K2 关闭）；文件版 `PersistentStorageRegistry` 保留作离线导入导出 |

## 5. M2 — 六模块独立运行

放行条件：每个模块单独运行，不调用私人平台；服务端阶段不宣称客户端同步已完成。

| # | 条件 | 证据路径 | 结果 | 说明 |
| --- | --- | --- | --- | --- |
| M2-1 | Pages 单独运行 | `modules/pages/server/dev.js`、`modules/pages/tests/`、`tests/integration/pages-clean-install.test.js` | ✅ | 站点/文件/发布/回滚/公开访问/AI 适配器 + 8 工具；自带 `dev.js --once` 启动与干净安装用例 |
| M2-2 | Disk 服务端单独运行 | `modules/disk/server/dev.js`、`modules/disk/tests/`、`tests/integration/disk-clean-install.test.js` | ✅ | 分块上传、Range、软删恢复、分享、配额、修订冲突；干净安装用例通过 |
| M2-3 | Glim 单独运行 | `modules/glim/server/dev.js`、`modules/glim/tests/` | ✅ | 会话、记忆、模型适配、connector 登记/授权/撤销/工具、任务与工作区 |
| M2-4 | Mail 单独运行 | `modules/mail/server/dev.js`、`modules/mail/providers/`、`modules/mail/tests/` | ✅ | 发信、验证码、幂等、收件、附件、HTML 净化；真实 SMTP/IMAP 协议栈 + 假服务器协议用例 |
| M2-5 | Survey 单独运行 | `modules/survey/server/dev.js`、`modules/survey/tests/`、`tests/integration/survey-clean-install.test.js` | ✅ | 问卷、发布快照、匿名填写、关闭、统计、CSV、附件；干净安装用例通过 |
| M2-6 | Paper 单独运行 | `modules/paper/server/dev.js`、`modules/paper/tests/`、`tests/integration/paper-clean-install.test.js` | ✅ | 上传、提取、切分、翻译断点恢复、带引用问答；干净安装用例通过 |
| M2-7 | 不调用私人平台 | `tools/check-imports.js` | ✅ | G4 0 违规；模块只依赖 Node 内置与公共核心 |
| M2-8 | 服务端阶段不宣称客户端同步已完成 | `docs/README.md`、`docs/modules/disk.md` | ✅ | 文档明确区分"引擎已实现"与"实机验收未完成"，未把引擎用例当作实机同步证据 |

## 6. M3 — 单盘双版本与客户端同步

放行条件：两平台实机同步及数据安全场景通过；北大版有真实链路验收。

| # | 条件 | 证据路径 | 结果 | 说明 |
| --- | --- | --- | --- | --- |
| M3-1 | 通用/北大单盘共用数据面 | `modules/disk/`、`deploy/presets/*`、`config/disk-network-policy` 相关配置 | 部分 | 差异收敛为 `DISK_NETWORK_POLICY` 单一开关；未在真实校园/校外链路验证 |
| M3-2 | Windows 实机同步 | `modules/disk/client/src-tauri/`、`modules/disk/sync/` | 部分 | Tauri 2 外壳与 Rust 同步引擎已实现；无 Windows 机器与安装包签名材料 |
| M3-3 | macOS 实机同步 | 同上 | 部分 | 同上 |
| M3-4 | 数据安全场景（双端修改、删除对修改、大小写冲突、断电、磁盘满、令牌撤销） | `modules/disk/sync/src/engine_tests.rs`、`docs/m0/A04-client-sync-gap.md` §5 | 部分 | 引擎用例覆盖冲突副本、游标过期、网络失败不删本地、崩溃恢复、目录重命名收敛、端点故障切换、Windows 命名规则（24/24）；缺实机断电/磁盘满/令牌撤销演练 |
| M3-5 | 北大版真实链路验收 | `docs/m0/A04-client-sync-gap.md`、`docs/modules/disk.md` | X | 无真实校园网络条件下的链路验收报告 |
| M3-6 | 客户端签名与更新清单 | `docs/m0/A04-client-sync-gap.md` §6 | X | 本机无签名/公证材料；安装包与更新清单未产出 |

## 7. M4 — Glim 五连接

放行条件：五类连接各自真实业务闭环、撤销和故障降级通过。

| # | 条件 | 证据路径 | 结果 | 说明 |
| --- | --- | --- | --- | --- |
| M4-1 | 连接 Pages（1） | `modules/glim/connectors/pages.js`、`modules/glim/tests/connectors.test.js` | ✅ | 授权、撤销、能力发现、调用均有用例 |
| M4-2 | 连接 Disk（2） | `modules/glim/connectors/disk.js`、同上 | ✅ | 同上 |
| M4-3 | 连接 Mail（4） | `modules/glim/connectors/mail.js`、同上 | ✅ | 同上 |
| M4-4 | 连接 Survey（5） | `modules/glim/connectors/survey.js`、同上 | ✅ | 同上 |
| M4-5 | 连接 Paper（6） | `modules/glim/connectors/paper.js`、同上 | ✅ | 同上 |
| M4-6 | 撤销与超时降级 | `contracts/module-manifest.schema.json`、`core/registry/host.js`、`modules/glim/connectors/index.js` | ✅ | 能力只暴露 `implemented: true`（由适配器能力决定）；撤销与超时语义已实现 |
| M4-7 | 无 owner 回落 | `core/identity/service.js` | ✅ | 公开版无固定 owner 特权；首名管理员由引导产生 |

## 8. M5 — 后台、安装升级与组合

放行条件：必测组合通过；未选模块不加载；邮箱注册依赖严格生效。

| # | 条件 | 证据路径 | 结果 | 说明 |
| --- | --- | --- | --- | --- |
| M5-1 | 动态后台外壳与管理页 | `admin/`（`index.html`、`admin.js`、`admin.css`）、模块管理贡献 | ✅ | 统一后台外壳 + 六模块启停/配置/故障视图（C29） |
| M5-2 | 安装器与配置生成 | `tools/init.js`、`config/config.schema.json`、`tests/integration/deploy-acceptance.test.js` | ✅ | 预设与安装器同源 dry-run、干净安装矩阵与升级/恢复演练均有用例 |
| M5-3 | 编排预设可用 | `deploy/presets/*.yml`、`deploy/validate-presets.js`、`contracts/runtime-topology.json` | 部分 | 12 预设静态校验 PASS；镜像为 `:local`、宿主无容器运行时，未在真实 Docker 主机启动（K12） |
| M5-4 | 64 种组合静态校验 | `deploy/validate-presets.js --matrix` | ✅ | PASS：64 组合、96 次版本检查、64 项负例 |
| M5-5 | 未选模块不加载 | `core/registry/host.js`、`tests/integration/core-boot.test.js` | ✅ | 未登记不 `require`、不挂路由 |
| M5-6 | 邮箱注册依赖严格生效 | `core/config`、`tests/integration/core-boot.test.js` | ✅ | 未装 Mail 启动失败；未配置注册被拒 |
| M5-7 | 升级/备份/恢复工具 | `tools/upgrade.js`、`tools/backup.js`、`tools/restore.js`、`tests/integration/deploy-acceptance.test.js` | 部分 | 进程级升级/备份/恢复演练通过；备份包不能直接转储 MongoDB 集合，需运维另放数据库转储 |
| M5-8 | 必测组合运行级验证（core-only、六单模块、三种双模块、全模块两版） | `tests/integration/deploy-acceptance.test.js`、`tests/integration/*-clean-install.test.js` | 部分 | 17 组合干净安装矩阵、停用/启用/卸载/重装演练通过；容器级未执行 |

## 9. M6 — 文档、许可证与发布证明

放行条件：干净环境可复现；敏感信息/版权问题处理完；发布范围明确授权。

| # | 条件 | 证据路径 | 结果 | 说明 |
| --- | --- | --- | --- | --- |
| M6-1 | 首页首屏写清"每模块可独立使用、按需组合" | `README.md`、`docs/README.md` | ✅ | 首屏承诺与当前状态并列，无夸大 |
| M6-2 | 六模块依赖/单装/使用/组合/配置/故障/卸载说明 | `docs/modules/{pages,disk,glim,mail,survey,paper}.md` | ✅ | 六份文档齐备，状态与实现一致（前端、客户端、连接器已实现，未验收项单列） |
| M6-3 | Glim 五连接实现状态与撤销说明 | `docs/modules/glim.md`、`README.md` | ✅ | 五个连接器已实现；文档写清授权、撤销、能力发现与降级 |
| M6-4 | 唯一管理员层级/自动后台/简单注册说明 | `docs/guides/*.md`、`SECURITY.md`、`admin/` | ✅ | 管理员与注册说明齐备；后台外壳已装配，说明与实际一致 |
| M6-5 | 许可证 | `LICENSE-DECISION.md`、根 `LICENSE` | X | 根 `LICENSE` **不存在**（B1/K7）；决策 D1 未做，只有候选分析 |
| M6-6 | 第三方声明 | `THIRD_PARTY_NOTICES.md`、`docs/licenses/dependency-licenses.md` | 部分 | npm 49 项已确认；cargo 552 / asset 1 / project 1 待确认；PDF.js/KaTeX 未随包分发，登记为"待补"（B2） |
| M6-7 | 敏感信息检查 | `docs/security-scan-report.md`、`tools/verify-release.js`、`config/public-bundle-policy.json` | X | `docs/m0/**` 内 17 处阻断级地址（真实内网地址/Tailnet 主机名/本机路径/owner 常量）；发布物策略已 deny 该目录，但默认门禁仍阻断 |
| M6-8 | 贡献回收流程 | `CONTRIBUTING.md` §6 | ✅ | 已写"公开仓是发行镜像 + 回收 7 步 + 导出前 SHA 对账" |
| M6-9 | 漏洞披露渠道与支持版本 | `SECURITY.md` | 部分 | 政策与不变量已写；渠道与安全邮箱仍是占位，发布前必须落实真实渠道 |
| M6-10 | 干净环境可复现构建 | `docs/m0/A02-dependency-graph.md`、`deploy/`、`contracts/runtime-topology.json` | X | 基础镜像未替换、镜像从未构建、digest 未锁（K12） |
| M6-11 | 验收报告（单模块/组合/同步冲突/实机/恢复/干净构建） | `tests/`、`deploy/`、`docs/security-scan-report.md` | 部分 | 298 用例 + 24 Rust 用例 + 17 组合部署验收；缺实机同步、签名与干净构建报告 |
| M6-12 | 未解决问题列表（负责人/影响/限制/计划版本） | `docs/README.md` K1–K19 | ✅ | 19 项均有影响与证据链接 |
| M6-13 | 发布范围明确授权 | `LICENSE-DECISION.md` §5、本文件 §12 | X | D1（许可证）/D2（微信通道）/D3（入口解耦）均未决；无负责人签字 |
| M6-14 | 发布物证明可复跑 | `tools/verify-release.js` | X | 本快照退出码 1：仅 `license-root` 与 `docs/m0/**` 地址两类阻断（见 §13） |

## 10. 阻断项台账（B1–B8）

| # | 阻断项 | 当前状态 | 证据 / 关闭条件 |
| --- | --- | --- | --- |
| B1 | 无根 `LICENSE` | X 未关闭 | 见 M6-5；关闭条件：`LICENSE` 存在且 `verify-release` 的 `license-root` 为 OK（负责人决策 D1） |
| B2 | 无第三方声明承接（PDF.js Apache-2.0） | 部分 | `THIRD_PARTY_NOTICES.md` 与 `docs/licenses/dependency-licenses.md` 已建；PDF.js/KaTeX 未随包分发，cargo/asset 条目待确认；关闭条件：资产落地并附许可证正文、逐包确认清零 |
| B3 | Disk 服务端无依赖清单 | ✅ 已关闭 | 新模块为零第三方依赖（只用 Node 内置与公共核心），`modules/disk/` 不需要 `package.json`；`check-imports.js` 0 违规证明无外部包引用 |
| B4 | 内网/Tailscale 地址硬编码 | 部分 | `docs/m0/**` 的真实地址仍在仓库内（发布物已 deny，默认门禁阻断）；`tools/{init,restore,uninstall}.js` 的旧数据根字面量位于拒绝清单，属有意保留，待负责人确认 |
| B5 | 固定 owner `myc` 特权 | ✅ 公开版已无 | 新代码无写死的 owner 常量；`docs/m0` 中的记录属审计证据 |
| B6 | 环境变量未声明 | ✅ 已关闭 | `config/README.md` §4 列出全部环境变量并与 `config/example.env` 一一对应 |
| B7 | 核心入口混装不导出模块 | ✅ 公开版已隔离 | `core/server.js` 不 import 任何 `modules/`；G4 0 违规 |
| B8 | 个人邮箱/本机绝对路径 | 部分 | 新代码无真实邮箱；`docs/m0` 含本机路径；`tests` 使用合成的用户目录夹具；`docs/security-scan-report.md` 记录扫描面与残留 |

## 11. 迁移台账（发布记录）

台账文件：`<dataRoot>/state/migrations.json`（`config.database.stateDir` 下），格式版本 `formatVersion=1`。
签名规则：`signatureSha256 = sha256("<id>|<module>|<signature>")`；**签名一经发布不得修改**，修改会被台账校验判为不兼容。

| 迁移 ID | 模块 | 名称 | 签名 | 记录位置 |
| --- | --- | --- | --- | --- |
| 0001 | core | 部署标记与配置对齐 | deployment-marker/v1 | `tools/upgrade.js` |
| 0002 | core | 身份冷启动快照 | identity-snapshot/v1 | `tools/upgrade.js` |
| 0003 | core | 存储区域目录 | region-layout/v1 | `tools/upgrade.js` |
| 0004 | core | 迁移台账格式 | migration-ledger-format/v1 | `tools/upgrade.js` |
| 0005 | core | 秘密材料引用 | secrets-reference/v1 | `tools/upgrade.js` |

规则：

1. 新增迁移必须同时更新本表（ID + 签名），否则 `tools/verify-release.js` 的 `migration-ledger` 检查阻断发布。
2. 迁移 ID 必须四位以上数字、严格递增、全局唯一；签名必须唯一。
3. 每次发布记录本次实际部署的台账路径与已应用条目数：`node tools/verify-release.js --ledger <stateDir>/migrations.json`。
4. 本快照未对任何真实部署执行过迁移，故无 `--ledger` 记录；这是"未发布"的正常状态，不能当作已验证。

## 12. 发布判定与签字

| 角色 | 职责 | 姓名/签署 | 日期 |
| --- | --- | --- | --- |
| 执行人（发布负责人） | 跑 §1 全部门禁、汇总证据 | `<待填>` | `<待填>` |
| 独立验收人 | 复核 X 项是否真的关闭，不复用执行人的结论 | `<待填>` | `<待填>` |
| 项目负责人 | 决策 D1/D2/D3、许可与渠道授权 | `<待填>` | `<待填>` |

判定规则（按顺序）：

1. §1 的 G1–G9 全部退出码 0 → 否则不可发布。
2. §2–§9 中不再有 `X` 与 `部分` → 否则不可发布。
3. §10 的 B1–B8 全部关闭 → 否则不可发布。
4. §12 三行签字齐全 → 否则不可发布。

**本快照判定：不可发布。** 阻断原因按影响排序：

1. 根 `LICENSE` 缺失（B1/K7/D1）——法律层面默认"保留所有权利"，公开推送即违反预期；D2/D3 未决、无负责人签字（M6-13）。
2. `docs/m0/**` 内仍有 17 处真实内网地址/Tailnet 主机名/本机路径（M6-7/B4/B8），默认门禁阻断；发布物已 deny，但仓库本身未脱敏。
3. 容器镜像从未构建、digest 未锁（M0-8/M6-10/K12）；只有静态预设校验，没有容器编排运行证据（M5-3/M5-8）。
4. 逐包许可未确认（cargo 552 / asset 1 / project 1），PDF.js/KaTeX 未随包分发（M6-6/B2）。
5. 真实设备同步、签名与校园链路验收缺失（M3-2/M3-3/M3-5/M3-6/C39）。
6. 漏洞披露渠道仍为占位（M6-9）。

## 13. 复跑记录

### 2026-10-25 快照

| 时间（+08:00） | 命令 | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| 2026-10-25 | `node tools/verify-release.js` | `1` | `block 18 / warn 12 / ok 8`；`--exclude docs/m0` → `block 1 / warn 8 / ok 8` |
| 2026-10-25 | `./tools/verify-no-change.sh` | `0` | 既有文件 1313→1315；11 项白名单外部变更 |
| 2026-10-25 | `node --test tests/contracts/*.test.js tests/integration/*.test.js` | `0` | 113 例 / 105 通过 / 8 跳过；Mongo 模式 124/124 |
| 2026-10-25 | `node tools/check-imports.js` | `0` | 227 个文件、0 违规 |
| 2026-10-25 | `node deploy/validate-presets.js --matrix` | `0` | PASS：12/12 预设、64 组合、96 次版本检查、64 项负例 |
| 2026-10-25 | `./tools/merge-ownership.sh --check` | `0` | 1,313 个文件通过 |
| 2026-10-25 | `node tools/export-public.js --out /tmp/pagesai-export-check --dry-run` | `0` | 导出 671 / 待定 34 / 不导出 608 / 实际 670；inventoryHash `59928caf…` |
| 2026-10-25 | `node --test modules/*/tests/*.test.js` | `0` | 185 例 / 179 通过 / 6 跳过；Mongo 模式 199/199 |
| 2026-10-25 | `node tools/test-all.js` | `0` | 51/51 文件、298 例 / 284 通过 / 14 跳过 |
| 2026-10-25 | `cd modules/disk/sync && cargo test --locked` | `0` | 24/24 通过（`CARGO_TARGET_DIR` 指向临时目录） |

`verify-release.js` 本次结果（摘录，完整数据用 `--json`）：

```text
[BLOCK] license-root          根 LICENSE       → 缺失（B1/K7/D1）
[BLOCK] address-scan          docs/m0/**       → 17 处阻断（真实内网地址 / Tailnet 主机名 / 本机路径 / owner 常量）
[OK]    image-digests         deploy/presets/  → 无占位标签；改用 :local 并登记 blocked-no-container-runtime-on-host（K12 未关闭）
[OK]    third-party-notices   覆盖必需类目，PDF.js/KaTeX 标"待补"
[OK]    forbidden-artifacts   未发现 node_modules/.env/*.pem/数据库/备份包
[OK]    secrets-scan          无私钥与真实令牌
[OK]    migration-ledger      0001–0005 ID 唯一/递增/签名唯一，与 §11 一致
```

### 2026-10-23 历史快照（保留，不覆盖）

| 时间（+08:00） | 命令 | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| 2026-10-23 11:20 | `node tools/verify-release.js` | `1` | 见下（当时新增工具后首次运行） |
| 2026-10-23 11:19 | `./tools/verify-no-change.sh` | `1` | 既有文件数 1313→1315；4 个未登记变更 |
| 2026-10-23 11:18 | `node --test tests/contracts/*.test.js` | `1` | tests 40 / pass 39 / fail 1（`imports.test.js`） |
| 2026-10-23 11:18 | `node --test tests/integration/*.test.js` | `1` | tests 9 / pass 8 / fail 1（`module-mount.test.js`） |
| 2026-10-23 11:17 | `node tools/check-imports.js` | `1` | 5 项 `forbidden-keyword` |
| 2026-10-23 11:17 | `node deploy/validate-presets.js` | `1` | FAIL（11 项）；镜像 digest 待办 5 个 |
| 2026-10-23 11:16 | `./tools/merge-ownership.sh --check` | `0` | 1,313 个文件通过 |
| 2026-10-23 11:16 | `node tools/export-public.js --out /tmp/pagesai-export-20261023 --dry-run` | `0` | 导出 670 / 待定 34 / 不导出 608 / 硬排除 1；inventoryHash `59928caf…` |

当时的阻断摘要（已被 2026-10-25 快照取代，保留以便对照）：

```text
[BLOCK] license-root          根 LICENSE       → 缺失（B1/K7）
[BLOCK] address-scan          docs/m0/**       → 真实内网地址 / Tailnet 主机名 / owner 常量
[BLOCK] image-digests         deploy/presets/  → 12 个预设共 48 处 TAG-TODO-DIGEST 占位
[OK]    third-party-notices   覆盖 7 个必需类目，PDF.js/KaTeX 标"待补"
[OK]    forbidden-artifacts   未发现 node_modules/.env/*.pem/数据库/备份包
[OK]    secrets-scan          无私钥与真实令牌
[OK]    migration-ledger      0001–0005 ID 唯一/递增/签名唯一，与 §11 台账表一致
```

> 维护规则：每次重跑 §1 都要**追加**一行到本表并更新上面的"本快照实际"列，不得覆盖历史记录；标记为 `X` 的行只能在拿到证据后改成 `✅`，且改动本身要说明是谁在什么时候复核的。