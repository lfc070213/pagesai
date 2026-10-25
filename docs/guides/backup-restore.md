# 备份与恢复

备份的对象是**数据与配置**，不是进程。恢复的验收标准是「用户归属、文件哈希、业务引用一致」，不是「进程能启动」。

> **现状**：`database.engine=mongodb` 时，用户、会话、验证码与存储区域/修订/变更事件都在 MongoDB；`state/identity.json` 只是身份导出快照，在线恢复仍以数据库为准。**模块**的数据通过各自的 `dataFile` 落在磁盘上，原件/附件在独立目录。因此备份必须同时覆盖：MongoDB 业务集合（由运维转储）、模块数据文件、原件/附件目录、配置与秘密材料。`tools/backup.js` 只快照 `stateDir` 与数据根，不能直接导出外部数据库。

## 1. 当前各模块的持久化位置

| 模块 | 元数据（`dataFile`） | 文件内容 | 纯内存时 |
| --- | --- | --- | --- |
| Pages | `pages.json`：`sites` / `slugs` / `aiRuns` | 站点文件内容内联在 JSON 中 | 重启清空 |
| Disk | `disk.json`：`files` / `uploads` / `chunks` / `blobs` / `shares` / `shareTokens` / `operations` | 文件内容内联在 JSON 中 | 重启清空 |
| Glim | `glim.json`：会话、消息、记忆、connectors、授权 | — | 重启清空 |
| Mail | `mail.json`：`outbox` / `idempotency` / `verification` / `mailbox_index` | 邮件正文索引（不含 Maildir 原件） | 重启清空 |
| Survey | `survey.json`：问卷、快照、答卷 | `attachments/<surveyId>/<responseId>/` | 重启清空（附件需 `dataFile`） |
| Paper | `paper.json`：`docs` / `jobs` / `translations` | `uploadsDir/<ownerKey>/<docId>.<ext>` | 重启清空且不落原件 |

核心侧：

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| 用户、会话、验证码 | MongoDB（`identity_users`、`identity_sessions` 等） | 由数据库转储覆盖；`state/identity.json` 仅为导出快照，不能代替数据库 |
| 区域登记、修订、变更日志 | MongoDB（`storage_regions`、`storage_file_revisions`、`storage_file_events`） | 由数据库转储覆盖；文件版 `PersistentStorageRegistry` 仅用于离线导入导出 |
| 部署配置 | 部署者维护 | 与代码版本一起记录 |
| 秘密 | 环境变量/密钥文件 | **独立保护**，不进备份数据包 |

## 2. 目标备份范围

| 类别 | 内容 | 一致性要求 |
| --- | --- | --- |
| 模块元数据 | 六个 `dataFile` | 与文件目录同一时间点 |
| 文件内容 | `uploadsDir`、`attachments/` | 停写或快照 |
| 核心持久化 | MongoDB 业务集合（或文件版 `PersistentStorageRegistry` 状态文件） | 与数据库/文件同批 |
| 配置 | 模块选择、非秘密配置、区域登记 | 与代码版本对应 |
| 秘密材料 | 引导令牌、模型/SMTP/IMAP 密钥 | **独立加密保护** |
| 版本清单 | 核心/模块版本、持久化格式版本、镜像 digest | 与备份同批 |

## 3. 可执行示例（用 `/tmp` 演示，替换成真实目录）

```bash
DEMO=/tmp/pagesai-backup-demo
rm -rf "$DEMO" && mkdir -p "$DEMO/data" "$DEMO/attachments"
printf '%s' '{"sites":{},"slugs":{},"aiRuns":{}}' > "$DEMO/data/pages.json"

# 1) 先校验 JSON 可解析（损坏文件模块会拒绝启动）
python3 -c 'import json,sys;json.load(open(sys.argv[1]));print("JSON 可解析")' "$DEMO/data/pages.json"

# 2) 数据文件与文件目录一起打包
tar -czf "$DEMO/pages-backup.tgz" -C "$DEMO" data attachments

# 3) 记录校验值
shasum -a 256 "$DEMO/pages-backup.tgz"    # macOS
# sha256sum "$DEMO/pages-backup.tgz"      # Linux
```

核心持久化状态文件（若使用）额外检查格式版本：

```bash
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print("formatVersion",d["formatVersion"])' /srv/pagesai/state/storage.json
```

预期：`formatVersion 1`；不支持或损坏时 `PersistentStorageRegistry` 拒绝加载，不静默重建。

## 4. 备份顺序（目标态）

1. 进入维护状态：停止新任务、暂停客户端同步（不是删除映射）。
2. 记录版本清单与数据根路径。
3. 备份数据库/模块元数据（同一时间点）。
4. 备份文件目录（`uploadsDir`、`attachments/`）。
5. 单独备份秘密材料（不同介质、不同密钥）。
6. 计算哈希并写入清单。
7. 校验备份可读：随机抽文件比对哈希、解析 JSON。
8. 解除维护状态。

## 5. 恢复流程

1. **隔离环境**：在独立目录与新数据库恢复，不直接覆盖生产。
2. **恢复秘密**：先放回受保护位置并确认权限（`0600`，属主为运行用户）。
3. **恢复元数据**：JSON 必须可解析；格式不支持时停止，不要删文件重建。
4. **恢复文件目录**：按备份中的相对结构还原；`uploadsDir` 与 `dataFile` 必须对应同一部署。
5. **校验**：逐模块抽查文件存在性、大小与内容哈希；核对所有权与业务引用（站点、论文、问卷附件）。
6. **启动**：先 `dev.js` 冒烟，再装进核心；确认健康检查通过。
7. **客户端**：恢复后同步应暂停并要求对账；**不得**因远端为空触发本地批量删除。
8. **切换**：验证通过后再切流量。

## 6. 硬性规则

- 停用/卸载默认保留数据；永久删除是独立操作，执行前列出实际范围。
- 移除同步映射、退出账号或撤销设备**不得**删除本地文件。
- 秘密与用户数据分开存放；备份包不得含明文密钥。
- 备份文件权限最小化；传输与静态存储均加密。
- 不把生产数据库、Maildir、上传目录复制进公开版仓库；演示数据必须虚构。
- 恢复后要校验业务引用，不能只看「进程能启动」。

## 7. 检查清单

- [ ] 六个模块的 `dataFile` 与对应文件目录都在备份范围内。
- [ ] 核心持久化状态文件（若使用）的 `formatVersion` 已记录。
- [ ] 秘密材料单独保护，未进入数据包或代码库。
- [ ] 恢复后文件哈希与业务引用一致（抽查样本有记录）。
- [ ] 恢复后客户端不会自动删除本地文件。
- [ ] 恢复演练至少成功一次，并记录耗时与失败项。

## 8. 已知缺口

| ID | 与本篇相关的影响 |
| --- | --- |
| K1 | ~~核心身份在内存~~（已关闭）：MongoDB 为权威，`state/identity.json` 仅作归属校验快照 |
| K2 | ~~核心未接入持久化存储~~（已关闭）：区域、修订与变更事件在 `storage_*` 集合；备份工具不直接转储 MongoDB |
| K5 | **部分**：`tools/backup.js` 与 `tools/restore.js` 已实现并通过演练（C33）；外部数据库转储需运维或宿主机容器运行时 |
| K14 | **部分**：Disk 已有统一 `fileId`；跨模块统一文件标识仍未接入，恢复后需按业务引用抽查 |
| K6 | 无用量统计，无法对比恢复前后容量 |

完整清单与来源见 [`docs/README.md`](../README.md#已知缺口清单)。