# Disk 模块

> **状态（C14–C19 完成）：** 网盘网页、正式 MongoDB + ContentStore 数据面、分块续传、Range、修订、软删/恢复、只读分享、配额与单区域视图可用；**Windows/macOS 桌面客户端、双向同步引擎与 Tauri 壳已实现**（`modules/disk/sync`、`modules/disk/client`，24 个 Rust 用例）。真实设备安装、代码签名/公证与校园链路验收仍未完成（K9/C39）。模块细节与 API 以 [`modules/disk/README.md`](../../modules/disk/README.md) 为准。

## 1. 定位与边界

Disk 把已登记存储区域组成**一个逻辑盘**，提供文件数据面、网页控制台与只读分享。

- 只有一个逻辑盘：无盘号、无跨盘复制、无双数据根、无数据根切换 UI。
- 正式区域固定 `disk.user-files`；物理根由核心 `StorageRegistry` 登记，模块不接受客户端宿主路径。
- 文件正文只在 ContentStore；MongoDB 只保存索引、修订引用与分享哈希。
- 网络策略中性：无校园探测、校内域名判定或链路分流。
- 非目标：设备盘代理、Maildir/缓存暴露、永久删除与回收站保留期。

## 2. 运行时依赖

| 能力 | 依赖 |
| --- | --- |
| 元数据 | MongoDB：`disk_files`、`disk_uploads`、`disk_shares`、`runtime_metadata {_id:'disk'}` |
| 文件内容与修订 | 核心 ContentStore（`storage_files`/`storage_file_revisions`）；区域根 `<dataRoot>/disk` |
| 认证 | 核心会话 Cookie（HttpOnly）；`ctx.user.id` 是所有权唯一依据 |
| 网页 | 核心同源静态服务 `/disk`、`/disk-app.js`、`/disk-app.css` |
| 开发回退 | `server/dev.js` + JsonStore；只用于无 Mongo 的本机联调 |

正式装配由 `ModuleHost.startContext` 注入 `runtime.db`、`deploymentId`、`initialize` 与核心 `fileAdapter`；缺失时回退旧数据面并记录日志。

## 3. 单装步骤

```bash
cd source/site/public-release/pagesai
node tools/init.js --data-root /srv/pagesai-data --modules disk \
  --install-root /opt/pagesai --config /opt/pagesai/config.json
```

随后由运行入口读取该 `config.json` 并调用 `core/runtime.js` 的 `startRuntime({configPath, env, port})`（正式进程入口与服务化属于 C30）。当前可用 `tests/integration/disk-clean-install.test.js` 在仓库外临时安装中完成同一装配并验收。

启动后：

- `GET /api/disk/health` → `{ok:true, storage:'mongodb+content-store', regions:['disk.user-files']}`
- 浏览器打开 `/disk`，使用核心账号登录。
- 未安装 Disk 时 `/disk` 不提供静态页，`/api/disk/**` 不挂载。

### 3.1 上传流程（正式）

1. `POST /api/disk/uploads/init`：必须声明 `name`、`size`、`sha256`；覆盖时加 `fileId` 与当前 `baseRevision`。可用 `operationId` 重放续传。
2. `PUT /api/disk/uploads/:uploadId/chunks/:index/data`：原始二进制分块，严格顺序；服务端返回 `nextOffset`。
3. `GET /api/disk/uploads/:uploadId`：断线后读取进度并继续。
4. `POST /api/disk/uploads/:uploadId/complete`：ContentStore 复核大小与整文件哈希并事务提交。
5. `DELETE /api/disk/uploads/:uploadId`：取消并释放预留配额。

### 3.2 安装检查清单

- [ ] 未认证读 `401`、写 `403`；跨用户文件/上传/分享 `403`。
- [ ] 文件 > 5 MiB（多分块）可上传、下载、Range 与断点续传。
- [ ] 覆盖必须带正确 `baseRevision`；过期修订 `409` 且不覆盖新内容。
- [ ] 重复 `complete` 幂等；重复 `operationId` 不产生第二份文件。
- [ ] 软删后列表隐藏、配额不变、所有者可下载、分享 `410`；恢复后分享复活。
- [ ] 分享令牌只在创建时返回，服务端只存哈希；过期/撤销 `410`。
- [ ] 重启后文件、修订、分享与会话仍在。
- [ ] `/disk` 页面使用同源 Cookie 会话，不含开发身份头；CSP 生效。

## 4. 路由摘要

公开：`GET /api/disk/health`、`GET /api/disk/info`、`GET /api/disk/shares/:token`、`GET /api/disk/shares/:token/content`。

用户：`GET /api/disk/files`、`GET /api/disk/quota`、`GET /api/disk/regions`、上传四步、`GET/DELETE /api/disk/files/:fileId`、`GET .../content`、`POST .../restore`、分享创建/列表/撤销。

完整字段、语义与配置见模块 README。

## 5. 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `regions` | `["disk.user-files"]` | 唯一合法区域 |
| `quotaBytes` | 1 GiB | 每用户逻辑字节；核心原子预留 |
| `chunkSizeBytes` | 5 MiB | 建议分块 |
| `maxChunkBytes` | 64 MiB | 单块上限 |
| `maxFileBytes` | 0 | 0 = 沿用配额 |
| `uploadTtlMs` | 24 h | 仅清理 `uploading`；`committing` 保留待恢复 |
| `share.defaultTtlSeconds` / `maxTtlSeconds` | 1 天 / 30 天 | 分享策略 |

## 6. 与 Glim 的连接

当前 `capabilities.tools = []`，Glim 无法调用 Disk。C21 落地后计划提供 `disk_list_files`、`disk_read_file`、`disk_write_file`、`disk_delete_file`、`disk_create_share`，只信任 `ctx.user`；删除/分享逐次授权并审计，撤销后下一轮立即失败。

## 7. 故障与卸载

| 场景 | 行为 |
| --- | --- |
| 未登记区域 | `404` |
| 未认证 | 读 `401`，写 `403` |
| 声明大小/hash 缺失 | `400` |
| 配额不足 | `413 QUOTA_EXCEEDED` |
| 单文件超限 | `413 FILE_TOO_LARGE` |
| 修订冲突 | `409 REVISION_CONFLICT`，保留当前修订 |
| 缺块/乱序分块 | `400 MISSING_CHUNKS` / `409 CHUNK_ORDER` |
| 分享过期/撤销/文件删除 | `410` |
| 停用 | `stop()` 保留全部数据 |
| 卸载 | 默认保留区域数据；客户端同步映射不因卸载删除 |

## 8. 已知缺口

| ID | 缺口 |
| --- | --- |
| K9 | **部分**：Windows/macOS 客户端（Tauri 2）与双向同步引擎已实现，引擎用例 24/24；安装包签名/公证、真实设备同步与校园链路验收缺材料（C39） |
| K6 | 无跨模块配额汇总 |
| K13 | 未在网页中呈现其他模块的区域视图（按设计，Disk 只暴露声明区域） |
| — | 无永久删除/回收站保留期；软删文件持续计入配额 |
| — | 对象存储适配器不在本阶段范围 |
| — | 浏览器整文件哈希需内存；大文件由桌面客户端承担 |

完整任务清单见施工方案 C14–C19 与 [`docs/README.md`](../README.md)。
