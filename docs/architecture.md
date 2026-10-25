# 架构说明

本文说明 PagesAI 公开版的运行单元、模块装配、生命周期、存储契约、身份模型与 Glim 连接模型。

> **事实源**：代码以 `core/`、`modules/`、`tests/` 为准；契约以 `contracts/*.schema.json` 为准；阶段进展以 [`docs/P1-status.md`](P1-status.md)、[`docs/m0/M0-report.md`](m0/M0-report.md) 为准。本文对应 2026-10-25 快照。

## 1. 总览

```text
             浏览器 / Glim 客户端（TLS 由部署方在网关前终止）
                             │
                    ┌────────▼──────────────────────┐
                    │ 网关 gateway（唯一发布端口）   │
                    │ deploy/docker/entrypoints/     │
                    │ gateway.js：流式转发、不缓冲    │
                    └────────────┬──────────────────┘
                                 │ http://app:8080
                    ┌────────────▼──────────────────┐
                    │ 应用 app（公共 Node 服务）     │
                    │  /healthz  /readyz             │
                    │  /api/auth/*  /api/me          │
                    │  /api/admin/*                  │
                    │  模块宿主：按启用挂载路由       │
                    └───┬───────────────┬───────────┘
                        │               │
             ┌──────────▼───┐   ┌───────▼─────────────────────────┐
             │ 六个业务模块  │   │ Pages 任务 worker（fork + IPC）  │
             │ 同进程按需装配│   │ 由 app 按任务启动，不监听端口     │
             └──────────────┘   └─────────────────────────────────┘
                        │
             ┌──────────▼───────────────────────────────────────┐
             │ MongoDB：身份、会话、存储元数据                    │
             │ （paper / glim / mail / survey 的业务数据用 JsonStore）│
             └──────────────────────────────────────────────────┘
```

上图是**代码层已实现的单元**，由 `deploy/docker/entrypoints/` 与 `deploy/presets/` 编排；镜像尚未在本机构建，也没有真实容器启动证据（见 [`deploy/README.md`](../deploy/README.md)）。尚未实现：自建邮箱协议栈、按需独立的 Disk 流式进程、独立沙盒。公开版 Glim 固定为 Node 模块；Python 仅可作为沙盒工具运行时，不设独立 Python Glim 服务。

设计取舍：**不把六个模块强制拆成六套微服务**。六个模块都是同进程内按需装配的 Node 模块；只有确实需要独立运行时（数据库、Disk 流式数据面、执行沙盒、邮箱服务器）才作为独立单元。网关与 app 拆成两个进程，是为了让唯一对外端口、流式背压和 TLS 终止有明确归属，而不是把业务拆散。

## 2. 运行单元

| 单元 | 形态 | 何时存在 | 现状 |
| --- | --- | --- | --- |
| 网关 gateway | 独立 Node 进程（`deploy/docker/entrypoints/gateway.js`） | 正式部署；唯一发布端口 | **入口与镜像定义已实现**；镜像未构建、容器未启动验证 |
| 公共核心 app | 单个 Node 进程（`deploy/docker/entrypoints/app.js`） | 始终 | **已实现**：core-only 可启动 |
| 六个业务模块 | 同进程内 `require` + 路由挂载 | 模块已登记且启用 | **已实现**（服务端闭环） |
| 模块开发入口 | `modules/<id>/server/dev.js` | 本地调试 | **已实现**（6 个均可启动） |
| Pages 任务 worker | `fork` + IPC 子进程（`deploy/docker/entrypoints/worker.js`） | 页面生成或后端任务运行时 | **已实现**；有内存上限与可选 uid/gid，沙盒隔离未验证 |
| MongoDB | 外部数据库 | core-only 与仅 Mail 之外的部署 | **身份/会话/存储元数据已接**；模块业务数据仍用 `JsonStore` |
| Disk | 同进程 Node 模块 | 仅安装 Disk | **已实现**；独立流式数据面未拆 |
| Glim | 同进程 Node 模块 | 仅安装 Glim | **已实现**；无独立 Python 服务 |
| 邮箱服务器 / SMTP、IMAP | 外部服务 | Mail | 由部署注入适配器（smtp/imap），未内置协议栈 |

边界规则：

- 未安装模块不导入代码、不注册路由、不启动任务、不做模块专属配置校验。
- 浏览器与 Glim 不接受任意宿主路径；物理根只在服务端经配置解析。
- 后台只有一种管理员角色；不提供「从网页安装并可执行任意代码」的插件商店。

## 3. 模块清单与装配

每个模块提供一份静态清单（`modules/<id>/manifest.json`），由 `contracts/module-manifest.schema.json` 校验。

| 模块 | 版本 | 路由前缀 | 声明区域 | 声明基础设施 | 对 Glim 的工具 |
| --- | --- | --- | --- | --- | --- |
| pages | 0.1.0 | `/api/pages` | `pages.sites`、`pages.materials`、`pages.ai-workspace`、`pages.backends` | 无 | 8 个，全部 `implemented:true` |
| disk | 0.2.0 | `/api/disk` | `disk.user-files` | 无 | 无 |
| glim | 0.2.0 | `/api/glim` | `glim.state` | 无 | 37 个，全部 `implemented:true` |
| mail | 0.2.0 | `/api/mail` | `mail.mailbox` | `smtp`、`imap` | 4 个，全部 `implemented:true` |
| survey | 0.2.0 | `/api/survey` | `survey.responses`、`survey.attachments` | 无 | 无 |
| paper | 0.2.0 | `/api/paper` | `paper.uploads` | 无 | 6 个，全部 `implemented:true` |

`glim` 的五项 `optionalConnections`（pages、disk、mail、survey、paper）只供 Glim connector 发现可连接的兄弟模块，是声明性元数据，不构成硬依赖；核心不会据此自动装配连接。

`disk` 另带两个可选交付物，不进核心进程：`modules/disk/sync/` 是 Rust 双向同步引擎与 CLI（`generic`/`pku` 两种编译策略），`modules/disk/client/` 是基于它的 Tauri 2 桌面壳。二者只通过 HTTP 协议与模块交互，见 `docs/disk-sync.md`。

> 区域 ID 以各模块清单为准。`docs/m0/A03-data-roots-writes.md` 的候选区域表是**基线数据根盘点**，不是公开版的最终区域命名；两者不要混用。
>
> `tools/init.js` 生成的区域表已与模块清单一一对应：`glim.state`、`mail.mailbox`、`survey.responses`/`survey.attachments`、`paper.uploads`，配置键分别为 `storage.glim.state`、`storage.mail.mailbox`、`storage.survey.responses`/`storage.survey.attachments`、`storage.paper.uploads`。清单之外只有部署层自用区域：`disk` 的 `disk.pku-archive`（仅 `--disk-variant pku`）、`disk.upload-tmp`、`disk.preview-cache`、`disk.share-registry`，以及 survey 的 `survey.upload-tmp`；这些统一登记在 `tools/init.js` 的 `DEPLOYMENT_ONLY_REGIONS`，`tests/contracts/init-regions.test.js` 校验两侧不再分叉。

装配规则：

1. 登记只能由构建与管理员配置产生，不接受请求驱动的动态安装。
2. 路径必须是模块内相对路径：拒绝绝对路径、反斜杠、`.`/`..` 段；`config.schema`、迁移脚本同样校验。
3. `enable` 时才 `require` 入口；未启用模块的代码不进入进程。
4. 入口必须导出 `start`/`stop`/`health`；可导出 `routes`（`[{method,path,handler}]`）与 `tools`；可在 `activation.adminContribution` 声明后台贡献文件（如 `server/admin.js`）。
5. 只有 `implemented: true` 的能力会出现在可用能力清单里。

装配接口（P3，随 `core/server.js` 落地）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `install(manifest)` | 代码/部署 | 校验并登记，不加载代码 |
| `enable(id)` / `disable(id)` | 代码；`POST /api/admin/modules/:id/(enable\|disable)` | 管理员启用/停用 |
| `health(id)` | 代码 | 区分 `not-enabled`/`not-started`/业务原因 |
| `uninstall(id)` | 代码 | 停用后移除登记，保留数据 |

模块路由只在启用后进入 `modules.allRoutes()`，由核心统一挂载并注入 `ctx = {req,res,url,params,query,body,user}`。核心不 `require` 任何 `modules/` 代码。

后台贡献：`activation.adminContribution` 指向模块内文件，该文件导出 `describe({id,config,manifest,health,instance})`，由核心收敛（标题、摘要、分组事实、唯一控制台入口）后经 `GET /api/admin/modules` 提供给管理后台。收敛只保留可展示文本，不转发配置对象、适配器、密钥或 Health 原始对象；`consolePath` 必须与核心页面一致，否则该模块的后台贡献标为不可用，不影响模块业务能力。未启用或未安装的模块不加载贡献文件。

## 4. 生命周期状态机

核心内部用四个布尔 + 错误原因描述状态（`core/registry/host.js`）：

| 状态 | 含义 | 如何进入 |
| --- | --- | --- |
| `installed` | 清单通过校验并已登记 | `install(manifest)` |
| `configured` | 配置通过模块 schema 校验 | `enable()` 中的配置检查 |
| `enabled` | 已决定启动，入口已加载 | `enable()` |
| `ready` | `start()` 成功且 `health()` 为真 | `enable()` / `health()` |

```text
 未登记 ──install()──► installed ──enable()──► configured ──► enabled ──start() ok──► ready
                          │                       │                │                    │
                          │ 配置不完整             │ 入口加载失败    │ start() 抛错        │ health() 为假
                          ▼                       ▼                ▼                    ▼
                    installed（configured=false）  startError 记录    ready=false          ready=false
                          │
                          └──disable()──► installed（enabled=false, ready=false）
                          └──uninstall()──► 未登记（数据与区域默认保留）
```

| 操作 | 前置 | 失败语义 |
| --- | --- | --- |
| `install` | 清单合法、未登记 | 重复 `CONFLICT`；非法清单 `CONFIG_INVALID`；越界路径 `PATH_ESCAPE` |
| `enable` | 已登记 | 未登记 `MODULE_NOT_INSTALLED`；配置不全 `CONFIG_INVALID`；入口/生命周期异常 `MODULE_NOT_READY` |
| `health` | 已启用 | `{ok, reason}`；未启用 `not-enabled`，未启动 `not-started` |
| `disable` | 已登记 | 先 `stop()`；保留登记与配置，`ready=false`，路由消失 |
| `uninstall` | 已登记 | 先停用，再移除登记；**不**删除物理数据与区域 |

用户/后台展示状态与内部状态分开：未安装、未启用、待配置、启动中、可用、故障、升级中。当前只实现内部四态与 `startError`；「启动中」「升级中」与后台状态卡未实现（K4）。

## 5. 存储契约

### 5.1 存储区域（storage region）

区域声明由 `contracts/storage-region.schema.json` 冻结：

| 字段 | 约束 | 说明 |
| --- | --- | --- |
| `regionId` | `^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$` | 形如 `<module>.<area>` |
| `module` | `core`/`pages`/`disk`/`glim`/`mail`/`survey`/`paper` | 归属模块 |
| `physicalRoot.configKey` | 配置键 | 物理根只经配置解析；`allowImplicitChange` 恒为 `false` |
| `physicalRoot.defaultSubpath` | 新部署子目录名 | 只用于新部署，不得判定既有数据消失 |
| `ownership.rule` | `per-user`/`global`/`per-object` | 统一用户 ID 是所有权依据 |
| `allowedOperations` | `read`/`write`/`delete`/`rename`/`mkdir` | 未列出即拒绝 |
| `disk` | `visible`/`syncable`/`readOnly`/`writableViaModuleAdapter` | Disk 是授权视图 |
| `quota` | `basis`/`accounting`/`dedupeByFileId` | 同一物理文件多入口只计一次 |
| `changeLog` | `required`/`contract` | 写入必须发变更记录 |

授权检查（`StorageRegistry.authorize`）依次校验：操作在 `allowedOperations` 内 → 调用方是归属模块或 Disk 可见视图 → Disk 只读区域禁止写删改 → `per-user` 必须给 `userId`。

路径解析只做**词法**校验（绝对路径、反斜杠、空字节、`.`/`..`、越出区域根）；符号链接的 `realpath` 校验未实现。

> 现状：`pages` 与 `disk` 的文件内容与元数据已通过 `fileAdapter` 接到 `FileContentStore` + MongoDB 元数据；`paper`、`glim`、`mail`、`survey` 仍用 `JsonStore` 的 `dataFile`，尚未把写路径接到核心 `StorageRegistry` 的变更日志。区域是清单声明与部署登记的义务，不是模块运行时自动完成的。

### 5.2 文件变更记录（file change）

所有写文件都必须发布同一条记录，模块自身写入也不例外：

| 字段 | 语义 |
| --- | --- |
| `operationId` | 幂等标识；重复提交返回首次结果，内容不同 `CONFLICT` |
| `baseRevision` | 条件写入；与当前不符 `CONFLICT` 并保留冲突 |
| `revision` / `cursor` | 提交后的修订号与变更游标 |
| `actor` | `user`/`service`/`module-task`/`sync-client` + 标识 + `capability` |
| `status` | `pending`/`committed`/`failed`/`recovered`；只有 `committed` 对外可见 |
| `tombstone` | 只有**明确删除**才能写墓碑 |
| `conflict` | 冲突类型与解决方式 |

游标语义：首次调用 `reset:true`；过期 `reset:true, reason:'cursor-expired'`。**绝不能**把过期当成「远端为空」。

Disk 模块已实现 `operationId` 幂等、`baseRevision` 冲突、软删/恢复与修订递增。同步协议复用同一套修订与墓碑语义，但变更序列与游标由 Disk 自己的 `syncSeq` 维护：每个用户单调递增，游标按用户保留 `syncHistoryLimit` 条，过期返回 `cursor-expired` 并要求全量对账。核心变更日志不参与 Disk 同步。

### 5.4 Disk 双向同步

服务端（`modules/disk/server/platform.js`）：

- `sync/state` 返回 `{seq, epoch, prunedThrough}`；`sync/changes?cursor=` 返回有序增量与 `hasMore`；`sync/tree` 返回全量文件夹树与文件表。
- 文件名同级唯一、目录移动拒绝成环、删除只写软删墓碑；客户端只能凭完整扫描提交删除。
- 设备配对使用一次性代码，换取只在配对响应中出现的令牌；服务端只存哈希，可撤销、可过期。设备令牌与用户会话走同一授权口径（`userOrDevice`）。

客户端（`modules/disk/sync/`）：

- `Engine`：先回放本地待提交日志，再按游标拉增量；游标过期或 epoch 变化时全量对账（拉树、逐项比对、删除仅在全量扫描成功后才传播）。
- 本地状态落在 `<root>/.pagesai/state.json`，原子替换 + 备份 + `fs2` 排他锁；损坏回退备份。
- 冲突生成副本而不覆盖；重命名/移动按内容哈希识别；网络失败保留待提交项并停止删除传播。
- 编译期策略：`generic` 只且仅允许直连 HTTPS 端点；`pku` 在直连之外允许清单内的校内端点；两端点共享同一身份与数据，失败时轮换。两个 feature 同时启用或无启用直接编译失败。
- Tauri 壳：服务地址、根目录、设备名、间隔、开机自启；令牌存系统钥匙串；单实例；更新元数据预置占位公钥，未替换前不得视为可信更新源。

### 5.3 持久化

- `core/identity/mongo-store.js` 与 `core/storage/mongo-metadata.js`：正式部署的身份、会话、存储区域与变更元数据落在 MongoDB。MongoDB 引擎必须显式选择；生产启动拒绝静默回落到内存，内存存储只能由测试显式注入。
- `core/storage/persistence.js`：区域与变更日志的文件持久化，原子替换写、`0600`、`formatVersion` 校验、损坏拒绝启动；用于无数据库的测试与导入导出。
- `core/storage/json-store.js`：`paper`、`glim`、`mail`、`survey` 的业务数据文件；同样的原子写与 `0600`，可纯内存运行；**不是数据库**，不做并发控制与事务。
- `core/storage/content-store.js`：`pages`、`disk` 的文件内容与元数据，元数据落 MongoDB；迁移与恢复由 `core.initialize()` 执行。

## 6. 身份、会话与单层管理员

### 6.1 模型

| 项 | 规则 |
| --- | --- |
| 角色 | 只有 `user` / `admin`；**没有第二层管理员** |
| 用户名 | 3–32 位，`[A-Za-z0-9._-]`，首尾为字母或数字；NFKC 归一后小写唯一；保留名拒绝 |
| 口令 | 8–200 位，禁止全空白；`scrypt`（N=16384, r=8, p=1）哈希 |
| 状态 | `active` / `disabled` / `pending_email` |

### 6.2 会话

- 32 字节随机 `base64url`；只存 SHA-256 摘要。
- Cookie `pagesai_sid`：`HttpOnly; SameSite=Lax; Path=/`；也接受 `Authorization: Bearer`。
- 默认 7 天；不得小于 5 分钟；`authVersion` 递增使旧会话立即失效。

### 6.3 首名管理员与保护

- `POST /api/admin/bootstrap` 只能成功一次；成功后 `BOOTSTRAP_CLOSED`；并发只产生一个结果。
- 首个注册者不会自动成为管理员。
- 设置 `PAGESAI_BOOTSTRAP_TOKEN` 时，引导请求必须携带同值。
- 最后一名有效管理员不可删除、停用或降级（`LAST_ADMIN_PROTECTED`）。

### 6.4 注册方式

| 方式 | 开启条件 | 行为 |
| --- | --- | --- |
| 用户名 + 口令 | `PAGESAI_REGISTRATION_ENABLED`（默认开） | 直接创建 `active` 用户 |
| 邮箱验证 | `PAGESAI_EMAIL_REGISTRATION=on` 且已安装并配置 Mail | 创建 `pending_email`，验证后 `active` |
| 关闭注册 | `PAGESAI_REGISTRATION_ENABLED=off` | `403 REGISTRATION_CLOSED`，既有账号仍可登录 |

启用邮箱注册但未安装 Mail → **启动即失败**（`MAIL_MODULE_REQUIRED`）；已装未配置发信 → `MAIL_NOT_CONFIGURED`；Mail 故障时不允许跳过验证。

### 6.5 核心 HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | 存活 |
| GET | `/readyz` | 就绪；返回模块清单与数据根 |
| GET | `/api/modules` | 已登记模块状态与可用能力 |
| POST | `/api/auth/register` | 注册 |
| POST | `/api/auth/verify-email` | 邮箱验证 |
| POST | `/api/auth/login` | 登录（Cookie + token） |
| POST | `/api/auth/logout` | 退出 |
| GET | `/api/me` | 当前用户 |
| POST | `/api/admin/bootstrap` | 一次性管理员引导 |
| GET | `/api/admin/users` | 用户列表（管理员） |
| PATCH | `/api/admin/users/:id` | 改角色或状态（管理员） |
| GET | `/api/admin/modules` | 已登记模块状态与后台贡献（管理员） |
| GET | `/api/admin/modules/:id` | 单模块状态与后台贡献；未安装 404（管理员） |
| POST | `/api/admin/modules/:id/(enable\|disable)` | 启用/停用已登记模块（管理员） |
| GET | `/admin/*` | 后台静态外壳（目录为空时 404） |

未安装模块的业务前缀（`/api/pages`、`/api/disk`、`/api/survey`、`/api/paper`、`/api/glim`、`/api/mail`）必须 404。

## 7. Glim 与五连接

Glim 是可单独使用的智能体；连接是可选能力，不是硬依赖。

| 连接 | 目标能力 | 适配器 | 说明 |
| --- | --- | --- | --- |
| Pages | 列出/读取/创建站点、读写文件、预览、发布 | `connectors/pages.js`，8 个能力 | 走 Pages 正式 HTTP 接口与当前用户会话 |
| Disk | 列文件、读写、删除、分享 | `connectors/disk.js` | 不越过 Disk 所有权与配额 |
| Mail | 发信、收件箱、读信、删除 | `connectors/mail.js`，4 个能力 | 发信带幂等键 |
| Survey | 发布问卷、读答卷 | `connectors/survey.js` | 走 Survey 正式接口 |
| Paper | 检索/问答 | `connectors/paper.js` | 能力名已与 Paper 路由对齐 |

五个适配器只在 connector 显式声明 `moduleId` 时启用，且必须携带当前用户会话（`contextToken`）；不存在管理员代调或固定 owner 回落。

连接语义（已实现）：

1. **显式登记**：`POST /api/glim/connectors` 登记 `endpoint + capabilities`；不扫描局域网。
2. **来源白名单**：`trustedConnectorOrigins` 非空时精确匹配 origin。
3. **登记 ≠ 授权**：必须 `POST /connectors/:id/grant`；重复 grant 取并集。
4. **撤销即时**：`revoke` 后下一次查询/调用立即失效。
5. **能力过滤**：`GET /tools` 只返回已授权且 `implemented=true`。
6. **失败语义**：未授权 403；未实现/不兼容/适配器缺失 409；适配器异常 502。
7. **端点校验**：绝对 `http/https`，不得内嵌用户名/密码。
8. **不回落**：身份缺失时拒绝，不回落到固定 owner。

未实现：跨 origin 的健康探测与版本协商、局域网自动发现、外部后果二次确认。连接登记、`grant`/`revoke`、调用审计（`GET /api/glim/audit`）与模块健康（`GET /api/glim/health`）已实现；`connectors.capabilitiesFor` 只返回本地真实适配器并标 `implemented:true`，不返回模拟数据。

## 8. 数据布局与配置

| 项 | 规则 |
| --- | --- |
| `PAGESAI_DATA_ROOT` | 统一父目录；新部署按区域 `defaultSubpath` 建子目录 |
| `PAGESAI_INSTALL_ROOT` | 部署根；`modules/` 相对它解析 |
| `PAGESAI_MODULES` | 声明已安装模块；作为 `installedModules` 的回退，并由启动入口与 `config.json` 交叉校验，不一致拒绝启动 |
| 区域物理根 | 只经 `physicalRoot.configKey` 解析；隐式换根一律拒绝 |
| 模块配置 | `tools/init.js` 按模块 schema 校验并写入 `config.json.moduleConfig`；`core/runtime.js` 注入，`core/server.js` 经 `configProvider` 下发给 `start({config})` |
| 秘密 | 只从环境或密钥文件注入；`config.secrets` 仅登记引用 |

请求体上限由路由声明（`core/http-transport.js`）：默认 JSON 与 binary 各 64 KiB，upload 1 GiB，download/SSE 流式。Paper 覆盖为 JSON 48 MiB、原始上传 128 MiB；网关只透传，不改写这些上限。

不变量：

- 安装/卸载 Disk 不改变任何区域的数据位置。
- 源码目录变化不推导出数据路径变化。
- 一个物理文件在多个入口出现不重复计入总用量。

## 9. 与旧源码和生产环境的边界

- 旧 `source/site/` 各产品目录**只读参考**；公开版不得 `require` 旧目录。
- 公开版只在 `source/site/public-release/pagesai/` 维护。
- 公开包不得包含：`node_modules`、虚拟环境、数据库、上传文件、Maildir、个人站点、日志、备份、真实密钥/签名私钥、真实账号、校园内部地址清单、旧私人网关、Jupyter 相关文件。
- 零改动证据：`tools/verify-no-change.sh`（干净基线应 exit 0）；归属表：`tools/merge-ownership.sh --check`。

## 10. 验收映射

| 架构约束 | 证据 |
| --- | --- |
| 网关流式转发、头处理、Range/SSE 与 502 | `tests/integration/gateway.test.js` |
| core-only 可启动、无业务路由 | `tests/integration/core-boot.test.js` |
| 注册/登录/会话/单层管理员 | `tests/contracts/identity.test.js` |
| 模块状态机与能力如实 | `tests/contracts/registry.test.js` |
| 存储区域、授权、路径、幂等与游标 | `tests/contracts/storage.test.js` |
| 持久化与拒绝隐式换根 | `tests/contracts/persistence.test.js` |
| 模块装配与路由挂载 | `tests/integration/module-mount.test.js` |
| 六个模块功能与隔离 | `modules/*/tests/*.test.js` |
| Disk 同步协议（游标、墓碑、配对） | `modules/disk/tests/platform-sync-mongo.test.js`（需本地 Mongo 副本集） |
| Disk 双向引擎 | `cd modules/disk/sync && cargo test --offline`，以及 `--no-default-features --features pku` |
| 桌面壳可编译 | `cd modules/disk/client/src-tauri && cargo check --offline`（两种 feature 各一次） |
| 部署预设静态组合 | `deploy/validate-presets.js --matrix` |

复跑：

```bash
cd source/site/public-release/pagesai
node --test tests/contracts/*.test.js
for m in pages disk glim mail survey paper; do node --test modules/$m/tests/*.test.js; done
node deploy/validate-presets.js --matrix
```

## 11. 已知缺口

| ID | 架构层面的影响 |
| --- | --- |
| K1 | ~~身份与会话在内存~~（已关闭）：MongoDB 引擎下用户、会话、验证码持久化，`state/identity.json` 为导出快照 |
| K2 | ~~持久化存储注册表未接入核心 HTTP 入口~~（已关闭）：MongoDB 引擎下区域、修订与变更事件写入 `storage_*` 集合 |
| K4 | ~~基础后台外壳已存在；六模块真实配置、任务与状态页面未完成~~（已关闭，C29） |
| K5 | **部分**：安装器、预设与真实部署演练已完成；镜像构建与容器启动仍缺宿主机运行时 |
| K6 | 无统一配额与用量统计 |
| K8 | ~~五连接真实适配器未实现~~（已关闭）：五个 HTTP 连接器已落地 |
| K9 | 同步引擎与桌面壳已实现；安装包签名、公证、可信更新源与真实双平台验证需发布方提供 |
| K13 | 数据根硬编码与同根冲突在基线仍存在 |
| K14 | **部分**：Disk 已有统一 `fileId`/修订；跨模块变更日志仍未联动 |
| K19 | **部分**：CI、人工审批 Release 与可复现制品已落地；根 LICENSE 待决策，不得宣称可发布 |

完整清单与来源见 [`docs/README.md`](README.md#已知缺口清单)。