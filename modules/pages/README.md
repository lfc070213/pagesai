# Pages 模块（AI 生成网页）

公开版 Pages 模块。仓库外只依赖 Node 内置模块；正式运行经公共核心接入 MongoDB 与统一 ContentStore，不访问原 PagesAI 生产服务。

## 1. 已实现范围

| 能力 | 说明 |
| --- | --- |
| 站点 CRUD | `GET/POST /api/pages/sites`、`GET/PATCH/DELETE /api/pages/sites/:siteId`，按 `ownerId` 隔离 |
| 文件管理 | 站点内虚拟路径的列表/读取/写入/删除；拒绝 `..`、绝对路径、盘符、反斜杠与编码绕过 |
| 材料上传 | 站点材料（文本/二进制）经统一 ContentStore 上传，任务可引用为输入 |
| 发布 | `POST /api/pages/sites/:siteId/publish` 生成不可变快照（`version` + `contentHash`） |
| 公开访问 | `GET /api/pages/public/:slug/*` 只读；不读取 `ctx.user`，不暴露 `ownerId` |
| 预览 | `GET /api/pages/preview/:siteId/:token/*` 使用每站点随机 token，工作文件即时预览 |
| 回滚 | `POST /api/pages/sites/:siteId/rollback` 恢复上一发布版本（也可指定 `version`） |
| AI 任务 | `POST /api/pages/sites/:siteId/ai` 持久排队，worker 子进程调用模型；`GET /api/pages/tasks/:taskId/events` 以 SSE 回放推理/输出/结果，断线不取消任务 |
| 模型管理 | 管理员配置 `openai-compatible` 模型（Base URL + `env:NAME` 密钥引用）；`deterministic-test` 仅在显式测试模式可用 |
| 租户后端 | `POST /api/pages/sites/:siteId/backend` 部署 Node 入口源码，独立端口 + 独立数据库名，`GET /api/pages/tenant/:siteId/*` 反向代理 |
| 控制台 | `modules/pages/web/` 提供站点、文件、任务实时流、发布与后端管理页面，经公共核心会话认证 |
| 工具 | 对 Glim 暴露与 `manifest.capabilities.tools` 一一对应的工具 |

明确**不在**本模块闭环内（不得宣称已完成）：

- Docker/容器沙盒执行与系统级隔离；当前租户后端是受限子进程（见 §11）；
- 试用配额、计量、充值/售卖流程与管理员审计界面；
- 多实例共享的分布式锁；站点写锁是进程内互斥 + Mongo revision CAS。

## 2. 目录

```text
modules/pages/
  manifest.json          模块清单（通过 contracts/module-manifest.schema.json）
  config.schema.json     配置 JSON Schema（秘密字段 /ai/apiKey）
  server/index.js        CommonJS 入口：start/stop/health/routes/tools
  server/platform.js     正式数据面：站点/文件/发布/预览/任务/模型/租户后端路由
  server/repository.js   Mongo 仓储（revision CAS、站点写锁、任务状态迁移）
  server/task-manager.js 持久任务调度、超时/取消、重启恢复、孤儿进程清理
  server/backend-manager.js 租户后端部署、回环端口校验、反向代理与响应头清洗
  server/process-utils.js 按命令行标记清理遗留子进程
  server/dev.js          本地开发 HTTP 服务器（127.0.0.1:0）
  worker/task-worker.js  任务 worker 子进程（模型调用 + IPC 事件）
  worker/model-adapters.js 模型适配（openai-compatible / deterministic-test）
  worker/backend-runner.js 租户后端入口包装（强制回环绑定）
  web/                   控制台页面（index.html / console.js / console.css）
  tests/                 模块级测试（目录内 node --test）
  README.md
```

## 3. 统一接口

`server/index.js` 导出：

```js
module.exports = {
  async start({ config, logger }) {}, // 装载 JsonStore、重建 slug 索引、注入 AI 适配器
  async stop() {},                    // 摘除运行态，保留数据文件
  async health() { return { ok: true }; },
  routes: [{ method, path, handler }],
  tools: { ... }
};
```

- 所有路由以 `/api/pages/` 开头；
- `handler(ctx)` 返回 `{ status, body }`，`ctx = { req, res, url, params, query, body, user }`；
- 错误统一返回 `{ code, message }`（必要时附 `details`），不把异常抛给宿主；
- `start()` 幂等：已启动时再次调用只返回 `{ ok:true, alreadyStarted:true }`，换配置必须先 `stop()`。

### 路由表

| 方法 | 路径 | 认证 | 成功状态 | 说明 |
| --- | --- | --- | --- | --- |
| GET | `/api/pages/info` | 公开 | 200 | 模块版本、AI 是否配置、存储模式 |
| GET | `/api/pages/sites` | 登录 | 200 | 当前用户站点列表 |
| POST | `/api/pages/sites` | 登录 | 201 | 创建站点，body：`{name, slug?, description?}` |
| GET | `/api/pages/sites/:siteId` | 拥有者 | 200 | 站点详情（文件与版本元数据，不含正文） |
| PATCH | `/api/pages/sites/:siteId` | 拥有者 | 200 | 修改 `name/description/slug` |
| DELETE | `/api/pages/sites/:siteId` | 拥有者 | 200 | 删除站点并释放 slug |
| GET | `/api/pages/sites/:siteId/files` | 拥有者 | 200 | 文件列表 |
| GET | `/api/pages/sites/:siteId/files/*` | 拥有者 | 200 | 读取文件内容 |
| PUT | `/api/pages/sites/:siteId/files/*` | 拥有者 | 200 | 写入/覆盖，body：`{content, contentType?}` |
| DELETE | `/api/pages/sites/:siteId/files/*` | 拥有者 | 200 | 删除文件 |
| POST | `/api/pages/sites/:siteId/publish` | 拥有者 | 201 | 发布当前工作文件为快照 |
| GET | `/api/pages/sites/:siteId/versions` | 拥有者 | 200 | 版本列表（倒序） |
| POST | `/api/pages/sites/:siteId/rollback` | 拥有者 | 200 | 回滚；body：`{version?}`，缺省为上一版本 |
| POST | `/api/pages/sites/:siteId/ai` | 拥有者 | 202 | 创建 AI 生成任务；body：`{prompt, path?, model?, materials?}` |
| GET | `/api/pages/tasks` | 登录 | 200 | 任务列表（可按 `siteId` 过滤） |
| GET | `/api/pages/tasks/:taskId` | 拥有者 | 200 | 任务详情（不含文件正文与材料内容） |
| GET | `/api/pages/tasks/:taskId/events` | 拥有者 | 200 (SSE) | 实时/回放 `status`、`reasoning`、`output`、`done`、`error` |
| POST | `/api/pages/tasks/:taskId/cancel` | 拥有者 | 200 | 取消排队或运行中的任务 |
| GET | `/api/pages/tasks/:taskId/artifact` | 拥有者 | 200 | 下载任务结果清单 JSON |
| PUT | `/api/pages/sites/:siteId/materials/*` | 拥有者 | 201 | 上传材料（需 `x-file-size`/`x-file-sha256`） |
| GET | `/api/pages/sites/:siteId/materials` | 拥有者 | 200 | 材料列表 |
| GET | `/api/pages/sites/:siteId/materials/*` | 拥有者 | 200 | 下载材料 |
| GET | `/api/pages/preview/:siteId/:token/*` | 持 token | 200 | 工作文件预览（沙箱 CSP，无 Cookie） |
| POST | `/api/pages/sites/:siteId/backend` | 拥有者 | 200 | 部署租户后端；body：`{source}` |
| GET | `/api/pages/sites/:siteId/backend` | 拥有者 | 200 | 后端状态 |
| POST | `/api/pages/sites/:siteId/backend/start` | 拥有者 | 200 | 启动/恢复后端 |
| POST | `/api/pages/sites/:siteId/backend/stop` | 拥有者 | 200 | 停止后端 |
| GET | `/api/pages/tenant/:siteId/*` | 公开 | 200 | 代理到租户后端（其它写方法同路径） |
| GET | `/api/pages/models` | 登录 | 200 | 可用模型列表 |
| GET/PUT/DELETE | `/api/pages/admin/models[/:modelId]` | 管理员 | — | 模型配置管理 |
| GET | `/api/pages/public/:slug/*` | 公开 | 200 | 读取已发布快照；`?raw=1` 返回原始文本 |

> 公开路由匹配 `/api/pages/public/:slug/*`。路径为空（`/api/pages/public/<slug>/`）时默认返回 `index.html`。
> 直接调用 handler 时通配参数可放在 `params.filePath` 或 `params.wildcard`；公共核心 `core/server.js` 使用后者。

### 认证与隔离

- 生产环境由公共核心校验会话后把 `user` 注入 `ctx`；模块本身不实现登录。
- 未认证的**写操作**（POST/PUT/PATCH/DELETE）一律 `403 FORBIDDEN`。
- 未认证的读操作返回 `401 SESSION_INVALID`。
- 访问他人站点一律 `403 FORBIDDEN`；站点不存在返回 `404`，不泄露归属。
- 公开路由只使用 slug/路径/查询参数，**明确不读取 `ctx.user`**，响应中不出现 `ownerId`。
- Glim 工具只信任调用方传入的 `context.user`（或 `context.userId`），**绝不接受模型参数里的 `userId`**。

## 4. 文件路径规则

文件不是宿主文件系统路径，而是站点内的虚拟键：

- 长度 1–300，禁止控制字符、反斜杠、绝对路径、Windows 盘符；
- 禁止空段、`.`、`..`，包括 `%2e`/`%2f` 编码与双重编码绕过；
- 只允许文本型扩展名：`.html .htm .css .js .mjs .json .md .txt .xml .svg .webmanifest`；
- 单文件默认上限 1 MiB（`config.maxFileBytes`），单站点默认 200 个文件（`config.maxFilesPerSite`）。

越界路径返回 `400 PATH_ESCAPE`；不支持的扩展名返回 `400 pages.unsupported_file_type`。

## 5. 发布、版本、回滚与公开访问

发布快照结构：

```json
{
  "version": 1,
  "contentHash": "sha256-十六进制",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "fileCount": 2,
  "bytes": 1234,
  "files": { "index.html": { "content": "...", "contentType": "...", "size": 12, "updatedAt": "..." } }
}
```

- `contentHash`：按文件路径排序后，对 `路径\0类型\0字节数\0内容` 逐文件做 SHA-256；内容不变时重复发布哈希稳定。
- 发布只追加快照并移动 `publishedVersion` 指针；工作文件继续可编辑。
- 公开读取始终取 `publishedVersion` 对应的快照，**未发布的工作改动不会公开**。
- 回滚把工作文件与 `publishedVersion` 同时恢复到目标快照，不创建新版本；`lastRollback` 记录 `from/to/at`。
- 默认回滚到“当前已发布版本之前最近的一个版本”；无更早版本时 `409 pages.no_previous_version`。
- 版本默认保留 50 个（`config.maxVersions`），超出丢弃最旧快照；被丢弃的版本不可再回滚。
- 公开响应默认是结构化 JSON（含 `content`、`contentType`、`version`、`contentHash`）；`?raw=1` 返回原始文本，并带 `Content-Security-Policy: sandbox` 与 `X-Content-Type-Options: nosniff`。生产部署建议把用户站点放到独立源，避免与核心同源。

## 6. AI 适配器（可插拔，默认未配置）

模块**不内置任何模型 SDK、Key 或网关**。宿主在 `start({config})` 时注入：

```js
await pages.start({
  config: {
    dataFile: '/var/lib/pagesai/pages.json',
    aiAdapter: async ({ prompt, targetPath, site, files, user }) => {
      // files: { "index.html": "<现有内容>", ... }
      return {
        files: { 'index.html': '<h1>新内容</h1>' },
        summary: '改好了'
      };
    },
    ai: { provider: 'openai-compatible', model: '...', timeoutMs: 60000 }
  },
  logger
});
```

适配器可以是函数，也可以是带 `generate()` 或 `modify()` 的对象。返回值支持：

- `{ files: { "<路径>": "内容" | { content, contentType } }, summary? }`
- `{ content: "内容", path?: "<路径>", summary? }`
- 直接返回字符串（必须提供 `body.path` 作为目标路径）。

行为约束：

- 未注入适配器（或为 `null`）时，任何 AI 请求返回 `409 pages.ai_not_configured`；模块不会生成占位/模拟内容。
- 适配器抛错 → `502 pages.ai_failed`（不向响应泄露上游错误细节与密钥）。
- 超时 → `504 pages.ai_timeout`（默认 60s）。
- 返回空、无法识别、无实际变更、路径越界、内容超限 → 明确失败（`502 pages.ai_invalid_result` / `400 PATH_ESCAPE`），**不会部分落盘**。
- AI 结果只写入工作文件；必须再次 `publish` 才会公开，响应中 `requiresPublish: true`。
- 每次成功修改在 `aiRuns` 集合留审计记录（prompt 仅截断预览，不含完整对话）。

## 7. 配置

`config.schema.json` 校验；所有字段可选。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dataFile` | `null` | JsonStore 文件路径；`null`/缺省 = 纯内存（重启清空） |
| `publicBasePath` | `/api/pages/public` | 只影响返回的 `publicPath`，不改变路由挂载 |
| `maxFileBytes` | `1048576` | 单文件 UTF-8 字节上限 |
| `maxFilesPerSite` | `200` | 单站点文件数上限 |
| `maxSitesPerUser` | `20` | 单用户站点数上限 |
| `maxVersions` | `50` | 单站点保留发布版本数 |
| `taskTimeoutMs` | `120000` | 单任务超时；超时后取消并如实标记 |
| `taskTtlMs` | 30 天 | 任务记录保留时长 |
| `maxConcurrentTasks` | `2` | 全局并发 worker 数 |
| `workerMemoryMB` | `96` | worker 子进程堆上限 |
| `backendMemoryMB` | `96` | 租户后端子进程堆上限 |
| `backendSourceBytes` | `262144` | 租户后端入口源码上限 |
| `backendStartTimeoutMs` | `5000` | 后端启动等待上限 |
| `backendProxyTimeoutMs` | `30000` | 后端代理请求超时 |
| `tenantMongoKeyRef` | — | `env:NAME`，租户库专用连接串；**未配置时不下发任何数据库凭据** |
| `tenantMongoUrl` | — | 开发/测试直接写连接串；生产优先用 `tenantMongoKeyRef` |
| `ai.provider/model/baseUrl/timeoutMs` | — | 适配器的非秘密参数 |
| `ai.apiKey` | — | **秘密**（`manifest.config.secrets = ["/ai/apiKey"]`），只允许部署注入，不得写入示例配置或日志 |
| `aiAdapter` | — | 宿主注入的可执行适配器；不可序列化，配置文件不保存 |

示例（不含真实秘密）：

```json
{
  "dataFile": "/var/lib/pagesai/pages.json",
  "maxFileBytes": 1048576,
  "maxFilesPerSite": 200,
  "maxSitesPerUser": 20,
  "maxVersions": 50,
  "ai": { "provider": "openai-compatible", "baseUrl": "https://example.invalid/v1", "model": "example", "timeoutMs": 60000 }
}
```

## 8. 数据与持久化

两种运行模式：

1. **正式模式（公共核心提供 `runtime.db` + `fileAdapter`）**：站点/模型/任务/后端元数据保存在 MongoDB（`pages_sites`、`pages_models`、`pages_tasks`、`pages_backends`），文件与材料正文进入统一 ContentStore。站点整文档带 `revision` CAS，读写改在进程内站点锁内串行；任务状态用条件更新迁移，终态不会被迟到结果覆盖。
2. **独立/开发模式（仅 `config.dataFile`）**：`core/storage/json-store.js`，原子替换写（临时文件 + rename），适合单进程、开发与小规模部署。

- 启动时先迁移/校验元数据，再清理遗留 worker/后端进程；中断的 `running` 任务标记为 `TASK_INTERRUPTED`。
- 数据文件损坏或 `deploymentId` 不匹配时**拒绝启动**（`CONFIG_INVALID`），不会静默重建空库。
- 声明区域：`data.regions = ["pages.site"]`；命名空间 `pages`。
- 多实例部署依赖 Mongo revision CAS 防止互相覆盖；站点写锁本身只在单进程内生效。

## 9. 开发服务器

```bash
cd source/site/public-release/pagesai

# 常驻，监听 127.0.0.1:0，stdout 第一行为 {"url":"http://127.0.0.1:PORT"}
node modules/pages/server/dev.js

# 启动后打印 URL 并立即退出（冒烟）
node modules/pages/server/dev.js --once

# 指定数据文件（不指定则纯内存）
node modules/pages/server/dev.js --data-file /tmp/pages-dev.json
```

- 日志写 stderr，stdout 只保留 URL，便于脚本解析。
- 开发用户：请求头 `x-pages-user-id: <id>`；这是**开发桩，不是认证**。不带该头时写操作按契约 403，公开路由仍可读。
- `GET /api/pages/public/<slug>/<path>?raw=1` 可直接当静态站点预览。

## 10. 测试

```bash
# 推荐：在模块目录运行（自动发现 tests/*.test.js）
cd source/site/public-release/pagesai/modules/pages
node --test

# 或在公开版根目录
node --test 'modules/pages/tests/*.test.js'
```

当前结果：模块目录共 **31 个用例（27 pass / 0 fail / 4 个 Mongo 用例默认跳过）**，仅使用 Node 内置 `node:test`；不启动外部模型，不读取生产配置。根目录 `node tools/test-all.js` 为 **37 个文件 / 246 个用例通过（0 失败）**。

覆盖点：

- 清单与 config schema 契约、路由前缀、能力与工具一致；
- 跨用户读写 403、未认证写 403；
- `..`、绝对路径、盘符、反斜杠、编码/双重编码越界 400；
- 发布生成 `version` + `contentHash`，公开读取 200、快照隔离、哈希稳定；
- AI 未配置 409 且无任何伪造内容；已配置时写工作文件、发布后生效、异常不落盘；
- 回滚上一版本与指定版本生效、无更早版本 409；
- JsonStore 落盘重启、纯内存清空、损坏文件拒绝启动、`start` 幂等；
- Glim 工具只信任可信用户上下文；
- 任务取消/失败竞态：终态不被迟到结果覆盖，已取消的排队任务不会被重新调度；
- 租户后端端口白名单、请求/响应头清洗、Set-Cookie 丢弃、租户库凭据剥离；
- 孤儿进程清理只在命令行标记匹配时发送信号。

真实 MongoDB 用例（`npm run test:mongo`，需要本地 mongod 二进制）：并发文件写入不丢失、旧 revision 返回 409、任务状态迁移单赢家。干净安装 E2E 覆盖 Mongo 身份、持久任务/SSE、发布/回滚与租户后端真实 HTTP。

## 11. 已知边界与缺口

- **无容器级隔离**：worker 与租户后端是受限子进程（独立堆上限、回环端口、最小环境变量），但**不是** Docker/namespace 沙盒；容器镜像与网络策略属于后续部署阶段，当前不得宣称已完成。
- **同源租户后端**：租户 HTML 强制追加 `sandbox` CSP 并丢弃 `Set-Cookie`，代理会剥离管理面 Cookie/Authorization/转发头；生产仍建议租户站使用独立域名。
- **租户数据库凭据**：默认不下发任何主库凭据；需显式配置 `tenantMongoKeyRef`（仅授权租户库的专用账号）租户后端才能连库。
- **无配额计量/充值**：只有文件大小、文件数、站点数、版本数、材料数与并发数这类必要硬上限。
- **站点写锁是进程内互斥**：多实例并发依赖 Mongo `revision` CAS，冲突时明确 409；不做跨实例长事务。
- **公开访问建议独立源**：公开快照带沙箱 CSP，但生产仍应放到独立域名/源，避免同源风险影响控制面。
- **模型与外部服务需显式配置**：无内置模型；`deterministic-test` 仅能在显式测试模式启用，不是外部模型验收。
- **外部端口/系统 API 受限**：租户后端只允许回环绑定；进程清理只按入口文件名标记匹配，不按 PID 盲杀。

## 12. 边界声明

Pages 业务实现位于 `modules/pages/**`；公共核心为承载正式运行所做的通用能力（运行时装配、Mongo 身份、ContentStore、模块挂载、备份恢复）位于 `core/**`，不包含任何 Pages 专属业务或生产数据。所有代码不 require 仓库外旧站代码，不读取生产 `.env`。公开版之外的生产系统在本阶段未被修改。
