# 变更记录（CHANGELOG）

本文件记录 **PagesAI 公开版**（`source/site/public-release/pagesai/`）的变更。

- 版本方案：[语义化版本](https://semver.org/lang/zh-CN/)；当前产品版本 `0.1.0`（`tools/init.js` 的 `PRODUCT_VERSION`）。
- 记录方式：按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的分类归纳；每条尽量对应到提交或证据路径。
- **当前状态：未发布。** 本文件里的 `[未发布]` 段只说明"仓库里已经有什么"，不构成可发布声明；放行条件见 `docs/release-checklist.md`。
- 归纳来源：

  ```bash
  cd ~/cx/dev-environment
  git log --oneline --date=short --format='%h %ad %s' -- source/site/public-release
  git status --porcelain --untracked-files=all -- source/site/public-release
  ```

## [未发布] 0.1.0 — 2026-10-23

### 概览

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M0 / P0 | 基线、范围、依赖图、写入图、客户端差距、许可与敏感信息审计 | 审计完成，阻断项未清零 |
| M1a / P1 | 新增权威源码区、最小核心、身份与单层管理员、模块契约 | 代码完成，测试快照未全绿 |
| M1b / P2 | 存储区域、文件变更协议、幂等与持久化 | 代码完成，未接入 HTTP 入口 |
| M2 / P3 | 六模块独立运行 | **未完成** |
| M3 / P4 | 单盘双版本与客户端同步 | **未完成** |
| M4 / P5 | Glim 五连接 | **未完成** |
| M5 / P6 | 后台、安装升级、组合验证 | **未完成** |
| M6 / P7 | 文档、许可、发布证明 | **未完成**（本轮新增许可决策、第三方声明、安全政策、贡献流程与本变更记录） |

### 新增（已提交）

- **公开版权威源码区与目录规范**（`8d65b3a`，78 个文件）：`core/`、`modules/`、`admin/`、`contracts/`、`deploy/`、`config/`、`tools/`、`tests/`、`docs/` 骨架；`tools/verify-no-change.sh`（基线不变验证，6 项检查）。
- **M0 审计证据六件套**（`4c8cadd`，55 个文件，+7223 行）：
  - `docs/m0/A01-scope-baseline.md`（基线、范围冻结、目录级归属）
  - `docs/m0/A02-dependency-graph.md`（模块级依赖、外部服务 21 类、V1–V18 待验证）
  - `docs/m0/A03-data-roots-writes.md`（数据根、写入入口、W1–W5 高危写入面）
  - `docs/m0/A04-client-sync-gap.md`（客户端 10 项差距）
  - `docs/m0/A05-license-sensitive.md`（许可矩阵、敏感信息扫描、B1–B8 阻断项）
  - `docs/m0/M0-report.md`（汇总、D1–D3 决策项、放行判断）
- **逐文件归属表**：`docs/m0/ownership/ownership-map.tsv`（1,313 行、8 列、无重复）+ 40 个分片 + `summary.md`，由 `tools/merge-ownership.sh` 合并校验。
- **对抗复核**：`docs/m0/checks/XCHECK-A02A03.md`、`XCHECK-A04A05.md`（高影响断言独立取证，含 1 条推翻、1 条部分推翻后的回写）。
- **契约 schema**：`contracts/module-manifest.schema.json`、`storage-region.schema.json`、`file-change.schema.json`，与 `contracts/README.md` 的冻结规则。
- **公共核心**（`ad66234`，18 个文件，+2138 行）：
  - 配置：`core/config/index.js`、`config/config.schema.json`（部署配置的唯一结构，秘密只存引用）
  - 身份：`core/identity/{passwords,store,service}.js`（scrypt 口令、会话撤销、单层管理员、最后管理员保护、简单注册、引导令牌）
  - 模块：`core/registry/{manifest,host}.js`（清单校验、按需加载、生命周期、能力过滤）
  - 存储：`core/storage/registry.js`（区域登记、路径越界拒绝、幂等变更、修订冲突、游标、墓碑）
  - 契约校验：`core/contracts/validate.js`（零依赖 JSON Schema 子集）
  - 测试：契约 + 集成共 32 项（提交信息口径）
- **存储持久化**（`d3d37ed`，3 个文件，+189 行）：`core/storage/persistence.js`，区域与变更日志跨重启保留、原子替换写、权限 `0600`、损坏拒绝启动；测试增至 37 项（提交信息口径）。

### 变更

- 既有 `source/site/` 源码保持只读：`tools/verify-no-change.sh` 用"基线文件零改动 + 顶层目录集合不变 + 既有文件计数不变 + 无禁止制品 + 部署入口零接触"五项来证明（`8d65b3a`、`4c8cadd`）。
- 白名单外部变更单独登记：`docs/m0/allowed-external-changes.txt`（Nexus 实时图 1s→10s 修复，与公开版施工无关）。

### 修复

- 本轮无面向用户的功能修复；审计阶段的订正记录（计数口径、掩码、行号）写在 `docs/m0/A05-license-sensitive.md` §8.3 与 `docs/m0/M0-report.md` §9.2。

### 文档

- `README.md`（公开版定位、目录规范、硬性排除项）、`docs/P1-status.md`（P1/P2 进展与已知缺口）。
- 本轮新增：`LICENSE-DECISION.md`（三候选影响与决策问题）、`THIRD_PARTY_NOTICES.md`（第三方组件台账）、`SECURITY.md`（披露渠道、支持版本、五条安全不变量）、`CONTRIBUTING.md`（契约变更与外部贡献回收）、`CHANGELOG.md`（本文件）、`docs/release-checklist.md`（M0–M6 放行条件与证据）。
- 本轮新增工具：`tools/verify-release.js`（发布物证明自检：根 `LICENSE`、第三方声明、禁用制品、迁移台账、地址与密钥扫描）。

### 安全

- 审计结论：当前快照**未发现真实密钥/私钥**；字面密钥赋值仅存在于测试夹具（A05 §2.2）。
- 已实现的安全控制：scrypt 口令、会话令牌只存摘要、`HttpOnly` Cookie、`authVersion` 撤销、最后管理员保护、路径越界拒绝、变更幂等、状态文件 `0600` + 原子写、`64 KB` 请求体上限、未安装模块无路由。
- 未清零的发布阻断：无根 `LICENSE`（B1）、无第三方声明承接（B2，本轮建文件但 PDF.js 未落盘）、内网/Tailnet 地址仍存在于审计文档与旧路径清单（B4/B8）、固定 owner 与未声明环境变量（B5/B6）、核心入口混装不导出模块（B7）、Disk 服务端无依赖清单（B3）。
- 处置顺序已写入 `SECURITY.md` §5：先撤销/轮换，再清理历史。

### 未提交（工作区快照，2026-10-23 11:15 +08:00）

以下内容**已落盘但尚未提交**，因此不属于任何发布版本；列出来是为了避免"仓库里看不到就以为不存在"：

| 区域 | 内容 |
| --- | --- |
| `core/` | `core/storage/json-store.js` 新增；`core/server.js`、`core/registry/host.js` 修改 |
| `modules/` | 六个模块的 `manifest.json`、`config.schema.json`、`server/index.js`（Paper 另含 `service.js`/`extract.js`/`segment.js`/`adapters.js`/`codes.js`）、模块级测试 |
| `config/` | `config/config.schema.json` |
| `deploy/` | 12 个编排预设（`presets/*.yml`）、`validate-presets.js`、`README.md` |
| `tools/` | `init.js`、`upgrade.js`、`backup.js`、`restore.js`、`check-imports.js`、`export-public.js` |
| `tests/` | `tests/contracts/imports.test.js`、`tests/integration/module-mount.test.js` 更新 |
| `docs/` | `docs/README.md`、`architecture.md`、`export-whitelist.md`、`guides/{install,quickstart,upgrade,backup-restore,security,troubleshooting}.md`、`modules/*.md` |

快照时工作区改动约 80 项（新增 + 修改），`node --test tests/contracts/*.test.js` 为 39/40、`tests/integration/*.test.js` 为 8/9；`deploy/validate-presets.js` 报 FAIL（11 项）。这些数字只代表快照瞬间，重新发布前必须重跑并写进 `docs/release-checklist.md`。

### 已知限制

见 `docs/README.md` 的 K1–K19 与 `docs/P1-status.md` §4，这里只列与"能不能发布"直接相关的：

- K1 身份存储仅内存；K2 持久化注册表未接入 HTTP 入口。
- K3 六个模块尚无独立运行验收；K8 Glim 五连接未实现；K9 客户端无同步引擎。
- K4 后台外壳未实现；K5 安装器与编排生成未完成（预设为静态脚手架，未在真实 Docker 主机验证）。
- K7 根 `LICENSE` 缺失（决策 D1 未做）；K12 私有基础镜像导致干净环境不可复现；K19 发布流程未闭环。

### 升级与迁移说明（0.1.0）

- 尚无公开版本，因此**没有对外升级路径**；内部部署的初始化/升级/备份命令见 `docs/guides/install.md`、`upgrade.md`、`backup-restore.md`。
- 迁移台账（`stateDir/migrations.json`）的格式版本为 1，内置迁移 0001–0005；签名一经发布不得修改（见 `docs/release-checklist.md` 的迁移台账表）。
- 升级工具拒绝隐式换根：已登记区域的数据根变化会被判为不兼容，必须先显式确认。

## 记录约定

1. 每个发布版本必须新增一段，**先写结论再写细节**；不得用"若干修复""性能优化"这类无法核对的表述。
2. 安全修复写在"安全"分类，不写密钥内容与利用细节，只写影响面、修复版本与报告编号。
3. 迁移相关的改动必须注明迁移 ID 与是否幂等；新增迁移要同步 `docs/release-checklist.md` 的迁移台账表（`tools/verify-release.js` 会核对）。
4. 版本号提升规则：新增模块能力 → MINOR；修复与文档 → PATCH；契约不兼容 → MAJOR 并提升 `coreCompatibility`。