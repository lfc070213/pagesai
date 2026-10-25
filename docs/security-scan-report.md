# 安全与敏感信息扫描报告（2026-10-25）

> 本报告只记录**可复跑的工具与判定**，不复述命中的真实地址、主机名或个人路径。所有原文都在发布根内，命中位置用「文件 + 行号 + 类别」表示。
> 结论先行：**发布物（白名单导出结果）内无真实密钥、无私网地址、无本机用户路径**；仓库内的 17 项地址阻断全部位于 `docs/m0/**`，该目录被导出策略 deny，不进入公开制品。根 `LICENSE` 缺失属于法律决策（D1），不是扫描问题。

## 1. 扫描面与工具

| 工具 | 覆盖范围 | 规则 |
| --- | --- | --- |
| `tools/verify-release.js` → `secrets-scan` | 发布根内全部文本文件（跳过二进制与构建产物） | 私钥起始标记、云厂商 AccessKey（AWS/阿里云）、代码托管与协作平台令牌、`sk-` 模型密钥样式、Google API Key 样式 |
| `tools/verify-release.js` → `address-scan` | 同上；测试夹具与扫描器自身降级为 WARN | RFC1918 三段、100.64/10（组网常用段）、Tailnet 主机名、macOS 与 Linux 用户目录绝对路径、写死的 owner 常量 |
| `tools/verify-release.js` → `forbidden-artifacts` | 发布根内文件名 | `node_modules`、虚拟环境、数据库文件、`.env`、备份包、日志、`.DS_Store`、邮件服务状态目录 |
| `tools/check-imports.js` | 公开版源码与文档 | 导入闭包（不得引用未导出模块）、禁用关键字、私网地址（文档正文允许声明排除项名称，但地址仍查） |
| `tools/export-public.js --out <DIR> --dry-run` | 归属表 1,313 个文件 | 白名单导出、硬排除、缺失/未映射/冲突统计 |

未使用专用第三方扫描器（`gitleaks`、`trufflehog`）交叉验证：本机未安装，且安装需要联网拉取二进制。此项以「未执行」记录，见 §5。

## 2. 本次结果

### 2.1 密钥与制品

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `secrets-scan` | ✅ 0 命中 | 无任何密钥样式匹配 |
| `forbidden-artifacts` | ✅ 0 命中 | 无依赖目录、`.env`、数据库、备份包、日志 |
| `check-imports.js` | ✅ 0 违规 | 227 个文件扫描，15 个按规则豁免，0 项违规 |
| 导出硬排除 | ✅ 1 个 | `glim/server/.env.example` 因路径命中 `.env*` 被拒绝导出 |

### 2.2 地址与本机路径

`address-scan` 共 29 项，按等级与位置：

| 等级 | 数量 | 位置 | 判定 |
| --- | --- | --- | --- |
| BLOCK | 17 | `docs/m0/` 下 7 个文件（A01–A05 与两份交叉检查） | **内部审计证据**：如实记录了当时的内网地址、组网主机名与本机路径。导出策略 deny `docs/m0/**`，`.gitattributes` 同步 `export-ignore`，因此不进入公开制品。`--exclude docs/m0` 后本检查仅剩下述 WARN |
| WARN | 1 | `config/README.md:89` | 「拒绝复用的旧数据根」示例清单，用词是云镜像默认账户目录，不是任何真实个人路径；保留是为了让使用者知道哪些根会被拒绝。可改为占位符，但不阻断发布 |
| WARN | 3 | `tools/init.js:52`、`tools/restore.js:36`、`tools/uninstall.js:36` | 同上：旧平台数据根的**拒绝清单**字面量，每个工具各一处。工具只做相等比较，不会读写该路径 |
| WARN | 4 | `tests/contracts/imports.test.js` | 测试夹具：合成私网地址与组网主机名，用于验证扫描规则本身能命中。非真实资产 |
| WARN | 4 | `docs/m0/` 下同类命中 | 与 BLOCK 同源，聚合分组后的伴生行 |

> 复核方式：`node tools/verify-release.js --exclude docs/m0 --json` → `{"block":1,"warn":8,"ok":8}`，唯一阻断为根 `LICENSE` 缺失。

### 2.3 合成数据声明

测试与文档中的账号、邮箱、令牌、地址均为合成值：`tests/` 使用临时用户目录夹具；`modules/*/tests/` 的 SMTP/IMAP/Mongo 均为本地假服务器或内存实例；`docs/guides/` 的示例配置不含真实凭据。仓库内不存在生产 `.env`、生产数据库或真实用户数据。

## 3. 修复过的真实问题

| 时间 | 问题 | 处理 |
| --- | --- | --- |
| 2026-10-25 | `modules/mail/tests/mail-protocol.test.js` 的两个假 SMTP/IMAP 服务器未挂 `error` 监听，客户端在 `QUIT`/`LOGOUT` 后销毁连接会触发服务端 `ECONNRESET`，被 `node:test` 计为未捕获异常 | 在两处假服务器上补 `socket.on('error', () => {})`；连跑三次该用例 4/4 通过，mail 模块 32/32 通过 |

## 4. 未关闭项

| 项 | 状态 | 关闭条件 |
| --- | --- | --- |
| 根 `LICENSE` 缺失 | 阻断（D1） | 负责人选定许可证并写入根 `LICENSE`，同步 `LICENSE-DECISION.md` |
| `docs/m0/**` 内的真实地址 | 已从制品排除，仓库内保留 | 若需公开仓库本身干净，需脱敏或移出（属审计证据保留决策） |
| 专用扫描器交叉验证 | 未执行 | 在可联网构建区安装 `gitleaks`/`trufflehog`，对全部提交历史复跑并归档报告 |

## 5. 复跑命令

```bash
cd source/site/public-release/pagesai

node tools/verify-release.js                       # 全量：17 阻断（docs/m0 地址）+ 1 阻断（LICENSE）+ 12 警告
node tools/verify-release.js --exclude docs/m0     # 只看制品口径：仅 LICENSE 阻断
node tools/check-imports.js --root .               # 导入闭包与关键字：0 违规
node tools/export-public.js --out /tmp/pagesai-export --dry-run   # 导出统计与哈希
```

判定规则：`secrets-scan`、`forbidden-artifacts`、`check-imports` 必须 0 命中；`address-scan` 在制品口径下只允许已登记的 WARN。任何新增 BLOCK 必须先定位到真实文件并修复，不得靠扩大排除范围消除。