# 公开版白名单导出与哈希清单（B02）

- 任务：B02（公开版白名单导出、来源记录与哈希清单）
- 方案依据：§2.3、§12
- 交付物：`tools/export-public.js`、本文件
- 输入：`docs/m0/ownership/ownership-map.tsv`（1,313 行，8 列）
- 旧源码：`source/site/`，**只读**；本工具不写入、不移动、不删除旧树任何文件
- 状态：**工具与本文件完成，自测通过**；34 个「待定」文件的最终处置仍待负责人决策

## 1. 处置口径

### 1.1 三档处置

| 归属表 `disposition` | 行为 | 报告 | 是否写入目标 |
| --- | --- | --- | --- |
| `导出` | 复制到映射后的目标路径，计算 SHA-256 | 计入导出与分组统计 | 是（硬排除命中时除外） |
| `待定` | 不导出 | 逐条列在 dry-run/真实导出报告与 `manifest.json.pending` | 否 |
| `不导出` | 不导出 | 只计入统计，不逐条打印 | 否 |

处理顺序固定为：

1. 读归属表并校验 8 列、路径安全、无重复、处置值合法；
2. 仅对 `导出` 行执行**硬排除**（见 §3）；
3. 按顶部映射表计算 `targetPath`；未命中映射直接判失败，不做猜测；
4. 检查源文件存在、是常规文件、真实路径在源树内；
5. 检查目标路径冲突（同一次导出内 `targetPath` 必须唯一）；
6. 读取文件、计算 SHA-256 与字节数；
7. 全部校验通过后才创建/清空输出目录并写文件，最后写 `manifest.json`。

因此：**校验失败不会留下空输出目录，也不会留下半成品清单。**

### 1.2 归属表优先于目录级初判

M0 报告中的目录级判定是初判；本工具以**逐文件归属表**为准。二者冲突时按归属表执行。例如：

- `uniflourish/server/legal-*` 在 `docs/m0/A01-scope-baseline.md` 的目录级说明中曾列为不导出，但归属表标记为 `导出` 且 `module=core`，本工具按归属表导出；
- `ops/device-client-release/*` 归属表为 `导出`，映射到 `modules/disk/client/release/`。

### 1.3 `sensitive=yes` 不自动排除

归属表的 `sensitive` 口径偏宽（M0 交叉复核已指出抽样 5 条中 3 条为误报）。本工具：

- **不**根据 `sensitive=yes` 过滤文件；
- 在报告和 `counts.sensitiveExported` 中暴露数量；
- 在 `manifest.json.files[].sensitive` 中保留原始 `yes/no/unknown` 三态，供后续人工复核与内容脱敏。

本次实测：670 个实际导出文件中有 **47 个** `sensitive=yes`。其中 `uniflourish/server/legal-documents.js` 含真实联系邮箱；`disk/client/LIGHTWEIGHT_ACCEPTANCE.md` 含真实本机绝对路径但未被标为 sensitive。二者都**尚未脱敏**，属于发布前必须处理的事项（见 §8）。

### 1.4 `writes_files` / `sensitive` 的 `unknown`

归属表中这两个字段存在 `unknown` 值（分别为 4 和 19 行，均在非导出或个别导出文件中）。工具如实保留 `unknown`，不擅自改写为 `no`。

## 2. 目标结构映射

### 2.1 原则

- 映射表是脚本顶部的 `MAPPING_RULES` 常量，按顺序匹配，命中第一条即停止；
- 旧路径全部使用 `/` 分隔，禁止绝对路径、`..`、反斜杠与 NUL；
- 目标路径同样做安全校验，且不得命中硬排除规则；
- 映射后做**冲突检测**：两个旧文件落到同一目标路径即失败，不允许静默覆盖；
- `uniflourish/server` 的旧实现统一进入各模块的 `legacy/` 子目录，作为“可追溯的旧实现暂存区”，不代表最终架构；后续重构应逐文件迁出 `legacy/`，而不是在 `legacy/` 上继续叠加。

### 2.2 映射表（按脚本顺序）

| # | 规则 id | 旧路径匹配 | 目标路径 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | `repo-gitignore` | `^\.gitignore$` | `.gitignore` | 仓库根忽略规则 |
| 2 | `github-workflows` | `^\.github/workflows/(.+)$` | `.github/workflows/$1` | CI 流水线 |
| 3 | `design-docs` | `^docs/superpowers/specs/([^/]+)$` | `docs/design/$1` | 设计记录 |
| 4 | `device-client-release` | `^ops/device-client-release/(.+)$` | `modules/disk/client/release/$1` | 客户端发布辅助 |
| 5 | `choice-portal` | `^choice/yingchao/(.+)$` | 按 module 分流，见表下 | 统一门户/后台前端 |
| 6 | `disk-client` | `^disk/client/(.+)$` | `modules/disk/client/$1` | Tauri 客户端 |
| 7 | `disk-public` | `^disk/public/(.+)$` | `modules/disk/web/$1` | 网盘网页端 |
| 8 | `disk-device-storage` | `^disk/device-storage/(.+)$` | `modules/disk/server/device-storage/$1` | 设备盘当前实现 |
| 9 | `disk-tests` | `^disk/test/(.+)$` | `tests/unit/disk/$1` | 网盘测试 |
| 10 | `disk-root` | `^disk/([^/]+)$` | `core/legacy/disk/$1` 或 `modules/disk/server/$1` | `module=core` 进核心暂存，其余进 disk server |
| 11 | `glim-tests` | `^glim/server/tests/(.+)$` | `tests/integration/glim/$1` | Glim 集成测试 |
| 12 | `glim-server` | `^glim/server/(.+)$` | `modules/glim/server/$1` | Glim 服务端 |
| 13 | `glim-web` | `^glim/web/(.+)$` | `modules/glim/web/$1` | Glim 网页端 |
| 14 | `glim-sandbox` | `^glim/sandbox/(.+)$` | `modules/glim/sandbox/$1` | 沙盒构建材料 |
| 15 | `glim-ops` | `^glim/ops/(.+)$` | `deploy/glim/$1` | 通用启动脚本 |
| 16 | `glim-docs` | `^glim/docs/(.+)$` | `docs/modules/glim/$1` | Glim 文档 |
| 17 | `glim-channels` | `^glim/channels/(.+)$` | `modules/glim/channels/$1` | 渠道（当前仅邮件） |
| 18 | `glim-root` | `^glim/(README\.md|\.gitignore)$` | `modules/glim/$1` | 模块根文件 |
| 19 | `paper-assets` | `^uniflourish/paper-assets/(.+)$` | `modules/paper/server/assets/$1` | 论文提取脚本 |
| 20 | `pages-templates` | `^uniflourish/server/pages-templates/(.+)$` | `modules/pages/web/templates/$1` | Pages 模板 |
| 21 | `survey-frontend` | `^uniflourish/server/survey/(.+)$` | `modules/survey/web/legacy/$1` | 问卷旧前端 |
| 22 | `legacy-device-storage` | `^uniflourish/server/device-storage/(.+)$` | `modules/disk/legacy/device-storage/$1` | 设备盘旧实现 |
| 23 | `legacy-docs-specs` | `^uniflourish/server/docs/superpowers/specs/([^/]+)$` | `docs/design/legacy/$1` | 服务端旧设计记录 |
| 24 | `legacy-docs-plans` | `^uniflourish/server/docs/plans/([^/]+)$` | `docs/design/plans/$1` | 服务端实施计划 |
| 25 | `legacy-tests` | `^uniflourish/server/test/(.+)$` | `tests/legacy/<module>/$1` | 服务端旧测试 |
| 26 | `legacy-models-middleware` | `^uniflourish/server/(models|middleware)/(.+)$` | `<moduleBase>/legacy/$1/$2` | 模型与中间件 |
| 27 | `legacy-server-root` | `^uniflourish/server/([^/]+)$` | `<moduleBase>/legacy/$1` | 服务端根级文件 |

`choice-portal` 的 module 分流：

| `module` | 目标前缀 |
| --- | --- |
| `admin` | `admin/legacy/portal/` |
| `pages` | `modules/pages/web/portal/` |
| `mail` | `modules/mail/web/portal/` |
| `paper` | `modules/paper/web/portal/` |
| `core` | `core/legacy/portal/` |
| `tools` | `modules/pages/web/portal/tools/` |

`moduleBase` 映射：

| `module` | 目标根 |
| --- | --- |
| `core` | `core/` |
| `admin` | `admin/` |
| `deploy` | `deploy/` |
| `tools` | `tools/` |
| `tests` | `tests/` |
| `disk` / `glim` / `mail` / `pages` / `paper` / `survey` | `modules/<module>/` |

未登记的 module 或未命中的路径**直接报错**（退出码 1），不会落到兜底目录。

### 2.3 映射示例（实测）

| 旧路径 | 目标路径 |
| --- | --- |
| `uniflourish/server/pages-routes.js` | `modules/pages/legacy/pages-routes.js` |
| `uniflourish/server/pages-admin-routes.js` | `modules/pages/legacy/pages-admin-routes.js` |
| `uniflourish/server/device-storage/device-auth.js` | `modules/disk/legacy/device-storage/device-auth.js` |
| `uniflourish/server/models/User.js` | `core/legacy/models/User.js` |
| `uniflourish/server/models/PaperChat.js` | `modules/paper/legacy/models/PaperChat.js` |
| `uniflourish/server/models/BackupTransfer.js` | `deploy/legacy/models/BackupTransfer.js` |
| `uniflourish/server/middleware/auth.js` | `core/legacy/middleware/auth.js` |
| `uniflourish/server/test/pages-ai-models.test.js` | `tests/legacy/pages/pages-ai-models.test.js` |
| `uniflourish/server/docs/superpowers/specs/2026-10-02-central-login-design.md` | `docs/design/legacy/2026-10-02-central-login-design.md` |
| `uniflourish/server/pages-templates/alexa/index.html` | `modules/pages/web/templates/alexa/index.html` |
| `uniflourish/server/survey/app.js` | `modules/survey/web/legacy/app.js` |
| `disk/server.js` | `modules/disk/server/server.js` |
| `disk/device-storage/gateway.js` | `modules/disk/server/device-storage/gateway.js` |
| `disk/client/src-tauri/src/lib.rs` | `modules/disk/client/src-tauri/src/lib.rs` |
| `disk/public/index.html` | `modules/disk/web/index.html` |
| `glim/server/app/main.py` | `modules/glim/server/app/main.py` |
| `glim/server/tests/test_auth.py` | `tests/integration/glim/test_auth.py` |
| `glim/ops/start-broker.sh` | `deploy/glim/start-broker.sh` |
| `choice/yingchao/admin.html` | `admin/legacy/portal/admin.html` |
| `choice/yingchao/pages-manage.html` | `modules/pages/web/portal/pages-manage.html` |
| `docs/superpowers/specs/2026-10-19-nexus-api-design.md` | `docs/design/2026-10-19-nexus-api-design.md` |
| `ops/device-client-release/prepare-manifest.js` | `modules/disk/client/release/prepare-manifest.js` |
| `.github/workflows/disk-client-windows-ice.yml` | `.github/workflows/disk-client-windows-ice.yml` |

### 2.4 本次导出的目标分布

按 `targetPath` 顶层归并（实测 670 个文件）：

| 目标根 | 文件数 |
| --- | --- |
| `tests/` | 160 |
| `modules/disk/` | 229 |
| `modules/pages/` | 73 |
| `modules/glim/` | 53 |
| `modules/mail/` | 8 |
| `modules/paper/` | 14 |
| `modules/survey/` | 14 |
| `core/` | 67 |
| `admin/` | 7 |
| `deploy/` | 6 |
| `docs/` | 37 |
| `.github/` | 1 |
| `.gitignore` | 1 |

> 注意：`module` 是归属表列，`targetPath` 是映射结果，二者统计不可互相替代。例如 `uniflourish/server/models/BackupTransfer.js` 的 module 是 `deploy`，因此按模块统计 disk 少 1、deploy 多 1。

## 3. 硬排除规则

硬排除在映射前执行；命中即跳过并列入报告（`manifest.json.hardExcluded`），即使归属表标为 `导出`。

| 类别 | 规则 | 说明 |
| --- | --- | --- |
| 依赖目录 | 路径段 `node_modules` | 第三方依赖不入公开包 |
| 邮件目录 | 路径段 `Maildir` | 真实邮件数据 |
| 版本库/缓存 | 路径段 `.git`、`__pycache__`、`.venv`、`venv` | 元数据与本地环境 |
| 环境变量 | basename 或路径段匹配 `^\.env(?:$|\.)` | 含 `.env`、`.env.local`、`.env.production`、**`.env.example`** |
| 系统元数据 | `.DS_Store` | macOS 元数据 |
| 私钥/证书 | `*.pem`、`*.p12`、`*.pfx` | 签名与证书材料 |
| 数据库 | `*.sqlite`、`*.sqlite3`、`*.sqlite-wal/-shm/-journal`、`*.dump`、`*.sql.gz` | 真实数据与转储 |
| 备份/归档 | `*.tar`、`*.tar.gz`、`*.tgz`、`*.tar.bz2`、`*.tbz2`、`*.tar.xz`、`*.txz`、`*.zip`、`*.7z`、`*.rar`、`*.bak`、`*.backup`、`*.old`、`*.orig` | 备份包与本地副本 |
| 非常规文件 | 符号链接、目录、设备文件等 | 防止跨出源树读取 |

扩展名匹配不区分大小写。

### 3.1 唯一命中：`.env.example`

归属表把 `glim/server/.env.example` 标为 `导出`，但硬排除规则 `.env*` 会拒绝它。本次实测：

- 归属表 `导出` 行：**671**
- 实际导出：**670**
- 硬排除：**1**（`glim/server/.env.example`）

这是**有意选择严格口径**：真实 `.env` 与任何 `.env.*` 都可能携带值，不能靠文件名猜测是否已脱敏。实测该 `.env.example` 含真实域名、内部主机名、数据库名与开发账户标识，属于应当拒绝的内容（本文不重复具体值）。公开版需要的配置样例应在 `config/` 中重新生成，并用 `config/*.schema.json` 约束字段，而不是从旧树复制 `.env.example`。如果负责人认为必须保留该模板，应先脱敏、再把它作为独立决策改写硬排除规则，而不是在导出脚本里做隐式例外。

## 4. `manifest.json`

### 4.1 结构

```json
{
  "schemaVersion": 1,
  "generator": "tools/export-public.js",
  "baselineSha": "<40 位提交 SHA>",
  "baselineSource": "git-head",
  "exportedAt": "<ISO-8601 UTC>",
  "sourceRoot": "source/site",
  "sourceWorkingTree": "clean",
  "ownershipMap": {
    "path": "docs/m0/ownership/ownership-map.tsv",
    "sha256": "<归属表 SHA-256>",
    "rows": 1313
  },
  "inventoryHash": "<64 位小写十六进制>",
  "inventoryAlgorithm": "sha256(concat(sorted(sourcePath + '\\t' + sha256 + '\\n')))",
  "counts": {
    "total": 1313,
    "byDisposition": { "export": 671, "pending": 34, "excluded": 608 },
    "exported": 670,
    "pending": 34,
    "excluded": 608,
    "hardExcluded": 1,
    "missing": 0,
    "unmapped": 0,
    "collisions": 0,
    "sensitiveExported": 47,
    "byModule": {},
    "byTargetRoot": {}
  },
  "hardExcludeRules": [],
  "mappingRules": [],
  "files": [
    {
      "sourcePath": "uniflourish/server/pages-routes.js",
      "targetPath": "modules/pages/legacy/pages-routes.js",
      "sha256": "<64 位小写十六进制>",
      "bytes": 1234,
      "module": "pages",
      "sensitive": "no",
      "writesFiles": "yes"
    }
  ],
  "pending": [],
  "hardExcluded": [],
  "missing": [],
  "unmapped": [],
  "collisions": []
}
```

### 4.2 字段口径

| 字段 | 口径 |
| --- | --- |
| `baselineSha` | 默认取 `git -C <源目录> rev-parse HEAD`；可用 `--baseline` 覆盖（40 位十六进制） |
| `baselineSource` | `git-head` 或 `cli-override` |
| `exportedAt` | 清单写入时刻，UTC ISO-8601；**不参与** `inventoryHash` |
| `sourceRoot` | 相对 git 仓库根目录的显示路径；外部夹具只显示 basename，避免泄露本机绝对路径 |
| `sourceWorkingTree` | 旧树（排除 `public-release/`）的 `git status` 结果：`clean` / `dirty` / `unknown` |
| `ownershipMap.sha256` | 归属表文件原始字节的 SHA-256 |
| `files[].sha256` | 源文件原始字节的 SHA-256（不是目标路径或元数据的哈希） |
| `files[].bytes` | 源文件字节数 |
| `files[].module` | 归属表 `module` 列 |
| `files[].sensitive` / `writesFiles` | 归属表原始三态 `yes/no/unknown` |
| `pending` | 34 条待定记录的 `sourcePath/module/reason` |
| `hardExcluded` | 导出白名单内被硬排除的记录与原因 |
| `missing` / `unmapped` / `collisions` | 校验失败明细；非空时退出码为 1，不写清单 |

### 4.3 `inventoryHash` 算法

```text
lines = 对每个导出文件生成 sourcePath + "\t" + sha256 + "\n"
lines = 按字符串排序
inventoryHash = sha256(concat(lines))
```

要点：

- 排序后拼接，避免文件系统遍历顺序影响结果；
- **只包含 `sourcePath` + `sha256`**，不包含 `targetPath`、`bytes`、`exportedAt`；
- 因此：同一批源文件重复导出，`inventoryHash` 必须一致；映射调整会改变清单的 `files[].targetPath`，但不会改变 `inventoryHash`。这是刻意的分层：**清单哈希标识“导出了哪些源内容”，映射由 `manifest.files` 和 `mappingRules` 记录**；
- 需要在 CI 中同时校验“内容哈希”和“目标布局”时，应重算 `inventoryHash` 并逐条比对 `files[].targetPath`，见 §6.3。

## 5. 命令

以下命令均在公开版根目录 `source/site/public-release/pagesai` 下执行（从仓库根目录 `cd` 进入）。

### 5.1 只校验，不写文件

```bash
OUT=$(mktemp -d /tmp/pagesai-export-dry.XXXXXX)
node tools/export-public.js --out "$OUT" --dry-run
```

`--dry-run` 会完成归属表解析、映射、缺失/冲突检查与全部 SHA-256 计算，但不创建/清空输出目录，也不写 `manifest.json`。

### 5.2 真实导出

```bash
OUT=$(mktemp -d /tmp/pagesai-export.XXXXXX)
node tools/export-public.js --out "$OUT"
```

目标目录必须不存在或为空。`manifest.json` 是最后写入的文件；输出文件总数为“实际导出数 + 1”。

### 5.3 覆盖已有临时目录

```bash
node tools/export-public.js --out "$OUT" --force
```

`--force` 会**清空输出目录内的全部内容**再导出。脚本会拒绝以下目标：

- 文件系统根目录；
- 旧源码树内部（含 `public-release/`）；
- 旧源码树的祖先目录（防止误清空仓库）。

即使有这些保护，也只应对 `mktemp -d` 创建的临时目录使用 `--force`。

### 5.4 指定源码与归属表

```bash
node tools/export-public.js \
  --source ../.. \
  --map docs/m0/ownership/ownership-map.tsv \
  --out "$OUT"
```

`--source` 用于夹具自测或从其他检出位置导出；默认值就是 `source/site`。`--map` 用于测试夹具，默认值为 `docs/m0/ownership/ownership-map.tsv`。

### 5.5 机器可读摘要

```bash
node tools/export-public.js --out "$OUT" --json
```

`--json` 在 stdout 输出**单行 JSON**，包含 `ok`、`counts`、`inventoryHash`、`pending`、`hardExcluded`、`missing`、`unmapped`、`collisions` 等字段，便于 CI 断言；人类可读报告被抑制。

### 5.6 参数速查

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--out DIR` | 是 | — | 输出目录 |
| `--dry-run` | 否 | 关闭 | 只校验与统计 |
| `--force` | 否 | 关闭 | 清空非空输出目录 |
| `--source DIR` | 否 | `source/site` | 旧源码根目录 |
| `--map FILE` | 否 | `docs/m0/ownership/ownership-map.tsv` | 归属表 |
| `--baseline SHA` | 否 | git HEAD | 覆盖 `baselineSha` |
| `--json` | 否 | 关闭 | 单行 JSON 摘要 |
| `-h, --help` | 否 | — | 帮助 |

退出码：`0` 成功；`1` 校验/导出失败；`2` 参数错误。

## 6. 复跑与校验方法

### 6.1 两次真实导出，断言清单哈希一致

```bash
OUT1=$(mktemp -d /tmp/pagesai-export-a.XXXXXX)
OUT2=$(mktemp -d /tmp/pagesai-export-b.XXXXXX)
node tools/export-public.js --out "$OUT1" --json > /tmp/pagesai-a.json
node tools/export-public.js --out "$OUT2" --json > /tmp/pagesai-b.json

node -e '
const a = require(process.argv[1]);
const b = require(process.argv[2]);
if (a.inventoryHash !== b.inventoryHash) {
  console.error("inventoryHash 不一致", a.inventoryHash, b.inventoryHash);
  process.exit(1);
}
console.log("inventoryHash 一致:", a.inventoryHash);
console.log("导出文件数:", a.counts.exported);
' /tmp/pagesai-a.json /tmp/pagesai-b.json
```

同时可比较两棵输出树（`manifest.json` 的 `exportedAt` 必然不同，需排除）：

```bash
diff -r --exclude=manifest.json "$OUT1" "$OUT2"
```

### 6.2 独立重算 `inventoryHash`

不依赖脚本内部实现，直接从清单重算：

```bash
node -e '
const fs = require("node:fs");
const crypto = require("node:crypto");
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const lines = m.files.map((f) => f.sourcePath + "\t" + f.sha256 + "\n").sort();
const h = crypto.createHash("sha256").update(lines.join(""), "utf8").digest("hex");
console.log(h === m.inventoryHash ? "OK" : "MISMATCH", h);
process.exit(h === m.inventoryHash ? 0 : 1);
' "$OUT1/manifest.json"
```

### 6.3 逐文件校验源文件、目标副本与清单

```bash
node -e '
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const out = process.argv[1];
const src = process.argv[2];
const m = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let bad = 0;
for (const f of m.files) {
  const t = fs.readFileSync(path.join(out, ...f.targetPath.split("/")));
  const s = fs.readFileSync(path.join(src, ...f.sourcePath.split("/")));
  if (sha(t) !== f.sha256 || t.length !== f.bytes || sha(s) !== f.sha256) bad += 1;
}
console.log(bad === 0 ? "OK: " + m.files.length + " 个文件全部一致" : "BAD: " + bad);
process.exit(bad === 0 ? 0 : 1);
' "$OUT1" ../..
```

> 从公开版根目录执行时，`../..` 就是 `source/site`。若把输出目录换成其他位置，`$OUT1` 仍应指向包含 `manifest.json` 的目录。

### 6.4 检查硬排除项确实没有落地

```bash
find "$OUT1" \( \
  -name 'node_modules' -o -name '.env*' -o -name '*.pem' -o -name '*.p12' -o -name '*.pfx' \
  -o -name 'Maildir' -o -name '*.sqlite*' -o -name '*.dump' -o -name '*.tar' -o -name '*.tar.gz' \
  -o -name '*.tgz' -o -name '*.zip' -o -name '.DS_Store' \
\) -print
```

预期输出为空。注意：`find` 只做文件名检查，不能替代内容级密钥扫描。

### 6.5 确认旧源码未被写入

```bash
cd "$(git rev-parse --show-toplevel)"
git status --porcelain -- source/site ':(exclude)source/site/public-release'
```

预期输出为空（本工具只读旧树）。仓库级基线不变验证仍以 `./tools/verify-no-change.sh` 为准；它还会检查 M0 白名单与部署入口。

### 6.6 夹具自测：构造 `.env` 与 `node_modules`

以下命令可在临时目录复现硬排除行为，不会触碰真实源码：

```bash
FIX=$(mktemp -d /tmp/pagesai-b02-fixture.XXXXXX)
SRC="$FIX/src"
mkdir -p "$SRC/disk/test/node_modules/pkg"
printf 'SECRET=1\n' > "$SRC/disk/test/.env"
printf 'x\n' > "$SRC/disk/test/node_modules/pkg/index.js"
printf 'safe\n' > "$SRC/disk/test/ok.js"
printf 'todo\n' > "$SRC/disk/test/pending.js"

MAP="$FIX/map.tsv"
{
  printf 'disk/test/.env\t1\tdisk\t导出\t夹具\t-\tno\tno\n'
  printf 'disk/test/node_modules/pkg/index.js\t1\tdisk\t导出\t夹具\t-\tno\tno\n'
  printf 'disk/test/ok.js\t1\tdisk\t导出\t夹具\t-\tno\tno\n'
  printf 'disk/test/pending.js\t1\tdisk\t待定\t夹具\t-\tno\tno\n'
} > "$MAP"

node tools/export-public.js \
  --source "$SRC" --map "$MAP" --out "$FIX/out" \
  --baseline a8af402bba753a7b86b2421e5953df1d65dc974e

test -f "$FIX/out/tests/unit/disk/ok.js"
test ! -e "$FIX/out/tests/unit/disk/.env"
test ! -e "$FIX/out/tests/unit/disk/node_modules"
```

预期：`实际导出 1`、`硬排除 2`、`待定 1`；输出中只有 `tests/unit/disk/ok.js` 与 `manifest.json`。

## 7. 自测记录（本次实测）

环境：macOS，Node.js v24.15.0；运行时间 2026-10-23（Asia/Shanghai）；基线 `383a61a08e88e1a5fab219ba102fac74447b682f`（运行时 git HEAD）。

| # | 用例 | 命令/方法 | 结果 |
| --- | --- | --- | --- |
| 1 | 语法检查 | `node --check tools/export-public.js` | 通过 |
| 2 | dry-run | `--dry-run` | 退出码 0；输出目录条目数 0；导出 671 条、待定 34、不导出 608、硬排除 1、实际导出 670 |
| 3 | 真实导出 A | `--out "$OUT1" --json` | 退出码 0；670 个文件 + `manifest.json` |
| 4 | 真实导出 B | `--out "$OUT2" --json` | 退出码 0；670 个文件 + `manifest.json` |
| 5 | 哈希可重复 | 比较两次 `inventoryHash` | 一致：`59928caf80a9bf6d230abd65f3a3d9ff839250bd4acc91ee2f51ffb2368888c5` |
| 6 | 树级可重复 | `diff -r --exclude=manifest.json` | 无差异（退出码 0） |
| 7 | 清单独立重算 | §6.2 | 一致 |
| 8 | 逐文件源/目标/清单比对 | §6.3 | 670/670 一致，0 缺失 |
| 9 | 硬排除落地检查 | `find` 扫描 | 0 个禁止制品 |
| 10 | `.env` 夹具 | §6.6 | 被拒；未写入输出 |
| 11 | `node_modules` 夹具 | §6.6 | 被拒；未写入输出 |
| 12 | 其他硬排除夹具 | 另加 `.env.example`、`.pem`、`.p12`、`.pfx`、`Maildir`、`.sqlite`、`.dump`、`.tar.gz`、`.DS_Store`、符号链接 | 12 项全部被拒；仅 `ok.js` 写入 |
| 13 | 缺失文件 | 归属表引用不存在路径 | 退出码 1；不创建输出目录；报告“缺失 1” |
| 14 | 重复路径 | 归属表同一路径两行 | 退出码 1；格式校验失败 |
| 15 | 输出目录在源树内 | `--out "$SRC/export"` | 退出码 1；明确拒绝 |
| 16 | 输出目录是源树祖先 | `--out "$FIX"` | 退出码 1；明确拒绝 |
| 17 | 非空输出目录未加 `--force` | 二次导出到同一目录 | 退出码 1；提示加 `--force` 或换空目录 |
| 18 | `--force` | 清空后重导 | 退出码 0；陈旧文件消失 |
| 19 | 空 `--out` | `--out ""` | 退出码 2；参数错误 |
| 20 | 文件系统根 | `--out / --dry-run` | 退出码 1；明确拒绝 |

本次实测计数：

```text
total=1313 export=671 pending=34 excluded=608 hardExcluded=1 exported=670 missing=0 unmapped=0 collisions=0
inventoryHash=59928caf80a9bf6d230abd65f3a3d9ff839250bd4acc91ee2f51ffb2368888c5
```

> `inventoryHash` 绑定当时的源文件内容。源文件后续变化时哈希会变化，这是预期行为；复跑一致性应在**同一次检出**上比较。

## 8. 已知缺口与后续

| # | 缺口 | 影响 | 建议 |
| --- | --- | --- | --- |
| G1 | 旧 `glim/server/.env.example` 被严格 `.env*` 规则拒绝（671→670） | 旧模板不进入发布物 | 公开版已在 `config/example.env` 提供脱敏样例并以 `config/config.schema.json` 对齐；旧模板不再需要，保持排除 |
| G2 | 47 个导出文件 `sensitive=yes`，未自动排除或脱敏 | 可能带出真实邮箱/本机路径/内部标识 | 发布前逐条复核；优先处理 `uniflourish/server/legal-documents.js`、`disk/client/LIGHTWEIGHT_ACCEPTANCE.md` |
| G3 | 34 个「待定」文件未决 | 白名单不完整，D2/D3 仍未闭环 | 按 M0 §4 建议逐项决策；本工具已把它们稳定记录在 `pending` |
| G4 | `uniflourish/server` 旧入口仍依赖不导出产品（D3） | 导出集合可能无法独立启动 | B03/B07/D3 处理 require 闭包与模块解耦；本工具只负责白名单与来源记录 |
| G5 | `legacy/` 只是暂存区 | 目标结构不是最终架构 | 后续重构逐文件迁出 `legacy/`，不在暂存区叠加新功能 |
| G6 | 无根 `LICENSE` | 公开推送的许可链条不完整 | 根 `LICENSE` 由负责人决策（D1）；`THIRD_PARTY_NOTICES.md` 与 `docs/licenses/dependency-licenses.md` 已建立，PDF.js/KaTeX 未随包分发 |
| G7 | 硬排除只按路径/文件名，不做内容级密钥扫描 | 导出的 `.js` 内仍可能含硬编码标识 | `tools/verify-release.js` 的 `secrets-scan`/`address-scan` 与 [`security-scan-report.md`](security-scan-report.md) 提供内容级复核；本工具保留 `sensitive` 三态 |
| G8 | `baselineSha` 默认是运行时 HEAD，不是冻结审计基线 `a8af402` | 复现审计基线需显式切检 | 需要审计基线时：`git checkout a8af402...` 后重跑，或用 `--baseline a8af402...` 仅覆盖记录值（不会改变文件内容） |
| G9 | `tools/verify-no-change.sh` 曾因白名单外变更失败 | 旧树变更可追溯到负责人 | 2026-10-25 复跑 exit 0：1,315 个文件，11 个外部变更已登记进 `allowed-external-changes.txt` |
| G10 | 清单不记录文件权限/属主/mtime | 复现时只保证内容一致 | 脚本已保留源文件可执行位；若发布需要完整元数据，另建发布包清单 |

### 8.1 与「待定」文件的边界

本工具**不会**把 `待定` 当作 `导出` 的候选自动尝试，也不会在 dry-run 中复制它们。待定的 34 条记录只在报告与 `manifest.pending` 中出现，包含 `sourcePath/module/reason`，便于负责人按模块逐项决策。

## 9. 约束与禁止事项

- 只使用 Node 内置模块（`node:fs`、`node:path`、`node:crypto`、`node:child_process`），无第三方依赖；
- 不执行 `npm install`，不启停生产服务，不运行 `scripts/dev.sh`；
- 旧源码树只读；工具在创建输出目录前完成全部校验，且拒绝源树内部/祖先作为输出；
- 不写入真实域名、IP、账号或密钥；清单中的 `sourceRoot` 使用仓库相对路径，夹具使用 basename；
- 只写 `tools/export-public.js` 与 `docs/export-whitelist.md`，不改 `core/`、`contracts/`、`modules/`、`docs/m0/` 或他人文件。

## 10. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-23 | 初版：三档处置、27 条映射规则、硬排除、`manifest.json`、两次导出哈希一致与夹具负向自测 |
