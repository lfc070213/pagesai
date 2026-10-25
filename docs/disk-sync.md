# Disk 双向同步协议与客户端

本文件对应施工方案 C15–C19。它只描述公开版 `modules/disk` 的实现与验证方式；真实域名、证书、签名材料由部署者提供。

## 1. 边界

- 服务端权威数据：MongoDB 元数据 + 核心 ContentStore 修订。文件正文不进入 MongoDB。
- 同步单位是“本机选定目录 ↔ 云端用户文件树”，不是整块设备或多块盘。
- 通用制品不包含校园探测/分流；北大版通过独立 Cargo feature 实现可配置的传输路径切换。
- 两种策略使用同一个服务实例、同一个用户、同一套 `fileId`/修订/游标；切换路径不产生第二份数据。

```text
modules/disk/
  server/                 同步协议、文件夹、设备配对（Mongo + ContentStore）
  sync/                   Rust 同步引擎、HTTP 客户端、CLI、离线测试
    src/strategy.rs       通用/北大策略（编译期选择）
    src/engine.rs         首次对账、增量、冲突、删除传播、待处理重放
    src/state.rs          原子 JSON 状态库 + 进程锁 + 备份回退
    src/path_rules.rs     Windows/macOS/Unix 路径语义
  client/src-tauri/       Tauri 2 桌面壳（系统凭据、设置、后台同步）
  client/ui/              桌面界面
```

## 2. 服务端协议

所有端点位于模块前缀 `/api/disk`，认证方式二选一：

- 网页会话：现有用户会话；
- 设备令牌：`Authorization: Bearer <token>`，只用于同步/文件/文件夹接口。

设备令牌在配对时生成 32 字节随机值，服务端只保存 `sha256`，撤销后立即失效。

### 2.1 文件夹

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/folders?parentId=` | 列出当前用户文件夹 |
| POST | `/folders` | 创建；`operationId` 决定 `folderId`，重放幂等 |
| PATCH | `/folders/:folderId` | 改名/移动；必须带 `baseRevision` |
| DELETE | `/folders/:folderId` | 递归软删后代文件夹与文件；必须带 `baseRevision` |
| POST | `/folders/:folderId/restore` | 恢复；父文件夹必须可用 |

约束：同级名称唯一、路径段不含分隔符/控制字符、禁止移动到自身或后代、`baseRevision` 不匹配返回 `409 REVISION_CONFLICT`。

### 2.2 同步

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/sync/state` | `{ epoch, seq, prunedThrough, historyLimit }` |
| GET | `/sync/changes?cursor=&limit=` | 按 `syncSeq` 排序的增量；`limit` 1–1000 |
| GET | `/sync/tree` | 当前用户完整活动树（文件夹 + 文件） |

- 每个用户有独立单调递增 `syncSeq`；文件、文件夹、删除墓碑都占用序号。
- 软删文档保留 `status=deleted` 与 `syncSeq`，所以增量能表达删除。
- `cursor < prunedThrough`、`cursor > seq` 或游标格式非法返回 `410`（`SYNC_CURSOR_EXPIRED` / `SYNC_CURSOR_INVALID`）；纪元不一致返回 `410 SYNC_EPOCH_MISMATCH`。客户端必须转为全量对账，不能把 `410` 当作删除。
- 保留上限由 `syncHistoryLimit` 控制。默认 100000，最少 1。它是“历史窗口”，不是文件配额。

### 2.3 设备与配对

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/devices/pairing-codes` | 生成一次性配对码（9 字节随机，10 分钟有效） |
| POST | `/devices/pair` | 用配对码换取设备令牌；令牌只返回一次 |
| GET | `/devices` | 列出本人设备（不含令牌） |
| DELETE | `/devices/:deviceId` | 撤销；幂等 |

配对码只保存哈希；同一配对码并发使用由 MongoDB 事务保证只有一个成功。设备令牌不能绕过用户归属：所有文件/文件夹操作仍按设备所属 `ownerId` 校验。

### 2.4 条件写入

- 覆盖已有文件：`uploads/init` 必须带 `fileId` 与 `baseRevision`，不匹配立即 `409`。
- 重命名/移动：`PATCH /files/:fileId` 必须带 `baseRevision`。
- 删除/恢复：同样必须带 `baseRevision`。
- 同一 `operationId` 的重放返回同一 `uploadId`/`fileId`；服务端按顺序接收分块，客户端重连后先查询 `GET /uploads/:uploadId` 的 `receivedChunks`/`nextOffset` 再续传。
- 提交与文件登记在同一 MongoDB 事务内完成，并分配 `syncSeq`。

## 3. 同步引擎

### 3.1 状态

`<同步目录>/.pagesai/`：

| 文件 | 说明 |
| --- | --- |
| `state.json` | 设备 ID、纪元、游标、文件/文件夹映射、待处理操作 |
| `state.json.bak` | 上一版本；主文件损坏时回退 |
| `engine.lock` | 独占锁，防止两个进程同时写同一目录 |

写入采用临时文件 + `fsync` + 原子 rename；保留备份。切换设备（配对到另一个账号）时，旧游标与映射被丢弃，本地文件保留并重新首次对账，避免把旧账号文件误判为远端删除。

### 3.2 一轮同步

1. 重放上次未完成的待处理操作（上传/建文件夹/改名/删除）。上传使用原 `operationId`，服务端可续传。
2. 读取远端 `state`。首次同步、纪元变化或游标早于 `prunedThrough` 时执行全量对账；否则拉取增量直到 `hasMore=false`。
3. 扫描本地：跳过 `.pagesai`、符号链接和特殊文件；检测大小写/Unicode 冲突。
4. 推送本地新文件夹、新文件、内容变化；通过内容哈希识别改名/移动，改用 `PATCH` 保留文件身份与修订。
5. 只有在扫描完整时传播本地删除；任何目录不可读、哈希失败、大小写冲突都会把本轮标记为“不完整”，禁止批量删除。
6. 保存游标与状态。

### 3.3 冲突规则

| 情形 | 处理 |
| --- | --- |
| 仅本地变化 | 条件上传，修订 +1 |
| 仅远端变化 | 下载到临时文件，校验大小与 SHA-256 后原子替换 |
| 两端都改 | 本地内容改名为 `<名称> (conflict <设备> <UTC时间>)[-n]`，再下载远端版本 |
| 远端删除、本地未改 | 删除本地文件 |
| 远端删除、本地已改 | 保留本地为冲突副本，再应用远端删除 |
| 本地删除、远端已改 | 不删远端；远端版本重新下载 |
| 首次对账同名不同内容 | 保留本地冲突副本，采用远端版本 |

下载失败、校验失败、断网、令牌撤销、模块停用、盘未挂载都不会被解释成删除。

## 4. 路径语义

`PathRules` 覆盖：

- 空段、`.`/`..`、绝对路径、`/` 与 `\` 混用；
- Windows 非法字符、结尾空格/点、保留设备名（`CON`、`PRN`、`AUX`、`NUL`、`COM1`–`COM9`、`LPT1`–`LPT9`）、单段 255 UTF-16；
- 长路径添加 `\\?\` 前缀（仅 Windows）；
- 大小写不敏感文件系统的大小写/Unicode 冲突检测；
- 符号链接/reparse point 跳过，不跟随。

## 5. 通用版与北大版

```bash
# 通用版（默认）
cargo build --release --offline

# 北大版
cargo build --release --offline --no-default-features --features pku
```

- 通用版：`strategy::selected().includes_campus() == false`，配置校园端点会直接报错；制品中不编译校园实现。
- 北大版：可配置一个校园端点，按“直连 → 校园链路”顺序做可重试故障转移。两条链路共享同一设备令牌与同一服务端数据；同步纪元/游标来自同一实例。
- 同时启用两个 feature 会触发 `compile_error!`，防止制品含糊。

## 6. 命令行客户端

`pagesai-disk-sync` 是桌面壳和自动化共用的协议入口：

```bash
# 配对（服务地址必须 HTTPS，回环地址例外）
pagesai-disk-sync pair --service https://disk.example.com --code <配对码> \
  --name "我的笔记本" --root "$HOME/PagesAI Disk"

# 同步一次（输出 JSON 报告；有错误时退出码 1）
pagesai-disk-sync sync

# 查看本地状态
pagesai-disk-sync status

# 撤销设备并清理本地状态（保留用户文件）
pagesai-disk-sync unpair
```

凭据默认位于 `~/.pagesai-disk/credentials.json`（Unix 权限 0600），可用 `--credentials` 或 `PAGESAI_DISK_CREDENTIALS` 指定；`PAGESAI_DISK_TOKEN` 可覆盖令牌。桌面壳不写凭据文件，令牌进入系统凭据库。

## 7. 桌面壳

`client/src-tauri`：

- 部署者填写服务地址；制品不内置域名；
- 配对码换设备令牌，令牌写入 macOS Keychain / Windows Credential Manager / Secret Service；
- 设置页面：同步目录、自动同步间隔、启动同步、开机自启动、校园端点（仅北大版）；
- 后台按间隔同步，事件 `sync://report` / `sync://error` 推送到界面；
- 解除配对先调用服务端撤销，再删除系统凭据，本地文件与同步目录保留；
- 已配对时切换账号必须先解除配对，避免旧设备令牌残留；
- 拒绝把整个用户主目录或文件系统根作为同步目录。

未完成的外部条件：更新源与签名公钥必须由部署者提供；当前 `tauri.conf.json` 中的 `updates.example.invalid` 与 `REPLACE_WITH_DEPLOYER_UPDATER_PUBLIC_KEY` 是占位值，未配置前不应把更新链当作可信发布。Windows/macOS 真机安装、代码签名与公证同样需要外部资源。

## 8. 验证

```bash
# 引擎离线测试（含通用/北大两种编译）
CARGO_TARGET_DIR=/tmp/pagesai-disk-sync-target cargo test --offline
CARGO_TARGET_DIR=/tmp/pagesai-disk-sync-target cargo test --offline --no-default-features --features pku

# 桌面壳编译
cd client/src-tauri
CARGO_TARGET_DIR=/tmp/pagesai-disk-client-target cargo check --offline
CARGO_TARGET_DIR=/tmp/pagesai-disk-client-target cargo check --offline --no-default-features --features pku

# 服务端协议（需要临时副本集，见 tests/platform-sync-mongo.test.js）
NODE_PATH=/tmp/pagesai-mongo-build/node_modules PAGESAI_MONGO_TEST=1 \
MONGOMS_DOWNLOAD_DIR=/tmp/pagesai-mongo-build/binaries \
node --test modules/disk/tests/platform-sync-mongo.test.js
```

离线引擎测试覆盖：首次对账、增删改名、文件夹改名、两端冲突、游标过期、断网不删除、崩溃后待处理重放、远端删除、Windows 保留名、端点故障转移。服务端测试覆盖：文件夹树/幂等/移动/CAS/环检测、增量顺序/墓碑/跨用户隔离、递归删除、游标保留与过期、配对/令牌访问/撤销/过期。
