# C03 运行时公共契约 v1

状态：目标契约已冻结，正式实现未完成的字段不得被解释成“已可用”。实现任务为 C04–C09、C11、C16；变更必填语义须提升版本并同时更新适配器与测试。

## 1. 异步持久化适配器

正式 app 只依赖异步接口。所有方法返回 Promise；不在接口中暴露同步 `Map`、数组引用或文件描述符。跨记录写入由适配器事务保证，调用方不能通过“先 count 再 update”替代并发控制。

### IdentityStore

```js
await store.withTransaction(async (tx) => { /* tx 使用同一组异步方法 */ });
await store.createUser(user, { tx });
await store.getUserById(userId, { tx });
await store.getUserByNormalizedName(name, { tx });
await store.updateUser(userId, expectedVersion, patch, { tx });
await store.createSession(session, { tx });
await store.getSession(tokenHash, { tx });
await store.revokeSession(tokenHash, revokedAt, { tx });
await store.revokeUserSessions(userId, revokedAt, { tx });
await store.countActiveAdmins({ tx });
await store.getBootstrapControl({ tx });
await store.closeBootstrapOnce(bootstrapRecord, { tx });
```

用户记录带持久 `id`、单调 `version`、口令哈希、唯一角色、账号状态和 `authVersion`。条件更新版本不符返回冲突；初始化、最后管理员和停用撤销必须在事务内判定。邮箱挑战单独持久化，邮件故障不得把挑战标记为已验证。

### MetadataStore / MigrationRunner

```js
await store.migrate({ targetVersion, deploymentId });
await store.getSchemaVersion();
await store.withTransaction(async (tx) => {});
await store.close();
```

模式版本、部署 ID、迁移记录与控制记录持久保存。错误数据库、错误部署、更新版本不支持或迁移未完成必须拒绝就绪，不得自动创建空生产库继续服务。

### ContentStore

```js
await content.beginUpload({ regionId, fileId, operationId, size, sha256, actor });
await content.writeChunk(uploadId, offset, readable, { signal });
await content.commitUpload({ uploadId, baseRevision, metadata, signal });
await content.openRead({ regionId, fileId, revision, range, signal }); // { stream, size, etag, ... }
await content.abortUpload(uploadId, { signal });
await content.reconcile({ regionId, cursor, signal });
```

内容在配置的真实文件根，元数据与可恢复上传状态在 MongoDB。提交采用条件修订和唯一 operationId；同 ID 同内容重试返回首次结果，不同内容冲突。分段校验、临时文件清理、崩溃恢复、磁盘满和取消都必须有确定状态，不能把整文件放进 JSON 或进程内存。

已提交内容按不可变修订保存，`contentPath` 只保存区域根内的相对引用；`openRead` 返回的流必须被消费、销毁或调用其 `close()`。`committing` 上传只能由重试或启动恢复继续完成，不能因崩溃被改写成失败或删除墓碑。

### ModuleFileAdapter 与持久修订

模块只能通过固定 `moduleId + regionId` 获取适配器，Disk 只能通过同一区域的 Disk 视图获取适配器；二者最终调用同一 ContentStore 提交契约。上传检查点、当前文件、历史修订、operationId、配额账本、文件锁、事件和游标持久保存在 MongoDB。适配器重新校验 actor/owner，不得凭 uploadId 或 fileId 跨用户读写。Disk 装卸不移动内容、不改写路径/哈希/引用；对账和诊断只报告缺失或损坏。

### 一致性备份、诊断与隔离恢复

```js
await createBackup({ client, dbName, config, regions, outDir, quiesce });
await verifyBackup(backupDir, { verifyContent: true });
await restoreBackup({ backupDir, client, targetDbName, targetDataRoot, isolated: true });
await diagnoseStorage({ content, regionIds, deep: true });
```

备份调用方必须在同一 `quiesce` 临界区暂停并恢复全部 Mongo 与文件写入。Mongo 文档使用版本化 EJSON JSONL，区域内容按原始字节流复制；文件内容不得转成 JSON/base64。清单固定备份格式、存储模式和配置模式版本，并记录部署 ID、源数据库/根、逐文件 SHA-256 与区域树哈希。

校验必须复核当前文件和历史修订的 `contentPath + size + contentHash`。恢复仅允许显式隔离目标，目标 DB 和文件根必须为空，且不得写回、包含或重叠源 DB/根；恢复时重定位持久区域根并再次校验引用。错根、错部署、错配置或不支持的版本必须拒绝，失败清理 staging 和已部分写入的隔离 DB，不生成文件墓碑。

### ChangeStore

```js
await changes.commitFileOperation({ operation, expectedRevision, contentCommit, actor }, { tx, signal });
await changes.since({ regionId, cursor, limit, signal });
await changes.reconcile({ regionId, signal });
```

业务模块写入和 Disk 写入使用同一修订、配额、所有权、墓碑和游标系统。索引可从事实记录对账恢复；不可读、离线和权限撤销不能生成删除墓碑。

## 2. HTTP 路由声明

模块路由除 `method/path/handler` 外，C06 起必须声明传输描述：

```js
{
  method: 'PUT', path: '/api/disk/files/*',
  transport: {
    kind: 'upload',                 // json | binary | upload | download | sse
    maxBytes: 1073741824,
    accepts: ['application/octet-stream'],
    timeoutMs: 3600000,
    cancellation: 'propagate'
  },
  handler
}
```

公共语义：

- `json`：默认 64 KiB，可按路由显式收紧或调整；非法 JSON 为 400，超限为 413。
- `binary`：有界原始请求体，仅用于确需完整缓冲的小对象；不得隐式用于大文件。
- `upload`：请求流直达 ContentStore，支持背压、取消、分块与幂等提交，不拼接整文件 Buffer。
- `download`：返回流、长度、类型、ETag/内容处置；支持单区间 Range、416、零字节与客户端中断。
- `sse`：UTF-8 事件流、心跳、事件 ID、背压与关闭传播；禁止代理无条件缓冲。

处理器若已接管 `res`，必须返回明确的 `handled` 结果；宿主不得再次 JSON 序列化或写头。未声明传输的旧 JSON 路由在迁移期明确标为 `json`，不得默认猜测二进制。

## 3. 主体与调用授权

浏览器请求由核心会话认证；服务间请求携带可验证的 `subject`、`service`、`scopes`、`expiresAt` 和调用 ID。每次高风险操作重新检查账号状态、范围与撤销。正式入口忽略并拒绝把 `x-*-user-id` 等开发头作为身份来源。

Glim 工具目录只包含已安装、版本兼容、真实可用且当前用户已授权的能力。服务发现本身不授予数据权限。

## 4. 任务与执行

```js
{
  taskId, ownerId, module, kind, status,
  idempotencyKey, createdAt, updatedAt,
  progress, error, cancelRequestedAt, expiresAt
}
```

状态只允许 `queued → running → succeeded|failed|cancelled`，恢复时可将中断任务明确标为 `failed/interrupted` 或依据持久检查点重新排队。停止和超时必须传递到 worker；HTTP 断开按任务类型取消或保留，但不能产生无界进程。模型、文件提交、发信、发布等外部后果以操作 ID 关联，重试不得重复产生副作用。

worker 使用独立低权限身份、资源限额和允许的数据挂载；不能读取管理 Cookie、宿主秘密、其他租户文件或数据库管理凭据。

## 5. 配置与启动

`config/config.schema.json` 是部署配置结构事实源，`runtime-topology.json` 是进程事实源，模块 manifest 只声明本模块需求。安装器据此生成 app、worker、Compose、后台菜单、Glim 目录和诊断输入；不允许各层维护互相漂移的模块名单。

正式启动必须显式选择 `mongodb` 和正式 ContentStore。内存/JSON 适配器只在测试或带显著演示标记的独立入口可用。未选模块不得加载入口、创建路由、启动 worker/定时任务或要求其模型/邮箱配置。

## 6. 构建与生产隔离

构建区位于共享源码树之外，包含依赖缓存、容器上下文、镜像、客户端制品和一次性数据库。测试仅使用合成账号与文件。任何测试默认不得加载生产 `.env`、访问生产 MongoDB/SMTP/模型/网盘，也不得重启生产进程。真实外部测试必须另有明确授权的目标与记录。
