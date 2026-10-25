# 配置目录（config/）

本目录是 PagesAI 公开版的**部署配置契约与示例**，不含任何秘密值。

| 文件 | 作用 |
| --- | --- |
| `config.schema.json` | `config.json` 的 JSON Schema（零依赖校验器可读的受限子集）；`tools/init.js` 生成、其余工具读取并校验 |
| `example.env` | 代码实际读取的**全部环境变量**的占位值示例，用于生成 `secrets/pagesai.env` |
| `README.md` | 本说明 |

> `config.json` 由 `tools/init.js` 生成在安装根目录（可用 `--config` 或 `PAGESAI_CONFIG` 指定），**不要手工编造**；
> 手工修改后必须能通过 `config/config.schema.json` 与 `contracts/storage-region.schema.json` 校验，
> 否则 `tools/upgrade.js` 会拒绝继续。

## 1. 快速开始

在公开版根目录（本文件上一级）执行：

```bash
# 1) 初始化：数据根必须显式给出，不从环境变量或旧部署推断
node tools/init.js \
  --data-root /srv/pagesai-data \
  --modules all \
  --disk-variant generic \
  --registration open \
  --domain example.com \
  --port 8080 \
  --dry-run          # 先看计划；去掉 --dry-run 才写盘

# 2) 生成 config.json 后，补齐迁移台账与区域目录，并做验证
node tools/upgrade.js --check
node tools/upgrade.js --step all

# 3) 建立首份可验证备份（生产建议 --out 指向独立卷）
node tools/backup.js --out /srv/pagesai-backups --label initial

# 4) 恢复演练：先只校验，不写盘
node tools/restore.js --backup /srv/pagesai-backups/<backup-id> --verify-only

# 5) 卸载：默认保留数据；只有 --purge 才永久删除
node tools/uninstall.js --dry-run
node tools/uninstall.js
node tools/uninstall.js --purge --dry-run
node tools/uninstall.js --purge          # 打印范围并二次确认
```

所有工具都支持 `--help` 与 `--dry-run`，且 `--dry-run` 不创建目录、不写文件、不删除数据。

## 2. config.json 字段

| 字段 | 说明 |
| --- | --- |
| `schemaVersion` | 配置结构版本，当前为 `1`；更高版本会被旧工具拒绝 |
| `product` / `productVersion` | 固定 `pagesai` 与生成该配置的公开版版本 |
| `deploymentId` | 部署唯一标识；升级、备份、恢复、卸载都据此确认同一部署 |
| `createdAt` / `updatedAt` | UTC ISO 8601 时间 |
| `installRoot` | 安装根（代码位置）；只用于解析秘密材料相对路径，不推导数据根 |
| `dataRoot` | 数据根绝对路径；**初始化后即权威记录** |
| `domain` / `port` / `publicBaseUrl` | 对外域名（可为 `null`）、监听端口、展示用访问地址 |
| `modules` | 已安装业务模块；空数组表示仅公共核心 |
| `coreCompatibility` | 兼容的公共核心契约范围 |
| `disk.variant` | `generic` / `pku`；`dataPlane` 固定 `shared`，两版共用数据面，切换版本不移动数据 |
| `registration` | `mode`（`open` / `email`）、`enabled`、`requireEmailVerification`、`allowedEmailDomains`；`email` 模式必须包含 `mail` 模块 |
| `sessionTtlMs` | 会话有效期（毫秒），下限 300000 |
| `storage` | 存储配置键 → 物理根绝对路径（唯一权威解析入口） |
| `regions` | 存储区域声明，字段与 `contracts/storage-region.schema.json` 对齐；`allowImplicitChange` 恒为 `false` |
| `database` | `engine`（当前 `json-store`）、`stateDir`（部署标记、身份导出、迁移台账） |
| `secrets` | 秘密材料**引用**：`mode`、`reference`、`keys`；**不保存秘密值** |
| `glim.connections` | Glim 对各模块的连接状态占位；初始化一律 `unconfigured` |

`storage` 键（按模块安装生成，未安装模块不生成）：

| 模块 | 配置键 | 默认子目录 | 区域 ID |
| --- | --- | --- | --- |
| pages | `storage.pages.root` / `storage.pages.materials` / `storage.pages.backends` / `storage.pages.aiWorkspace` | `pages-data` / `pages-materials` / `pages-backends` / `pages-ai-workspace` | `pages.sites` / `pages.materials` / `pages.backends` / `pages.ai-workspace` |
| disk | `storage.disk.root` / `storage.disk.pkuRoot`（仅 pku）/ `storage.disk.uploadTmp` / `storage.disk.previewCache` / `storage.disk.shareRegistry` | `disk` / `disk-pku` / `disk-upload-tmp` / `disk-preview-cache` / `disk-share-registry` | `disk.user-files` / `disk.pku-archive` / `disk.upload-tmp` / `disk.preview-cache` / `disk.share-registry` |
| glim | `storage.glim.state` | `glim-state` | `glim.state` |
| mail | `storage.mail.mailbox` | `mail-mailbox` | `mail.mailbox` |
| survey | `storage.survey.responses` / `storage.survey.attachments` / `storage.survey.uploadTmp` | `survey-responses` / `survey-attachments` / `survey-upload-tmp` | `survey.responses` / `survey.attachments` / `survey.upload-tmp` |
| paper | `storage.paper.uploads` | `paper-uploads` | `paper.uploads` |

模块清单 `modules/<id>/manifest.json` 的 `data.regions` 是区域 ID 的权威来源；`tools/init.js` 的区域表与之一一对应，只额外包含部署层自用的 `disk.pku-archive`、`disk.upload-tmp`、`disk.preview-cache`、`disk.share-registry` 和 `survey.upload-tmp`（`DEPLOYMENT_ONLY_REGIONS`）。`tests/contracts/init-regions.test.js` 会校验两者不会再次分叉。

生成配置时还会为已安装模块写入 `moduleConfig` 默认值：`pages.dataFile`、`pages.taskRuntimeRoot`、`pages.backendRuntimeRoot`、`disk.dataFile`、`glim.dataFile`、`glim.workspaceRoot`、`mail.dataFile`、`survey.dataFile`、`survey.attachmentsDir`、`paper.dataFile`、`paper.uploadsDir`，全部落在上表已登记的区域里，因此默认部署不是纯内存运行。部署者可用 `--module-config <file>` 逐字段覆盖；升级时未显式给出则沿用既有 `moduleConfig`。

## 3. 数据根规则（方案 §6.1）

1. `--data-root` **必须显式给出**；工具不会读取 `PAGESAI_DATA_ROOT` 或旧配置来推断。
2. 拒绝文件系统根、用户主目录、旧平台/现网根：`/data`、`/home/ubuntu/glim`、`/srv/uniflourish`、`/opt/uniflourish`、`/var/lib/uniflourish`。
3. 拒绝位于安装目录内部的数据根（确需如此加 `--allow-data-root-in-install`）。
4. 数据根非空且没有部署标记（`<dataRoot>/state/deployment.json`）时拒绝接管；确认接管加 `--adopt-data-root`。
5. 已登记数据根发生变更时，`tools/init.js` 与 `tools/upgrade.js` 都拒绝继续；迁移数据必须先备份，再加 `--confirm-data-root-change` 显式确认。
6. 公开版使用新布局 `<dataRoot>/<子目录>`，**不会自动迁移旧 `/data` 根**；旧数据需按部署文档显式迁移并验证哈希。
7. 存储区域路径不得互相重叠（例如一个区域根包含另一个）。
8. 容器编排预设里的 `PAGESAI_DATA_ROOT=/data` 是**容器内路径**；宿主侧对应目录由卷映射决定，必须与 `config.json` 的 `dataRoot` 保持一致。

## 4. 秘密材料与环境变量

- `config.json` 只保存引用：`secrets.mode=env-file`、`secrets.reference=secrets/pagesai.env`、`secrets.keys`。
- 真实秘密只放在 `secrets/pagesai.env`（权限 0600，相对 `installRoot`）或部署平台；**不进入 Git、不进入备份正文**。
- `tools/backup.js` 只记录引用的路径与是否就位；`tools/restore.js` 恢复后提示单独恢复秘密材料。
- `config/example.env` 只是占位示例，工具**不会自动加载**它。

环境变量清单（与 `example.env` 一一对应）：

| 变量 | 作用 | 敏感 |
| --- | --- | --- |
| `PAGESAI_INSTALL_ROOT` | 安装根目录 | 否 |
| `PAGESAI_DATA_ROOT` | 运行时数据根（部署时须与 `config.json` 一致） | 否 |
| `PAGESAI_MODULES` | 已安装模块逗号列表 | 否 |
| `PAGESAI_REGISTRATION_ENABLED` | 是否允许公开注册 | 否 |
| `PAGESAI_EMAIL_REGISTRATION` | 是否启用邮箱验证码注册 | 否 |
| `PAGESAI_EMAIL_DOMAINS` | 邮箱注册域名白名单 | 否 |
| `PAGESAI_SESSION_TTL_MS` | 会话有效期（毫秒） | 否 |
| `PAGESAI_BOOTSTRAP_TOKEN` | 首名管理员一次性引导令牌 | **是** |
| `PAGESAI_CONFIG` | 工具读取的配置文件路径 | 否 |
| `PAGESAI_BACKUP_ROOT` | 备份输出目录 | 否 |
| `PAGESAI_MONGO_USER` / `PAGESAI_MONGO_HOST` / `PAGESAI_MONGO_DB` | 数据库连接标识 | 否 |
| `PAGESAI_MONGO_PASSWORD` | 数据库口令 | **是** |
| `PAGESAI_PAGES_DATA_FILE` / `PAGESAI_SURVEY_DATA_FILE` | 模块开发服务器落盘路径（仅本地开发） | 否 |

## 5. 工具用法与退出码

| 工具 | 主要参数 | 说明 |
| --- | --- | --- |
| `tools/init.js` | `--modules`、`--disk-variant`、`--registration`、`--data-root`、`--domain`、`--port`、`--email-domains`、`--config`、`--dry-run` | 生成 `config.json` 与数据根、部署标记、身份快照、迁移台账；打印访问地址与 Glim 连接状态占位 |
| `tools/upgrade.js` | `--step all\|check\|backup\|migrate\|verify`、`--backup-out`、`--skip-backup`、`--dry-run` | 固定顺序 check → backup → 幂等迁移 → verify；不兼容立即拒绝并给出恢复命令 |
| `tools/backup.js` | `--out`、`--label`、`--dry-run` | 数据库快照、各区域数据根、版本清单、秘密材料引用、逐文件哈希 |
| `tools/restore.js` | `--backup`、`--target-data-root`、`--verify-only`、`--replace-existing`、`--allow-orphans`、`--dry-run` | 用户归属 + 文件哈希 + 业务引用全部通过才算成功；默认保留旧数据 |
| `tools/uninstall.js` | `--purge`、`--keep-config`、`--yes`、`--dry-run` | 默认保留数据；`--purge` 先打印实际范围并二次确认 |

退出码：`0` 成功；`1` 参数/环境错误或用户取消；`2` 契约、数据根或校验失败（需人工处理）。
`tools/upgrade.js` 在模式不兼容时返回 `2`，且**不备份、不迁移、不修改文件**。

## 6. 备份与恢复的校验口径（方案 §9）

备份目录结构：

```text
pagesai-<UTC 时间>-<随机>/
  manifest.json          版本清单、区域树哈希、数据库树哈希、秘密材料引用
  config.snapshot.json   配置副本（不含秘密值）
  references.json        用户归属、区域 ↔ 配置键 ↔ 数据目录、迁移台账
  files.sha256           逐文件 sha256
  database/              数据库/状态目录快照
  data/<regionId>/       每个存储区域的完整数据根
```

恢复成功必须同时满足：

1. **用户归属**：按用户区域的一级目录必须能映射到 `database/identity.json` 中的用户名或用户 ID；无法映射的孤儿目录默认判定失败（`--allow-orphans` 才会保留）。
2. **文件哈希**：`files.sha256` 逐文件 sha256、`manifest.json` 的数据库树哈希与各区域树哈希全部一致；未登记文件视为失败。
3. **业务引用**：区域 ↔ 配置键 ↔ 数据目录一致；部署标识、配置副本、部署标记、迁移台账与版本互相一致；备份来自更新版本时拒绝恢复。

恢复过程先写 staging，校验通过才切换；目标数据根非空时必须 `--replace-existing`，旧数据整体改名保留（`<target>.pre-restore-<时间>`），**不删除**。恢复后生成 `<target>/state/config.restored.json`，需人工确认后替换正式配置。

## 7. 升级与回退

- 内置迁移：`0001` 部署标记与配置对齐、`0002` 身份冷启动快照、`0003` 存储区域目录、`0004` 迁移台账格式、`0005` 秘密材料引用。
- 迁移幂等：已应用迁移按签名跳过；签名与当前定义不符视为不兼容。
- 迁移失败：本次不写入台账，可直接重跑（幂等），或恢复升级前备份。
- 回退：代码回退必须配合备份恢复或已验证的逆向迁移；先 `tools/restore.js --verify-only`，再按提示执行。

## 8. 卸载

- 默认：写 `state/uninstall-record.json`，把 `config.json` 移入 `state/config.removed-<时间>.json` 保存，**保留全部数据**。
- `--purge`：先打印数据根、文件数、字节数与未登记内容，再交互式二次确认（非交互环境必须 `--yes`）；只删除数据根与生成的 `config.json`。
- 永不自动删除：秘密材料、外部数据库转储、客户端本地文件、已退出账号与设备撤销。

## 9. 已知缺口（不得当作已完成）

| 缺口 | 影响 |
| --- | --- |
| 公共身份以 MongoDB 为权威 | `state/identity.json` 是服务在启动与每次身份变更时导出的快照；离线备份/恢复的用户归属校验依赖它，在线用户仍以数据库为准 |
| `database.engine=mongodb` 时不会自动 `mongodump` | 需运维把数据库转储放入备份目录的 `database/`，否则备份只覆盖状态目录 |
| Glim 连接状态是占位 | 真实授权由服务在运行期更新为 `pending` / `connected` |
| 旧 `/data` 根不自动迁移 | 旧数据需显式迁移与哈希校验；工具拒绝隐式换根 |
| 工具不启停服务 | 初始化/升级/恢复只处理配置与数据，不操作进程、端口或编排 |
| 备份完整性采用 sha256 校验，未做数字签名 | 能发现无意的损坏与不一致；防篡改需在传输/静态存储层加密或签名 |
| `docs/guides/backup-restore.md` 仍写着「目标恢复流程（未实现）」 | 该文档由文档负责方更新为 `tools/restore.js` 的实际流程 |

## 10. 自检命令

```bash
# JSON 语法
python3 -c "import json;json.load(open('config/config.schema.json'))"
python3 -c "import json;json.load(open('contracts/storage-region.schema.json'))"

# 工具帮助与干跑（均不写盘）
node tools/init.js --help
node tools/upgrade.js --help
node tools/backup.js --help
node tools/restore.js --help
node tools/uninstall.js --help

# 用临时数据根做一次完整演练（不触碰生产）
node tools/init.js --data-root /tmp/pagesai-drill/data --config /tmp/pagesai-drill/config.json --modules all --dry-run
```
