# CI 与发布流水线

- 适用仓库：公开版源码区（本目录）
- 方案依据：§2.3（可重复发布、包内不得引用私有工作区）、§13.4（CI/CD 与发布）
- 权威文件：`.github/workflows/ci.yml`、`.github/workflows/release.yml`、`tools/test-all.js`、`tools/release-manifest.js`

## 0. 一句话结论

- **CI** 在 push / PR 时跑契约、集成、六个模块、导入闭包、导出 dry-run 与发布检查，任一失败即红。
- **Release** 只能人工触发，经过 `release` environment 审批后生成可复现源码包、清单与校验和，只上传 artifact。
- **没有任何自动发布动作**：不建 Release、不推镜像、不部署、不启动生产服务。

| 项目 | 约定 |
| --- | --- |
| Node.js | 24（`actions/setup-node`） |
| 第三方依赖 | 无；不执行 `npm install` / `npm ci`，不缓存依赖 |
| Runner | `ubuntu-latest` |
| 权限 | `contents: read`（最小权限） |
| 发布触发 | 仅 `workflow_dispatch`，且 job 绑定 `release` environment |

## 1. CI：`.github/workflows/ci.yml`

### 1.1 触发条件

- push 到 `main`；
- 任意 `pull_request`；
- 手动 `workflow_dispatch`（用于重跑）。

同一分支的新运行会取消旧运行（`concurrency.cancel-in-progress: true`），PR 反复推送不会堆积。

### 1.2 Job 与检查项

| Job | 检查内容 | 对应命令 |
| --- | --- | --- |
| `contracts` | 契约测试、契约 JSON 语法、导入闭包 | `node --test tests/contracts/*.test.js`；逐个 `JSON.parse` `contracts/*.json`；`node tools/check-imports.js` |
| `integration` | 核心启动与模块装配 | `node --test tests/integration/*.test.js` |
| `modules` | 六个模块各自测试，矩阵并行 | `node --test modules/<id>/tests/*.test.js` |
| `all-tests` | 聚合 `tests/**` 与 `modules/*/tests/**`，输出汇总 | `node tools/test-all.js --json` |
| `release-checks` | 导出 dry-run、硬排除、公开包可复现、许可清单、清单可复现、发布工作流约束 | 见下 |

`modules` 矩阵固定为 `pages, disk, glim, mail, survey, paper`，`fail-fast: false`：一个模块失败不会遮住其他模块的结果。

`release-checks` 的六步：

1. **白名单导出 dry-run**：仅当检出中存在旧源码树 `source/site` 时执行
   `node tools/export-public.js --source source/site --map docs/m0/ownership/ownership-map.tsv --out "$RUNNER_TEMP/pagesai-export" --dry-run --json`。
   公开仓库被单独检出时没有旧源码树，这一步按预期跳过并在步骤摘要中说明；不能把“跳过”当成“已验证导出”。
2. **硬排除检查**：对 `git ls-files` 结果拒绝依赖目录、`.env*`、证书私钥、数据库、转储与归档包。
3. **公开包白名单与可复现**：按 `config/public-bundle-policy.json` 导出两次，比较 `PUBLIC-BUNDLE-MANIFEST.json` 逐字节一致；deny 优先于 include，`docs/m0`、内部工具与 CI 元数据不进入分发包。
4. **许可清单一致**：`node tools/license-scan.js --check --json`；`docs/licenses/` 下的清单必须与当前依赖锁定文件一致，离线无法确认的条目保持“待确认”，不得手工改成“已确认”。
5. **清单可复现**：同一目录连续生成两次清单，`cmp` 比较必须逐字节一致，再用 `--check` 反向校验。
6. **发布工作流约束**：静态检查 `release.yml` 只能人工触发、必须绑定 `release` environment、必须上传 artifact，且不得出现安装依赖或自动发布命令。

> CI 不读取任何密钥。所有 job 只需要只读代码权限；artifact 上传由运行器令牌完成，不需要额外 secret。

### 1.3 失败时怎么读

- Job 名直接对应失败类别；模块失败看 `模块测试 <id>`。
- `all-tests` 的步骤摘要会列出失败文件与失败用例名。
- 需要完整明细时，在本地按下面第 3 节复跑对应文件。

## 2. Release：`.github/workflows/release.yml`

### 2.1 触发与审批

- 只有 `workflow_dispatch`，没有 push / tag / schedule 触发器。
- `package` job 绑定 `environment: release`。在仓库 `Settings → Environments → release` 配置 **Required reviewers** 后，运行会停在审批处；未审批不会开始构建。
- 建议同时限制该 environment 的可部署分支为受保护分支。

### 2.2 执行步骤

1. 检出源码（`fetch-depth: 0`，禁用凭据持久化）。
2. 校验工作树干净，拒绝把未提交改动打进包。
3. 解析版本标识：手动输入优先，留空则用 `sha-<7 位短提交>`；只允许字母、数字、点、下划线与连字符，最长 64 字符。
4. **构建两次**：
   - `git archive --format=tar --prefix=pagesai-<版本>/ HEAD | gzip -n -9`；
   - `.gitattributes` 的 `export-ignore` 排除 `docs/m0`、内部审计工具与 `.github`，归档内不含内部材料；
   - 分别在两个临时目录解包，并用 `tools/release-manifest.js` 生成清单；
   - `cmp` 比较两次的压缩包与清单，必须逐字节一致。
5. **发布门禁（制品）**：对解包后的真实制品执行 `tools/verify-release.js --artifact ...`。根 `LICENSE` 未由 owner 决定前，本步骤以退出码 1 阻断发布；地址/密钥命中同样阻断。
6. 生成 `dist/SHA256SUMS`（源码包与清单各一行）。
7. 写入步骤摘要：版本、提交 SHA、文件数、`inventoryHash`、校验和。
8. 上传 artifact，保留 30 天：`pagesai-src-<版本>`，内含 `pagesai-<版本>.tar.gz`、`release-manifest.json`、`SHA256SUMS`。
9. 明确打印“未执行任何发布动作”。

### 2.3 为什么可复现

- 归档内容来自 `git archive HEAD`，文件时间取提交时间，不含 `.git`、工作区改动与忽略文件；
- `gzip -n` 不写入文件名与时间戳；
- 清单按路径字节序排序，`inventoryHash` 只由路径与内容哈希决定，不含生成时间、主机名或绝对路径；
- 两次构建逐字节比较，把“换一台机器结果不同”挡在 artifact 之前。

### 2.4 Release 不做什么

- 不创建代码托管平台的 Release / Tag；
- 不推送镜像、不部署、不重启服务；
- 不读取或写入任何密钥；
- 不代替人工判断“是否可以发布”。

正式对外发布是独立的人工流程：审批通过 → 下载 artifact → 按第 4 节检查单复核 → 由发布负责人在仓库外执行。

## 3. 本地复跑

前置：Node.js 24，命令在仓库根目录执行。

```bash
cd <仓库根目录>
node --version   # 应为 v24.x

# 全部测试（tests/** + modules/*/tests/**），逐文件汇总
node tools/test-all.js

# 机器可读汇总（stdout 只有 JSON）
node tools/test-all.js --json

# 只跑某一类或某个文件
node tools/test-all.js --filter '^tests/contracts/'
node tools/test-all.js --filter '^modules/disk/'
node tools/test-all.js --file tests/integration/core-boot.test.js

# 直接调用 node --test（与 CI 的单项命令一致）
node --test tests/contracts/*.test.js
node --test tests/integration/*.test.js
node --test modules/disk/tests/*.test.js

# 可选：真实 Mongo + Pages 干净临时安装 E2E；依赖和二进制在仓库外
NODE_PATH=/tmp/pagesai-mongo-build/node_modules \
MONGOMS_SYSTEM_BINARY=/tmp/pagesai-mongo-build/binaries/mongod-arm64-darwin-7.0.24 \
PAGESAI_MONGO_TEST=1 node --test tests/integration/pages-clean-install.test.js

# 导入闭包 / 私有路径 / 未选模块依赖
node tools/check-imports.js

# 白名单导出 dry-run（需要旧源码树；仅校验，不写文件）
node tools/export-public.js --out /tmp/pagesai-export --dry-run

# 公开包：两次导出比较清单，并对制品做发布门禁
node tools/public-bundle.js --out /tmp/bundle-a --json
node tools/public-bundle.js --out /tmp/bundle-b --json
cmp /tmp/bundle-a/PUBLIC-BUNDLE-MANIFEST.json /tmp/bundle-b/PUBLIC-BUNDLE-MANIFEST.json
node tools/verify-release.js --artifact /tmp/bundle-a --json

# 依赖与素材许可清单：核对已入库文件
node tools/license-scan.js --check --json

# 发布清单：生成、复现、反向校验
node tools/release-manifest.js --dir . --out /tmp/manifest-a.json
node tools/release-manifest.js --dir . --out /tmp/manifest-b.json
cmp /tmp/manifest-a.json /tmp/manifest-b.json
node tools/release-manifest.js --dir . --check /tmp/manifest-a.json
```

本地复现源码包（与 Release 相同的归档方式）：

```bash
VERSION=demo
git archive --format=tar --prefix="pagesai-${VERSION}/" HEAD | gzip -n -9 > "/tmp/pagesai-${VERSION}.tar.gz"
rm -rf /tmp/pagesai-extract && mkdir -p /tmp/pagesai-extract
tar -xzf "/tmp/pagesai-${VERSION}.tar.gz" -C /tmp/pagesai-extract
node tools/release-manifest.js --dir /tmp/pagesai-extract --out /tmp/release-manifest.json
node tools/release-manifest.js --dir /tmp/pagesai-extract --check /tmp/release-manifest.json
```

`tools/test-all.js` 的常用参数：

| 参数 | 作用 |
| --- | --- |
| `--filter REGEX` | 只运行相对路径匹配的测试文件，可重复 |
| `--file FILE` | 只运行指定文件，可重复 |
| `--timeout MS` | 单个文件总超时，默认 180000 |
| `--test-timeout MS` | 传给 `node --test` 的单条用例超时，默认 120000 |
| `--fail-fast` | 第一个失败后停止 |
| `--list` | 只列出将运行的文件 |

退出码：`0` 全部通过；`1` 有失败或未发现测试文件；`2` 用法错误。

## 4. 发布前人工检查单

按顺序逐项打勾；任何一项为“否”都不得发布。

- [ ] **审批环境已配置**：`release` environment 设置了 Required reviewers，且只有受保护分支能运行。
- [ ] **提交已冻结**：待发布提交就是 CI 全绿的那个提交；工作树干净，没有未提交或未跟踪文件。
- [ ] **版本已确定**：版本标识、Tag 与发布说明一致；`workflow_dispatch` 的 `version` 填写正确。
- [ ] **CI 全绿**：`contracts`、`integration`、`modules` 六个矩阵、`all-tests`、`release-checks` 全部通过。
- [ ] **导入闭包干净**：`node tools/check-imports.js` 退出码为 0，没有私有路径、私有网段、未选模块依赖或禁止名称。
- [ ] **导出 dry-run 已复核**：有旧源码树时看过导出统计、“待定”清单与“硬排除”命中；无旧源码树时明确记录本次不适用。
- [ ] **敏感文件已处理**：导出报告中 `sensitive=yes` 的文件已逐个复核、脱敏或移出白名单；不得凭字段名直接放行。
- [ ] **许可证与声明齐全**：根目录许可证、第三方声明与安全说明已就绪；缺失则不得发布。
- [ ] **硬排除为空**：artifact 内没有依赖目录、`.env*`、证书私钥、数据库、转储、日志、备份或归档包。
- [ ] **校验和一致**：本地复算的 `inventoryHash`、`SHA256SUMS` 与审批运行的 artifact 完全一致。
- [ ] **产物可追溯**：记录版本、提交 SHA、artifact 名称、`inventoryHash`、审批人、下载人与发布时间。
- [ ] **发布动作人工执行**：发布不由本流水线完成；执行人按团队流程操作，并在完成后回填记录。
- [ ] **泄露应急就绪**：若发现密钥或个人信息进入包内，立即停止发布、轮换凭据并按安全流程处理。

## 5. 清单格式与算法（`tools/release-manifest.js`）

输出只有两个顶层字段：

```json
{
  "files": [
    {
      "path": "README.md",
      "sha256": "<64 位小写十六进制>",
      "bytes": 3382
    }
  ],
  "inventoryHash": "<64 位小写十六进制>"
}
```

规则：

1. 路径统一为相对目录根的 POSIX 形式（`/` 分隔，不含 `./`）；
2. 文件按路径的 UTF-8 字节序升序排列；
3. 每个文件记录 `path`、`sha256`、`bytes`；
4. `inventoryHash = SHA-256( concat( path + "\t" + sha256 + "\n" ) )`，按同一顺序拼接；口径与 `tools/export-public.js` 一致，`bytes` 只用于展示与核对，不参与哈希；
5. 不含生成时间、主机名、绝对路径等易变信息；
6. 默认只跳过 `.git`；其余文件都会进入清单，需要排除时显式使用 `--exclude`；
7. 遇到符号链接、设备文件等非普通文件直接失败，避免清单与真实内容不一致；
8. `--out` 不得位于被扫描目录内部，否则清单会包含自身、无法复现；
9. `--check FILE` 重新扫描并比对；不一致时退出码为 1，并列出缺失、多出或内容变化的文件。

常用命令：

```bash
# 输出到 stdout
node tools/release-manifest.js --dir .

# 写入文件并输出单行摘要
node tools/release-manifest.js --dir . --out /tmp/release-manifest.json --json

# 排除某个目录
node tools/release-manifest.js --dir . --exclude 'docs/m0/**'

# 反向校验
node tools/release-manifest.js --dir . --check /tmp/release-manifest.json
```

## 6. 故障排查

| 症状 | 原因与处理 |
| --- | --- |
| `all-tests` 失败但 CI 其他 job 绿 | 聚合入口发现了额外测试文件或顺序差异；看步骤摘要中的失败文件，用 `node --test <file>` 复跑 |
| 某个模块矩阵失败 | 该模块测试依赖缺失或实现回归；`node --test modules/<id>/tests/*.test.js` 单独复现 |
| 导出 dry-run 被跳过 | 独立检出公开仓库时没有 `source/site`，属预期；在共享仓库内运行即可真正校验 |
| 清单两次不一致 | 生成期间目录被改动，或把 `--out` 写进了被扫描目录；确认输出在目录外并重新生成 |
| `--check` 报“多出文件” | 工作区有未跟踪文件（例如本地日志、临时产物）；清理后再生成 |
| Release 没有等待审批 | `release` environment 未配置 Required reviewers；到仓库 Settings 补齐 |
| Artifact 上传失败 | 检查 `name` 是否重复；同一工作流重复上传同名 artifact 需要覆盖策略或改版本标识 |
| 归档两次不一致 | 确认用 `git archive HEAD` 且 `gzip -n`；不要从工作区 `tar` 打包 |

## 7. 边界与约束

- 所有脚本只用 Node 内置模块，不需要锁文件，因此 CI 不安装依赖、不缓存依赖。
- 工作流不启动生产服务、不执行部署、不改动共享仓库的旧源码区。
- 文档与工作流中不写入真实域名、IP、账号或密钥。
- 六模块的测试由各模块自己维护；本目录的 CI 只负责按统一口径执行与汇总。

## 8. 相关文件

- [CI 工作流](../.github/workflows/ci.yml)
- [发布工作流](../.github/workflows/release.yml)
- [全量测试入口](../tools/test-all.js)
- [发布清单工具](../tools/release-manifest.js)
- [导入闭包检查](../tools/check-imports.js)
- [白名单导出](../tools/export-public.js)
- [导出白名单说明](export-whitelist.md)