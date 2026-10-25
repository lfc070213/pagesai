# P3–P7 历史进展报告（完成口径已撤销）

> **2026-10-24 状态纠偏：** 本文只记录当时产出的原型、工具与历史测试，不再表示“公开版全套交付”。当前结论、门禁证据与任务映射以 [`release-checklist.md`](release-checklist.md) 为准，施工前审查口径见 [`continuation-baseline.md`](continuation-baseline.md)；下列“已交付”均应理解为“已有可复用实现”，逐步由后续施工补齐。

- 首次报告：2026-10-23；当前快照：2026-10-25
- 基线：`dev-environment@a8af402bba75`
- 当前测试：**298 例 / 284 通过 / 14 跳过 / 0 失败**，51 个测试文件（`node tools/test-all.js` → exit 0）；Mongo 门禁 124/124；Disk 同步引擎 `cargo test --locked` 24/24
- 导出可复现：`node tools/export-public.js` 实际 **670 个文件**，`inventoryHash` 一致
  （`59928caf80a9bf6d230abd65f3a3d9ff839250bd4acc91ee2f51ffb2368888c5`）
- 发布检查：`node tools/verify-release.js` → **exit 1（不可发布）**，阻断仅剩根 `LICENSE` 与 `docs/m0/**` 内网地址/本机路径

## 1. 已交付

| 阶段 | 交付 | 证据 |
| --- | --- | --- |
| P1 收尾 | B02 白名单导出（映射表/硬排除/哈希清单）、B03 导入闭包检查 | `tools/export-public.js`、`tools/check-imports.js`（当前 0 违规）、`tests/contracts/imports.test.js` 8/8 |
| P3 六模块 | Pages / Disk / Glim / Mail / Survey / Paper 各自 manifest + 独立 server + dev 启动脚本 + 模块内测试 + 网页端 | `modules/*/manifest.json`、`modules/*/server/index.js`、`modules/*/web/`；模块测试 **29 个文件 / 185 例（179 通过 / 6 跳过 / 0 失败）** |
| P4 同步 | Rust 双向同步引擎与 Tauri 客户端壳（协议、冲突处理、断点续传、设备配对） | `modules/disk/sync/`（`cargo test --locked` 24/24）、`modules/disk/client/`；签名安装包与真机验收待外部材料 |
| P5 五连接 | Glim 对 pages / disk / mail / survey / paper 的 HTTP 连接器（登记、授权、撤销、能力发现、调用） | `modules/glim/connectors/{index,pages,disk,mail,survey,paper,http}.js`；`modules/glim/tests/connectors.test.js` |
| 核心装配 | 公共核心按已启用模块动态挂载路由、后台启停接口、后台静态外壳 | `core/registry/host.js#allRoutes`、`core/server.js` 的模块分发；`tests/integration/module-mount.test.js` 4/4 |
| P6 后台 | 单层管理员后台外壳（账号/模块状态/诊断，按安装清单装配，无二级管理员），六个模块各自提供管理贡献 | `admin/index.html`、`admin/admin.js`、`admin/admin.css`、`modules/*/server/admin.js` |
| P6 部署 | 12 个 Compose 预设（core-only、六单装、组合、通用版、北大版）+ 校验器 | `deploy/presets/*.yml`、`deploy/validate-presets.js` → 12/12、64 组合、PASS |
| P6 运维 | 安装/升级/备份/恢复/卸载工具 + 配置样例 | `tools/{init,upgrade,backup,restore,uninstall}.js`、`config/example.env`、`config/config.schema.json` |
| P7 文档 | 总览、快速开始、安装/升级/备份/安全/排障、六模块文档、架构 | `docs/README.md`、`docs/guides/*.md`、`docs/modules/*.md`、`docs/architecture.md` |
| P7 合规 | 许可证决策单（不代选）、第三方声明、安全策略、贡献规范、变更日志、发布清单 | `LICENSE-DECISION.md`、`THIRD_PARTY_NOTICES.md`、`SECURITY.md`、`CONTRIBUTING.md`、`CHANGELOG.md`、`docs/release-checklist.md`、`tools/verify-release.js` |
| P7 CI | CI 与发布流水线、测试聚合器、发布清单生成器 | `.github/workflows/{ci,release}.yml`、`tools/test-all.js`、`tools/release-manifest.js`、`docs/ci.md` |

## 2. 发布阻断项（`verify-release` 实测 + 发布前置人工项，必须由人或外部资源关闭）

| # | 阻断 | 现状 | 关闭条件 |
| --- | --- | --- | --- |
| 1 | **根 LICENSE 缺失** | 未选许可证（D1）；`verify-release` 仅此项与 #2 报错 | 负责人选定 → 写入 `LICENSE` 并按 `LICENSE-DECISION.md` 同步 |
| 2 | `docs/m0/**` 含私网地址与本机路径 | 已从公开包排除（`config/public-bundle-policy.json` deny + `.gitattributes export-ignore`）；仓库内仍保留作审计证据；`verify-release --exclude docs/m0` 通过 | 发布物不包含 `docs/m0`（已满足）；如需公开仓库本身干净，需脱敏或移出 |
| 3 | 预设镜像未锁 digest | 12 个预设使用 `pagesai/app:local`、`pagesai/gateway:local` 与 `mongo:7`；宿主机无容器运行时，镜像从未构建或拉取，`contracts/runtime-topology.json` 记录 `blocked-no-container-runtime-on-host` | 在可用构建区构建/拉取后 `docker inspect` 取 digest 回填 |
| 4 | 依赖逐包许可未采集完整 | `docs/licenses/dependency-licenses.{json,md}` 已生成，npm 已确认，cargo 与随包静态资源待确认 | 在独立构建区完成 cargo/asset 许可采集并刷新清单 |
| 5 | 真实密钥/历史泄露未扫全历史 | 内置规则已扫全部提交（C37），常见密钥前缀与带凭据 URI 均 0 命中；未装 gitleaks/trufflehog | 在构建区补跑专用工具做交叉验证 |
| 6 | 安全披露渠道为占位（非 verify-release 检查项） | `SECURITY.md` 的 GitHub Security Advisories 未启用（仓库未创建）、安全邮箱待填 | 负责人落实渠道与时限后移除「占位/待填」标记 |

## 3. 必须外部资源才能完成（不做「假装完成」）

| 项 | 为什么本机做不到 | 交付现状 |
| --- | --- | --- |
| P4 Windows/macOS 真机验收 | 无 Windows 机器、无签名证书 | 同步协议与客户端设计文档、E04–E08 待执行清单已登记 |
| P4 北大校内/校外链路验收 | 无真实校园网络条件 | 通用/北大差异收敛为 `DISK_NETWORK_POLICY` 单一开关；真实链路验证标「未完成」 |
| D1 许可证 | 负责人商业决策 | 决策单已写（候选与影响），不代选 |
| D2 微信通道 | 负责人产品决策 | 默认不导出，待决策 |
| D3 核心入口解耦范围 | 负责人范围决策 | 混装证据与 16 处 require 清单已在 M0 文档 |

## 4. 复跑方式

```bash
cd source/site/public-release/pagesai

node tools/test-all.js                       # 51 个文件 / 298 例（284 通过、14 跳过、0 失败），exit 0
node tools/check-imports.js --root .         # 导入闭包，exit 0（0 违规 / 227 文件）
node tools/export-public.js --out /tmp/exp   # 可复现导出（670 文件）
node deploy/validate-presets.js              # 12 预设 / 64 组合
node tools/verify-release.js                 # 发布门禁（当前 exit 1，仅根 LICENSE 与 docs/m0）
./tools/verify-no-change.sh                  # 既有 site 源码零改动
./tools/merge-ownership.sh --check           # 1313 文件归属表完整
```

## 5. 回退方法

本阶段全部为新增文件（`core/`、`modules/`、`admin/`、`deploy/`、`config/`、`tools/`、`docs/`、`tests/`、`.github/`），未改动既有 `source/site/` 实现；回退 = 回退对应提交。`verify-no-change.sh` 当前 exit 0（1,315 个文件；11 个既有外部变更已登记在 `docs/m0/allowed-external-changes.txt`），可证明既有源码未被本阶段触碰。