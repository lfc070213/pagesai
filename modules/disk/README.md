# Disk 模块（单逻辑盘）

PagesAI 公开版 · 方案 §6.1 / §6.2 / §6.3 / §7.2 · 任务 C14。

本模块交付**一个逻辑盘**：MongoDB 元数据 + 核心 ContentStore 文件修订、网页控制台、分块上传与续传、Range 下载、稳定 `fileId` + 修订、软删/恢复、只读分享和按用户配额。不包含盘号、跨盘复制、双数据根、数据根切换、校园网络分流；客户端与同步引擎属于 C15–C19。

```text
modules/disk/
  manifest.json          模块清单（contracts/module-manifest.schema.json）
  config.schema.json     配置 schema
  server/index.js        统一模块接口：start/stop/health/routes/tools
  server/platform.js     正式数据面：MongoDB 仓库 + ContentStore 适配
  server/dev.js          仅在无 Mongo 时使用的本地 JsonStore 开发服务
  web/index.html         网盘网页（/disk）
  web/app.js   app.css   同源网页脚本与样式
  sync/                  Rust 双向同步引擎、HTTP 客户端与 CLI（C16–C19）
  client/src-tauri/      Tauri 2 桌面壳与系统凭据
  client/ui/             桌面同步设置界面
  tests/*.test.js        node:test；平台测试含 gated 真实 Mongo 验收
```

同步协议、冲突规则、游标/墓碑、设备配对、通用/北大策略和桌面壳说明见
[`docs/disk-sync.md`](../../docs/disk-sync.md)。

## 1. 两种装配

| 装配 | 触发条件 | 数据面 |
| --- | --- | --- |
| 正式（生产/干净安装） | 宿主注入 `runtime.db` 且提供核心 `fileAdapter` | MongoDB（`disk_files`/`disk_uploads`/`disk_shares`）+ ContentStore；文件正文永不进 MongoDB |
| 开发回退 | 未注入 Mongo，运行 `server/dev.js` 或旧测试 | `core/storage/json-store.js` 单文件 JSON；仅用于本机联调和契约测试 |

正式装配下，区域固定为 `disk.user-files`；物理根来自 `storage.disk.root`，由核心统一登记，模块不接受客户端提供的任何宿主路径。安装/卸载 Disk 不移动任何区域的数据。

## 2. 清单与配置

- `id: disk`，`activation.routePrefix: /api/disk`，`activation.serverEntry: server/index.js`
- `data.namespace: disk`，`data.regions: ["disk.user-files"]`
- `capabilities.tools: []`（C21 授权模型落地前不登记未实现工具）

```json
{
  "regions": ["disk.user-files"],
  "quotaBytes": 1073741824,
  "chunkSizeBytes": 5242880,
  "maxChunkBytes": 67108864,
  "maxFileBytes": 0,
  "uploadTtlMs": 86400000,
  "share": { "defaultTtlSeconds": 86400, "maxTtlSeconds": 2592000 },
  "storageAdapter": "json"
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `regions` | `["disk.user-files"]` | 唯一合法区域；其他值启动失败 |
| `quotaBytes` | 1 GiB | 每用户逻辑字节配额；核心在 `beginUpload` 原子预留 |
| `chunkSizeBytes` | 5 MiB | 建议分块；客户端可不按此切分，但必须顺序写入 |
| `maxChunkBytes` | 64 MiB | 单块解码后上限，必须 ≥ `chunkSizeBytes` |
| `maxFileBytes` | `0` | 单文件上限；`0` 表示与 `quotaBytes` 相同 |
| `uploadTtlMs` | 24 h | 未完成上传的回收阈值（仅清理 `uploading`，提交中的任务保留待恢复） |
| `share.defaultTtlSeconds` / `share.maxTtlSeconds` | 1 天 / 30 天 | 分享有效期策略 |
| `dataFile` / `storageAdapter` | `null` / `json` | **仅开发回退**使用；正式装配忽略 |

## 3. 数据模型

### 3.1 MongoDB（正式）

| 集合 | 内容 |
| --- | --- |
| `disk_files` | 文件索引：`fileId`、`ownerId`、`name`、`mimeType`、`size`、`revision`、`status(active/deleted)`、`contentHash`、时间戳 |
| `disk_uploads` | 上传任务：`uploadId`、`fileId`、声明大小/哈希、`baseRevision`、状态与完成结果 |
| `disk_shares` | 分享：`shareId`、`fileId`、`ownerId`、`tokenHash`、`readOnly`、`expiresAt`、`revokedAt` |
| `runtime_metadata {_id:'disk'}` | 数据模式版本与 `deploymentId`；缺失时只有显式初始化才允许登记 |

文件正文与历史修订由 ContentStore 管理（`storage_files`、`storage_file_revisions`、`storage_file_events` 等），布局为 `<区域根>/<用户>/.pagesai-content/<fileId>/r<revision>-<sha256>`。提交在 Mongo 事务中完成；崩溃恢复由核心 `content.recover()` 在模块启动前执行。

### 3.2 开发回退（JsonStore）

集合 `files`/`uploads`/`chunks`/`blobs`/`shares`/`shareTokens`/`operations`；内容以 base64 内联。只适合小文件和单进程联调。

## 4. API

所有路由以 `/api/disk/` 开头；错误统一 `{ code, message, details? }`。下载路由同时支持 `Range` 与 `HEAD`。

### 4.1 读取

| 方法与路径 | 认证 | 说明 |
| --- | --- | --- |
| `GET /api/disk/health` | 公开 | `{ok,module,storage,regions}` |
| `GET /api/disk/info` | 公开 | 版本、区域、分块/配额上限 |
| `GET /api/disk/quota` | 用户 | `usedBytes/reservedBytes/remainingBytes/fileCount` |
| `GET /api/disk/files` | 用户 | 当前用户列表；`?includeDeleted=1` 含软删 |
| `GET /api/disk/files/:fileId` | 所有者 | 文件元数据 |
| `GET /api/disk/files/:fileId/content` `/download` | 所有者 | 内容；支持 Range |
| `GET /api/disk/uploads/:uploadId` | 所有者 | 上传进度与 `nextOffset` |
| `GET /api/disk/files/:fileId/shares` | 所有者 | 分享列表（不含令牌） |
| `GET /api/disk/shares/:token` | 公开 | 分享元数据 |
| `GET /api/disk/shares/:token/content` | 公开 | 分享内容；支持 Range |

### 4.2 写入（未认证一律 `403`）

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/disk/uploads/init` | `{name,size,sha256,mimeType?,fileId?,baseRevision?,operationId?}`；声明大小与整文件哈希是必填 |
| `PUT /api/disk/uploads/:uploadId/chunks/:index/data` | 原始二进制分块（推荐） |
| `PUT/POST /api/disk/uploads/:uploadId/chunks/:index` | JSON 分块：`{data,sha256?}`、`{base64}`、`{text}` |
| `POST /api/disk/uploads/:uploadId/complete` | 提交；缺块 `400`，修订冲突 `409` |
| `DELETE /api/disk/uploads/:uploadId` | 取消并释放预留配额 |
| `DELETE /api/disk/files/:fileId` / `POST .../delete` | 软删 |
| `POST /api/disk/files/:fileId/restore` | 恢复 |
| `POST /api/disk/files/:fileId/shares` | 创建只读分享；`{expiresInSeconds? \| expiresAt?}` |
| `DELETE /api/disk/shares/:shareId` | 撤销（幂等） |

### 4.3 认证

`ctx.user = {id, username?}` 来自核心会话；`id` 是隔离与所有权唯一依据。公开分享路由不要求登录；`token` 也可由 `x-share-token` 或 `Authorization: Share <token>` 提供。

## 5. 语义

- **修订**：新文件 `revision=1`；覆盖必须带当前 `baseRevision`，不匹配 `409 REVISION_CONFLICT`，绝不默认最后写入覆盖。历史修订可读。
- **幂等**：`operationId` 同时决定 `uploadId` 与新建文件的 `fileId`；同一操作重放返回同一上传/文件。同一 ID 用于不同声明 `409 OPERATION_CONFLICT`。
- **大小与哈希**：init 必须声明 `size` 与 sha256；提交阶段 ContentStore 复核大小与整文件哈希，失败 `500 HASH_MISMATCH` 且不产生文件。
- **续传**：分块必须严格顺序（`index === receivedChunks`，偏移由服务端校验）。中断后 `GET upload` 读取 `nextOffset` 继续。
- **软删**：只改 `status`，不调用 ContentStore 删除，内容与逻辑字节保留，恢复无需重传。删除文件不能覆盖或创建分享（`409 FILE_DELETED`）；所有者仍可下载核对。
- **分享**：32 字节随机令牌只返回一次，服务端只存 sha256；只读、可过期/撤销。过期/撤销/删除后公开读取 `410`，恢复后未过期未撤销的令牌重新可用。
- **配额**：`logical-bytes / per-user`，按当前修订计（覆盖不累加旧修订），软删仍计入。`beginUpload` 原子预留；取消/失败释放；超限 `413 QUOTA_EXCEEDED`。
- **区域**：只暴露 `disk.user-files`；模块不扫描宿主目录，不使用客户端提供的物理路径。

## 6. 网页控制台

核心在模块启用后提供同源静态页：

- `/disk`（及 `/disk/`）：网盘页面；`/disk-app.js`、`/disk-app.css` 为脚本与样式，均带严格 CSP 与 `nosniff`。
- 登录/注册使用 `/api/auth/*` 的 HttpOnly 会话 Cookie，不使用开发身份头。
- 页面支持拖放/多选上传、浏览器端 SHA-256、二进制分块、断点“继续上传”、取消、文件详情、下载、新版本（带 `baseRevision`）、软删/恢复、分享创建/撤销，以及 `#share=<token>` 公开只读视图。
- 浏览端计算整文件哈希需要相应内存；超大文件的原生客户端在 C15–C19。

## 7. 本地运行与测试

```bash
cd source/site/public-release/pagesai

# 只有开发回退：JsonStore 单文件服务
node modules/disk/server/dev.js --data-file /tmp/pagesai-disk.json

# 单元/契约测试（不连数据库）
node --test modules/disk/tests/*.test.js

# 正式数据面（gated，需仓库外 mongodb-memory-server）
NODE_PATH=/tmp/pagesai-mongo-build/node_modules \
PAGESAI_MONGO_TEST=1 MONGOMS_DOWNLOAD_DIR=/tmp/pagesai-mongo-build/binaries \
node --test modules/disk/tests/platform-mongo.test.js \
  tests/integration/disk-clean-install.test.js
```

`disk-clean-install` 在仓库外临时目录安装“核心 + Disk”，通过真实 HTTP 完成：网页/CSP、注册登录、>5 MiB 分块上传、Range/416、覆盖修订冲突、软删/恢复、公开分享/撤销、跨用户 403、取消释放配额，以及重启后内容与修订仍在。

## 8. 已知缺口（不得宣称已完成）

- Windows/macOS 客户端、设备配对、双向同步与冲突副本：C15–C19。
- Disk 的 Glim 工具与逐次授权/审计：C21–C22。
- 永久删除、回收站保留期与后台清理策略：未实现；软删文件持续计入配额。
- 对象存储适配器不在本阶段范围；正式路径固定为 ContentStore 本地文件根。
- 浏览器端整文件哈希需要内存；大文件客户端与流式哈希由桌面客户端承担。
- 内容审核、病毒扫描、加密存储、缩略图/转码不在本模块范围。
