本项目第一方源码按根 [LICENSE](LICENSE) 的 MIT 授权；以下第三方组件保留各自许可。

# 第三方组件声明（THIRD_PARTY_NOTICES）

- 适用范围：PagesAI 公开版（`source/site/public-release/pagesai/`）的分发物。
- 维护规则：**只登记真正随分发物一起提供的内容**。尚未落盘的依赖一律标"待补"，并写清关闭条件；不允许用"将来会有"的条目冒充已覆盖。
- 与根许可的关系：本仓库源码的许可由根 `LICENSE` 决定（候选与决策流程见 `LICENSE-DECISION.md`）。**下列第三方组件按各自许可分发，不因本仓源码许可而改变。**
- 判定口径：本文件被 `tools/verify-release.js` 的 `third-party-notices` 检查引用（要求覆盖 PDF.js / Apache-2.0 / KaTeX / MIT / Node / Python / Rust）。

## 1. 随仓库分发的第三方代码（vendored）

这类内容会**原样进入发布物**，许可文本必须随发布物一起提供，不能只写"见上游"。

| 组件 | 许可 | 版权行（上游声明） | 计划落盘路径 | 状态 |
| --- | --- | --- | --- | --- |
| **PDF.js**（Mozilla） | **Apache-2.0** | `Copyright 2024 Mozilla Foundation`（见上游文件头） | `modules/paper/server/assets/pdf.min.mjs`、`pdf.legacy.min.mjs`、`pdf.worker.min.mjs`、`pdf.worker.legacy.min.mjs` | **待补**：目录尚未落盘，`assets/` 目前不存在 |
| **KaTeX** | **MIT** | `Copyright (c) 2013-2020 Khan Academy and other contributors` | 依据实现形态二选一：① npm 依赖（`modules/glim/web`、Paper 前端）→ 走 §2 的依赖清单；② vendored 到 `modules/paper/web/vendor/katex/` → 需同时带 `LICENSE` | **待补**：当前树内无任何 KaTeX 副本（旧树的 60 个字体文件在不导出的个人站点目录） |
| 图标 / 插画 / 截图 / 示例数据 | 视来源而定 | — | 尚未登记任何素材 | **待补**：当前为 0 条，新增素材必须在此登记来源与授权 |

### 1.1 PDF.js 的落地检查清单（落盘时必须一次做完）

1. 保留每个 `.mjs` 文件头部的 Apache-2.0 许可声明（不得压缩后抹掉）。
2. 在发布物内提供 Apache-2.0 **完整正文**，建议放 `modules/paper/server/assets/LICENSE-Apache-2.0.txt`。
3. 若上游随附 `NOTICE` 文件，必须一并转发（Apache-2.0 §4(d)）。
4. 若对 PDF.js 做过任何修改，需在修改过的文件内加"修改声明"。
5. 同步更新本文件 §1 的状态列，并把 `docs/release-checklist.md` 中 B2 从 open 改为 closed。

> 现在 Paper 的 PDF 解析只依赖自研 `extract.js`，**没有** vendored PDF.js；因此本行只能是"待补"，任何"NOTICE 已覆盖 PDF.js"的说法在文件落盘前都不成立。

## 2. Node 依赖类目

| 子类 | 内容 | 是否需要声明 | 当前状态 |
| --- | --- | --- | --- |
| Node.js 内置模块 | `node:fs`、`node:http`、`node:crypto`、`node:path`、`node:test` 等 | **不需要**（随 Node 运行时提供，不随本仓分发） | 已确认：`core/`、`tools/`、`tests/` 全部只用内置模块与相对路径 |
| 第三方 npm 包（直接依赖） | 目前 **0 个**：公开版没有根 `package.json`，各模块目录也没有 | 需要（MIT/ISC/Apache 等都要保留声明） | **待补**：模块落盘建立 `package.json` 后必须登记 |
| 第三方 npm 包（传递依赖） | 随直接依赖引入 | 需要（由工具生成清单） | **待补**：由 §6 的命令在独立构建区生成 |
| 前端构建产物 | Vite/Tauri 等构建工具 | 构建工具不进发布物；其运行时依赖按产物清单登记 | **待补**（前端尚未落盘） |

> 说明：`docs/guides/install.md` 里写的 `npm install`/`pnpm` 步骤属于**未来模块落盘后**的安装方式；当前公开版核心不需要任何 npm 安装，这一点是刻意的（`docs/guides/security.md` §2 "零第三方依赖"）。

## 3. Python 依赖类目

| 组件/来源 | 许可（待核实） | 现状 | 备注 |
| --- | --- | --- | --- |
| Glim 服务端依赖（`requirements.txt`） | 逐包待采集 | **待补**：文件未落盘（旧树 18 个包） | 必须带锁文件或哈希；`pip-licenses` 采集后登记 |
| Glim 沙盒依赖（`requirements-dev`/沙盒镜像） | 逐包待采集 | **待补**（旧树 10 个包） | 沙盒镜像 digest 必须固定 |
| Python 运行时本身 | PSF License | 不随仓分发（由用户环境/镜像提供） | 若分发自带运行时的镜像，需在 §5 登记 |
| **微信个人号协议的非官方 SDK** | 未核实 | **禁止进入公开版** | 见 `docs/m0/A05-license-sensitive.md` §1.4 与决策 D2；许可与合规性双未核实 |

> Python 侧是当前许可风险最不透明的一块：既没有 `requirements.txt` 落盘，也没有逐包许可采集。任何"Glim 可发布"的结论都必须等这一行从"待补"变成"已采集且无 GPL-2.0-only/未知许可"。

## 4. Rust 依赖类目（Disk 客户端）

| 项 | 内容 | 状态 |
| --- | --- | --- |
| 客户端框架 | Tauri v2（MIT/Apache-2.0 双许可） | **待补**：`modules/disk/client/` 仅有 `.gitkeep` |
| crate 依赖 | 旧树 `Cargo.lock` 有 **574** 个 crate（A05 §1.6） | **待补**：按 `cargo deny check licenses` 生成清单后逐条登记 |
| 允许/拒绝清单 | 需 `deny.toml` 显式列出允许的许可家族 | **待补**：不存在 |
| 打包产物 | 安装包内必须附本文件与 `LICENSE` | **待补**：无安装包 |

## 5. 容器镜像与运行时（编排引用，不随仓库分发）

`deploy/presets/*.yml` 只**引用**镜像名（当前为 `pagesai/app:local`、`pagesai/gateway:local` 与 `mongo:7`），镜像本身不进仓库。这一点必须在发布说明中讲清楚，否则会被理解为"我们分发了 MongoDB"。

| 镜像/运行时 | 许可 | 影响 | 状态 |
| --- | --- | --- | --- |
| `mongo`（MongoDB 7） | **SSPL-1.0**（非 OSI 认可） | 若把 MongoDB 作为托管服务对外提供，SSPL 要求提供"服务源码"；自用部署无此义务 | **待负责人确认**：商业托管形态下是否接受 |
| `python:3.12-slim`（沙盒基础镜像） | PSF + Debian 各包许可 | 分发镜像需附许可清单 | **待补**：digest 需固定（宿主机无容器运行时） |
| `ubuntu:24.04`（旧沙盒基础镜像） | Ubuntu 基础镜像条款 + Canonical 商标政策 | 若导出沙盒需单独声明 | **待负责人确认**：是否导出该沙盒 |
| Node 24 运行时 | Node.js License（MIT 类） | 分发自带运行时的镜像需附许可 | **待补**：私有 `node24-base` 镜像不可用于公开构建（A02）；本机未构建镜像 |

## 6. 待补项汇总（关闭条件逐条可执行）

| ID | 类目 | 待补内容 | 负责人 | 关闭条件（可复跑） | 是否阻断发布 |
| --- | --- | --- | --- | --- | --- |
| N1 | vendored | PDF.js 4 个 `.mjs` + Apache-2.0 正文 | Paper 负责人 | `ls modules/paper/server/assets/pdf*.mjs` 有 4 个文件，且许可正文存在 | **是**（B2） |
| N2 | vendored | KaTeX 许可与形态确认 | 前端负责人 | 二选一落地，并在 §1/§2 互相引用 | 是（若采用 vendored） |
| N3 | npm | 逐包许可清单（直接 + 传递） | 各模块负责人 | 已生成 `docs/licenses/dependency-licenses.{json,md}`（npm 全部确认）；剩余条目在认证构建区补齐 | 是（有依赖时） |
| N4 | Python | `pip-licenses --format=csv --with-urls` 归档，无 GPL-2.0-only/未知 | Glim 负责人 | 公开版 Glim 为 Node 模块；仅当沙盒导出 Python 时才需要 | 是（导出沙盒时） |
| N5 | Rust | `cargo deny check licenses` 通过 + `deny.toml` | Disk 客户端负责人 | 命令 exit 0；当前许可清单中 cargo 条目仍待确认 | 是（客户端发布时） |
| N6 | 镜像 | 全部 digest 固定（替换 `:local` 标签） | 部署负责人 | `grep -rn ':local' deploy/presets/` 命中 0；当前宿主机无容器运行时，无法生成 digest | 是 |
| N7 | 素材 | 图标/截图/示例数据来源台账 | 文档负责人 | 本文件 §1 第三行有登记 | 否（当前为 0 条） |
| N8 | 商标 | 名称与 Logo 使用政策 | 负责人 | `TRADEMARK.md` 存在（若 Q8 回答"需要"） | 否 |

## 7. 生成与复核命令（全部只读、只用 Node 内置模块）

```bash
cd source/site/public-release/pagesai

# 1) 现存 vendored 资产（预期现在为空；落盘后应能列出 PDF.js/KaTeX）
find . -path ./.git -prune -o -type f \( -name 'pdf*.mjs' -o -name '*worker*.mjs' -o -name 'katex*' \) -print

# 2) 第三方 require 扫描（预期只出现 node: 内置模块）
grep -rhoE "require\('[^.][^']*'\)" --include=*.js . | sort -u

# 3) 本文件必须覆盖的类目（verify-release 会逐项检查）
for k in PDF.js Apache-2.0 KaTeX MIT Node Python Rust; do grep -q "$k" THIRD_PARTY_NOTICES.md && echo "OK  $k" || echo "MISS $k"; done

# 4) 发布证明自检（含本文件覆盖检查）
node tools/verify-release.js; echo "exit=$?"
```

在**独立构建区**（不在本机、不装依赖到本仓库）执行的许可采集命令：

```bash
# npm（模块落盘后）
pnpm licenses list --prod > licenses-npm.txt

# Python（Glim 落盘后）
pip-licenses --format=csv --with-urls > licenses-python.csv

# Rust（客户端落盘后）
cd modules/disk/client/src-tauri && cargo deny check licenses
```

> 本机纪律禁止安装依赖，因此上面三条本轮**没有执行**，N3–N5 只能标"待补"。执行后请把输出归档位置写进 `docs/release-checklist.md` 的 M6 行。
