# PagesAI 公开版 · 权威源码区

本目录是 **PagesAI 公开版** 的唯一权威源码区（下称"公开版"）。

- 状态：**公开版续建中**。当前是原型与工具框架，不是六模块完整产品，也未达到发布条件。
- 当前审查基线：共享仓库 `dev-environment@0c217cb454cc25e7f5df0bd2a2719d6150f0eead`；原始保护基线仍为 `a8af402bba75`。
- 当前事实源：[`docs/continuation-baseline.md`](docs/continuation-baseline.md)。2026-10-23 的 P3–P7 文档只保留历史证据，不再作为完成度结论。
- 关系：公开版代码在此**新增**并维护；现有 `source/site/` 各产品目录保持原样，只做**只读抽取**，不搬迁、不重排、不删除。

## 定位

交付一个公开仓库，包含公共核心（最低运行基础，不算业务模块）和六个可独立安装、独立使用的业务模块：

| 模块 | 目录 | 目标 |
| --- | --- | --- |
| Pages | `modules/pages/` | AI 创建、修改、预览、发布网页；文件管理、执行隔离、已有后端托管 |
| Disk | `modules/disk/` | 一个逻辑盘；网页端 + Windows/macOS 客户端真实文件同步 |
| Glim | `modules/glim/` | 可单独使用的智能体；可选连接 Pages/Disk/Mail/Survey/Paper |
| Mail | `modules/mail/` | 发信（验证码/通知）+ 完整邮箱客户端能力 |
| Survey | `modules/survey/` | 自有简易问卷：创建、发布、填写、答卷管理、基础统计 |
| Paper | `modules/paper/` | 论文上传、阅读、翻译、对齐、AI 问答 |

公共核心（`core/`）只保留身份、权限、配置、模块目录与存储契约，保持小而稳定。

## 目录规范

```text
pagesai/
  README.md  LICENSE  THIRD_PARTY_NOTICES.md  SECURITY.md  CONTRIBUTING.md  CHANGELOG.md
  core/        身份、权限、配置、模块目录、存储契约
  modules/     六模块（server / web / client / worker / connectors ...）
  admin/       统一后台外壳、基础管理、模块页面装配
  contracts/   API schema、模块/存储/连接/同步协议
  deploy/      基础编排与模块组件（presets/：disk-generic、disk-pku、独立与组合示例）
  config/      非敏感示例与配置 schema
  tools/       初始化、诊断、迁移、构建、导出
  tests/       契约、单元、集成、端到端
  docs/        总指南与六模块文档（m0/：审计与基线证据）
  .github/workflows/  持续集成与发布
```

## 施工规程

共享源码仓库遵守现有 `AGENTS.md` 闭环：

```bash
cd ~/cx/dev-environment && ./scripts/dev.sh start          # 施工前同步与安全检查
cd ~/cx/dev-environment && ./scripts/dev.sh finish "说明" <明确路径...>   # 提交、推送、远端校验、技能镜像
```

禁止直接 `git commit` / `git push`、禁止 `git add -A`、禁止 `--no-verify` 绕过门禁。公开仓库的发布流程另建，开发仓库的 `finish` 不等于已发布公开仓库。

## 硬性排除项

公开包不得包含：`node_modules`、虚拟环境、数据库、上传文件、Maildir、个人站点、日志、备份、真实密钥/签名私钥、真实账号、校园内部地址清单、旧私人网关，以及 Jupyter（方案中的"7"）相关文件。

## 验收重心

可独立部署、数据一致、不影响现有环境。六个业务模块都能单独安装使用，也能按需组合；Disk 单盘且含真实客户端同步，通用版/北大版共用数据面。

详细施工与验收要求见方案原件：`~/Documents/Codex/2026-10-22/wo/outputs/PagesAI-公开版完整施工方案.md`。
## 许可证

本项目第一方源码和客户端使用 [MIT License](LICENSE)，Copyright (c) 2026 lfc070213。第三方组件保留各自许可，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
