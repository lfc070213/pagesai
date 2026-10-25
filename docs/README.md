# PagesAI 公开版文档

> **当前完成度以 [`release-checklist.md`](release-checklist.md) 的快照（2026-10-25）为准。** 六模块、客户端同步、五连接与统一后台均已实现并有测试；正式发布仍被根 `LICENSE`、镜像摘要、真实设备/签名验收与安全报告渠道等外部项阻断，逐项见检查单与文末缺口清单。

**目标：公共核心 + 六个业务模块，每个模块都能单独安装、单独使用，也能按需组合。**

- 每个模块都是一个独立服务端入口（`manifest.json` + `server/index.js`），只依赖 Node 内置模块与公共核心，**不需要**其他模块、数据库、消息队列或第三方包。
- 不装其他模块时，每个模块都能用自带 `dev.js` 单独跑起来；装进公共核心后由核心按启用状态挂载路由，未安装模块没有任何可调用路由。
- 组合不改变数据：安装/卸载 Disk 只增删一个授权视图，不搬动 Pages / Paper / Survey 的文件。
- 唯一强制的跨模块条件：**启用邮箱验证注册时必须有 Mail**（未安装则核心启动即失败）。这是显式依赖，不是隐藏依赖。

| 模块 | 一句话能力 | 单独安装需要 | 已实现 | 明确未实现 |
| --- | --- | --- | --- | --- |
| [Pages](modules/pages.md) | AI 创建、修改、预览、发布网页 | 公共核心 + MongoDB（正式数据面） | 站点/文件/发布/回滚/公开访问、真实控制台、持久任务与 SSE、租户后端托管、8 工具 | 容器级沙盒、配额与用量统计、对象存储 |
| [Disk](modules/disk.md) | 一个逻辑盘；上传下载、分享 | 公共核心 + MongoDB/ContentStore | 分块续传、Range、软删恢复、分享、配额、修订冲突、网页端、双向同步引擎与 Tauri 客户端 | 签名安装包、真实设备与校园链路验收 |
| [Glim](modules/glim.md) | 可单独使用的智能体；五连接 | 公共核心 + 模型适配器 | 会话、记忆、模型适配、任务、工作区、网页端、connector 登记/授权/撤销、五连接 37 工具 | 流式输出、执行沙盒、外部渠道、连接健康探测与审计 |
| [Mail](modules/mail.md) | 发信（验证码/通知）+ 邮箱客户端 | 公共核心 + SMTP/IMAP | 发信、验证码、幂等、收件、附件、HTML 净化、内置 SMTP/IMAP 协议客户端、网页邮箱 | 草稿、搜索、退信解析、附件上传 |
| [Survey](modules/survey.md) | 创建、发布、填写、统计、导出 | 公共核心 | 问卷、发布快照、匿名填写、关闭、统计、CSV、附件、管理/填写网页 | 答卷票据、配额、审核、通知、二维码、Excel 导出 |
| [Paper](modules/paper.md) | 论文上传、阅读、翻译、问答 | 公共核心 + 模型适配器 | 上传（流式原件）、提取、切分、翻译（断点/停止）、带引用问答、网页阅读器、6 工具 | OCR、配额、后台任务队列 |

> **不要把上表读成「可发布」**：所有能力都有代码与测试（模块 185 例、契约 57 例、集成 56 例；合计 298 例，284 通过、14 跳过、0 失败），但发布还要求根许可证、镜像摘要、真实设备/签名与安全报告渠道等外部条件，见[发布检查单](release-checklist.md)与文末[已知缺口清单](#已知缺口清单)。

## 快速开始

```bash
cd source/site/public-release/pagesai

# 1) 契约与核心（身份/会话/模块生命周期/存储契约）
node --test tests/contracts/*.test.js

# 2) 六个模块各自的用例（在公开版根目录依次跑）
for m in pages disk glim mail survey paper; do
  node --test modules/$m/tests/*.test.js
done

# 3) 部署预设静态组合校验（64 种组合 / 96 次策略检查）
node deploy/validate-presets.js --matrix

# 4) 任选一个模块单独启动（示例：Pages）
node modules/pages/server/dev.js --once
```

预期：契约 `57 pass / 0 fail`；集成 `48 pass / 8 skip / 0 fail`；六个模块合计 `179 pass / 6 skip / 0 fail`（185 例）；预设校验 `结果：PASS`；模块打印 `{"url":"http://127.0.0.1:PORT"}`。一次性跑完全部：`node tools/test-all.js`（当前 51 个文件、298 例、284 通过、14 跳过、0 失败）。

启动公共核心并完成注册/登录/管理员引导：见 [快速开始](guides/quickstart.md)。

## 当前交付状态

| 能力 | 状态 | 证据 |
| --- | --- | --- |
| core-only 启动、健康/就绪 | 已实现 | `tests/integration/core-boot.test.js` |
| 注册、登录、会话撤销、单层管理员 | 已实现 | `tests/contracts/identity.test.js` |
| 模块清单、登记、启停、健康、能力过滤 | 已实现 | `tests/contracts/registry.test.js` |
| 存储区域、授权、路径、幂等、条件写入、游标 | 已实现 | `tests/contracts/storage.test.js` |
| 区域与变更日志持久化 | 已实现并接入核心（MongoDB 元数据；文件版保留离线导入导出） | `core/storage/mongo-metadata.js`、`tests/contracts/persistence.test.js` |
| 六个业务模块（服务端） | 已实现 | `modules/*/tests/*.test.js` |
| 前端页面 | 六模块网页与统一后台外壳已实现 | `modules/*/web/`、`admin/` |
| 安装器与真实部署验证 | 部分（安装/升级/备份恢复进程级验收通过；宿主机无容器运行时，镜像未构建） | `deploy/`、`tests/integration/deploy-acceptance.test.js` |
| 配额与用量统计 | 部分（Disk 单盘配额；统一用量统计未实现） | `modules/disk/` |
| 客户端同步引擎 | 已实现（24 个 Rust 用例）；签名安装包与真机验收未完成 | `modules/disk/sync`、`modules/disk/client` |

## 文档索引

| 文档 | 读者 | 内容 |
| --- | --- | --- |
| [快速开始](guides/quickstart.md) | 所有人 | 跑起核心并完成冒烟 |
| [安装指南](guides/install.md) | 部署者 | 安装模型、依赖矩阵、核心与模块安装、预设 |
| [升级指南](guides/upgrade.md) | 运维 | 兼容检查、迁移、回退矩阵 |
| [备份与恢复](guides/backup-restore.md) | 运维 | 备份范围、一致性、恢复验收 |
| [故障排查](guides/troubleshooting.md) | 所有人 | 分诊顺序、错误码、症状表 |
| [安全说明](guides/security.md) | 部署者/审计 | 已实现控制、未实现风险、加固清单 |
| [架构说明](architecture.md) | 开发者 | 运行单元、装配、状态机、存储、身份、五连接 |
| [模块文档](modules/) | 使用者/开发者 | 六个模块的依赖、单装、能力、配置、连接、故障、缺口 |
| [M0 审计](m0/README.md) | 复核者 | 基线、依赖图、数据根、客户端差距、许可 |
| [发布检查单](release-checklist.md) | 复核者/发布负责人 | M0–M6 放行条件、G1–G9 门禁与 2026-10-25 证据快照 |
| [安全扫描报告](security-scan-report.md) | 复核者 | 发布物地址、密钥与禁止制品扫描结果及处置 |
| [阶段进展](P3-P7-status.md) | 复核者 | P3–P7 交付、测试与已知缺口 |
| [续建基线](continuation-baseline.md) | 复核者 | C01–C03 审查基线（施工前状态，不代表当前完成度） |
| [契约目录](../contracts/README.md) | 开发者 | 模块清单、存储区域、文件变更契约 |

## 三种最短路径

- **只想跑起来**：[快速开始](guides/quickstart.md) → 任选模块的[模块文档](modules/) → [故障排查](guides/troubleshooting.md)。
- **准备部署**：[架构说明](architecture.md) 的「运行单元」→ [安装指南](guides/install.md) → [安全说明](guides/security.md) 的加固清单。
- **评估能否交付**：先看文末[已知缺口清单](#已知缺口清单)，再看 [M0 报告](m0/M0-report.md) 的放行判断。

## 版本与契约

- 契约先冻结、再实现：`contracts/module-manifest.schema.json`、`storage-region.schema.json`、`file-change.schema.json`。
- 加字段是兼容变更；必填字段、枚举取值与语义变更是破坏性变更，必须提升主版本并同步 `coreCompatibility`。
- 六个模块中 Pages 为 `0.1.0`，其余五个为 `0.2.0`，`coreCompatibility` 均为 `^1.0.0`；`coreCompatibility` 目前只做**格式**校验，没有核心版本号与真实比对逻辑。
- 持久化状态文件 `formatVersion: 1`；版本不支持或文件损坏时拒绝启动，不静默重建。

## 如何验证本文档

本文命令于 2026-10-25 在本机复跑。命令与仓库文件对应关系：

| 命令 | 对应文件 |
| --- | --- |
| `node tools/test-all.js` | `tests/`、`modules/*/tests/` |
| `node --test tests/contracts/*.test.js` | `tests/contracts/` |
| `node --test modules/<id>/tests/*.test.js` | `modules/<id>/tests/` |
| `node modules/<id>/server/dev.js --once` | `modules/<id>/server/dev.js` |
| `node deploy/validate-presets.js --matrix` | `deploy/validate-presets.js` |
| `./tools/merge-ownership.sh --check` | `tools/merge-ownership.sh` |
| `./tools/verify-no-change.sh` | `tools/verify-no-change.sh` |
| 内联 `node -e '...'` | `core/config`、`core/server`、`core/registry`、`core/storage` |

## 已知缺口清单

来源：`docs/P1-status.md` §4（P1/M1a 与 P2/M1b 进展报告）、`docs/m0/M0-report.md`（M0 汇总报告）与 [`release-checklist.md`](release-checklist.md)。「状态」列按 2026-10-25 核对的当前实现更新；关闭项必须给出可复跑的测试或工具命令，未关闭项不得在发布说明中省略。

| ID | 缺口 | 状态 | 影响 | 来源 |
| --- | --- | --- | --- | --- |
| K1 | 身份存储只有内存实现 | **已关闭**：`database.engine=mongodb` 时用户、会话与验证码写 MongoDB（`identity_sessions` 带 TTL）；`state/identity.json` 只是启动与每次变更后重写的导出快照。内存实现仅用于默认开发模式 | — | `tests/integration/identity-mongodb.test.js`、`tests/contracts/persistence.test.js` |
| K2 | 持久化存储注册表未接入核心 HTTP 入口 | **已关闭**：MongoDB 引擎下区域、修订与变更事件写入 `storage_regions` / `storage_file_revisions` / `storage_file_events`（`core/storage/mongo-metadata.js`）；文件版 `PersistentStorageRegistry` 保留作离线导入导出。备份工具仍不能直接转储 MongoDB 集合 | 备份包需运维另放数据库转储 | `tests/integration/core-boot.test.js`、`docs/guides/backup-restore.md` |
| K3 | 六个业务模块只有骨架 | **已关闭**（P3：清单、入口、路由、配置 schema、185 个模块用例落地） | — | P1-status §4 |
| K4 | 六模块后台业务页面未完成 | **已关闭**（C29：统一后台外壳与六模块管理贡献已接入，含启停、配置与故障视图） | — | C29 |
| K5 | 无安装器与真实编排验证（G03 未完成） | **部分**：安装器 `tools/init.js` 与 Compose 预设同源；真实启动、升级、备份、恢复、停用/启用、卸载与重装演练已在 `tests/integration/deploy-acceptance.test.js` 通过（需 `PAGESAI_MONGO_TEST=1`，Mongo 门禁 3/3）；容器镜像构建因宿主机无容器运行时未验证 | 进程级按模块部署已验证，容器编排未验证 | C30–C33 |
| K6 | 配额与用量统计未实现（C04 未开工） | **部分**（Disk 有单盘配额，其他模块只有硬上限；统一用量统计未实现） | 无法统一执行容量约束 | P1-status §4 |
| K7 | 无根 `LICENSE`、无 `THIRD_PARTY_NOTICES`（决策 D1） | **部分**：`THIRD_PARTY_NOTICES.md` 与 `docs/licenses/dependency-licenses.md` 已建立；根 `LICENSE` 待负责人决策；PDF.js/KaTeX 未随包分发，登记为「待补」 | 公开推送即「保留所有权利」 | C35、M0-report §1 D1 |
| K8 | Glim 五连接未实现 | **已关闭**：pages/disk/mail/survey/paper 五个 HTTP 连接器落地，授权、撤销、能力发现与调用均有测试；`implemented` 由适配器能力决定 | — | `modules/glim/connectors/`、`modules/glim/tests/connectors.test.js` |
| K9 | Disk 客户端无真正同步引擎（10 项差距；本机缺签名材料） | **部分**：双向同步引擎与 Tauri 壳已实现；安装包签名与真实设备验收仍缺材料 | 不满足真实双向同步验收 | M0-report §3.3 |
| K10 | Disk 服务端无 `package.json` 与锁文件（B3） | **已关闭**（新模块零第三方依赖，不需要清单） | — | M0-report §3.4 B3 |
| K11 | Glim 无 Python 锁文件（V17） | **不再适用**（公开版 Glim 改为 Node 模块，无 Python 依赖） | — | M0-report §6 |
| K12 | 私有 `node24-base` 镜像、沙盒镜像未锁 digest | **未关闭（外部阻塞）**：宿主机无 docker/podman/nerdctl/colima，镜像从未构建或拉取；`contracts/runtime-topology.json` 记录 `blocked-no-container-runtime-on-host`，预设使用 `:local` 标签 | 干净环境无法复现镜像 | C36、`contracts/runtime-topology.json` |
| K13 | 数据根硬编码与同根冲突（`/data/disk-archive` 20 处；survey 与 disk 同根） | **部分**：Survey 已改为跟随 `dataFile` 同级目录；基线硬编码未被导出，但未修 | 旧环境仍有改配置不生效风险 | M0-report §9.3 W1/W2 |
| K14 | `fileId`/`baseRevision` 全仓 0 命中；Paper 存绝对路径（W4） | **部分**：Disk 已实现稳定 `fileId` + 修订；与核心变更日志仍未联动 | 跨模块同步与对账仍缺统一标识 | M0-report §9.3 W4 |
| K15 | 启动即无条件运行后台任务（W3） | **已关闭**（模块只在 `start()` 时启动，未启用不运行） | — | M0-report §9.3 W3 |
| K16 | 环境变量未声明（B6）、内网/Tailscale 硬编码（B4）、固定 owner 特权（B5） | **部分**：核心变量已文档化；旧源码的校园/IP/owner 逻辑未导出但未清理 | 公开包仍需最终扫描 | M0-report §3.4 |
| K17 | 微信个人号通道去留未决（决策 D2） | **未关闭**（公开版未包含该通道，待负责人确认排除） | Glim 依赖与镜像范围仍需拍板 | M0-report §1 D2 |
| K18 | 旧核心入口 16 处 require 直指不导出模块（决策 D3） | **未关闭**（旧入口未导出，B02 白名单未收尾） | 不解耦则公开包带出私有模块 | M0-report §1 D3 |
| K19 | 公开仓库发布流程、许可证与声明未完成 | **部分**：CI 与人工审批 Release、可复现制品与发布门禁已落地；根 `LICENSE` 待决策，`THIRD_PARTY_NOTICES` 仍有「待补」条目 | 不得宣称可发布 | C34–C38、M0-report §6 |

### 施工期观察（不属于上述来源，但影响交付判断）

- 2026-10-25 复核：`node tools/test-all.js` 51 个文件、298 例、284 通过、14 跳过、0 失败；其中契约 57、集成 56、模块 185（179 通过 / 6 跳过）。Mongo 门禁另跑 124/124；Disk 同步引擎 `cargo test --locked` 24/24。
- `node tools/verify-release.js` 仍为 exit 1：阻断仅剩根 `LICENSE` 与 `docs/m0/**` 中的内网地址/本机路径（`--exclude docs/m0` 后为 1 阻断、8 警告、8 通过）。`docs/m0/**` 不在导出白名单内，但留在仓库中仍需负责人决定去留或脱敏。
- `node tools/check-imports.js` 0 违规（227 个文件）；`node deploy/validate-presets.js` PASS（12 个预设、64 种组合）；`./tools/verify-no-change.sh` exit 0（1,315 个文件，11 个已登记外部变更）；`./tools/merge-ownership.sh --check` 1,313 个文件通过；`node tools/export-public.js --out /tmp/pagesai-export --dry-run` 实际 670 个文件。
- 仍未关闭的外部条件：宿主机无容器运行时导致镜像无法构建、`TAG-TODO-DIGEST` 保留为 `:local`；cargo/资产/项目三类许可证条目待确认；真实设备同步、代码签名/公证与校园链路验收缺材料；`SECURITY.md` 的报告渠道仍为占位。

## 相关文件

- 根说明：[`README.md`](../README.md)（定位、目录规范、硬性排除项）
- 契约：[`contracts/README.md`](../contracts/README.md)
- 证据与审计：[`docs/m0/README.md`](m0/README.md)
- 部署预设：[`deploy/README.md`](../deploy/README.md)
- 校验工具：[`tools/verify-no-change.sh`](../tools/verify-no-change.sh)、[`tools/merge-ownership.sh`](../tools/merge-ownership.sh)