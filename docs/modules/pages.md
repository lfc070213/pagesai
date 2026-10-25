# Pages 模块

## 当前状态与边界

Pages 在公共核心中提供 MongoDB 元数据、统一 ContentStore 文件修订和真实 HTTP 控制台。控制台入口为 `/` 或 `/pages`，支持：

- 正式账号登录、注册、退出；管理员配置模型；
- 站点和文本文件管理、材料上传与下载；
- 持久任务、SSE 过程、用户停止、超时与失败状态、任务产物下载；
- 工作区预览、显式发布、无会话公开访问、版本恢复；
- 每站点租户后端部署、停止、恢复和带数据库命名空间的 HTTP 代理。

正式路径是 `mongodb+content-store`。旧 `JsonStore`/`aiAdapter` 入口只为旧模块测试保留，不是正式部署数据面；正式控制台和 API 不接受 `x-pages-user-id` 等开发身份头。

**尚未关闭的限制：**

1. worker 和租户后端是独立 Node 子进程，带最小环境、堆内存上限、任务超时和停止控制，但**不是容器或安全沙盒**。不能把它当作抵御恶意代码的边界；不可信后端代码仍可能访问主机权限范围内的资源。可选 `workerUid`/`workerGid` 需要部署者配置，不能替代容器隔离。
2. 离线 E2E 使用明确仅测试的 `deterministic-test`，另用本机 OpenAI 兼容协议桩验证流式解析、密钥引用、失败、停止和超时。**没有访问或验收真实外部模型。**
3. C13 已在一次性合成 Mongo + 干净安装环境完成真实浏览器验收（管理员引导、普通注册登录、模型配置、自然语言生成与 SSE、沙箱预览、发布、回滚、租户后端）；该验收不访问生产环境。
4. 预览与公开读取不同的可信数据快照，并使用 sandbox CSP；公开 HTML 不要求管理会话。租户后端 HTML 同样追加 sandbox CSP 且丢弃 `Set-Cookie`。当前 HTTP 路由仍可由同一站点源提供，对更强源级隔离有要求时，部署者应把公开内容放到独立源/域名。

## 启动

需要 Node.js 24、显式 MongoDB 连接和独立数据根。初始化只写指定测试/部署目录，不启动服务：

```bash
node tools/init.js \
  --data-root /srv/pagesai-data \
  --modules pages \
  --install-root "$PWD" \
  --config "$PWD/config.json"

PAGESAI_MONGO_URL='mongodb://127.0.0.1:27017/?replicaSet=rs0' \
  node core/start.js --config "$PWD/config.json" --host 127.0.0.1
```

`core/start.js` 只接受绝对配置路径。Mongo 数据库名、`deploymentId` 和区域以 `config.json` 为准；未知或非空不匹配数据库不会被静默重建，身份也不会回落内存。

首次管理员通过 `POST /api/admin/bootstrap` 引导，然后在控制台登录。普通用户可直接在控制台注册。生产部署应设置一次性 bootstrap token、TLS 和登录限流；参见安全指南。

## 模型配置

管理员在“模型配置”中保存可序列化定义：

```json
{
  "kind": "openai-compatible",
  "baseUrl": "https://provider.example/v1",
  "model": "provider-model-name",
  "keyRef": "env:PAGESAI_MODEL_KEY",
  "enabled": true
}
```

只保存 `baseUrl`、`model` 和 `keyRef`。`keyRef` 仅接受 `env:NAME`；密钥正文由部署环境提供，不进入 Mongo、任务记录或浏览器。worker 只取得当前任务所需密钥，读取后立即删除对应环境变量。

OpenAI 兼容适配器调用 `POST {baseUrl}/chat/completions`，读取 SSE delta，并要求最终 JSON 形如：

```json
{"files":{"index.html":"完整文件内容"},"summary":"修改说明"}
```

自由文本不会被当作成功文件结果；HTTP、JSON、结构、路径和大小错误均形成显式失败任务。

`deterministic-test` 是无网络、可重复的合成页面生成器，仅用于测试。必须同时满足：

- `moduleConfig.pages.allowTestModel === true`；
- 运行环境 `PAGESAI_ALLOW_TEST_MODEL=1`。

任何界面或任务结果中的测试模型标记都不代表外部模型验收。

## 任务、材料与产物

任务保存为 `queued → running → succeeded|failed|cancelled`，取消中有 `cancelling`。状态迁移使用 `{status: {$in: [...]}}` 条件更新：取消与迟到结果竞争时只有一个终态，已完成/已取消/已失败不会被覆盖。每用户串行、全局并发受限；worker 使用独立任务目录和 `--max-old-space-size`。服务停止会显式取消运行任务，未开始的 queued 任务保留并在重启后恢复；启动时发现非持久完成态的中断任务会按 pid 命令行标记清理遗留 worker 并标为 `TASK_INTERRUPTED`，不伪造成功。

材料经有界 upload stream 进入 `pages.materials`，需要调用方提供长度和 SHA-256。任务结果摘要写入 `pages.ai-workspace` 的 `tasks/<taskId>/result.json`，可通过 `/api/pages/tasks/:taskId/artifact` 下载。生成文件只更新工作区，`requiresPublish:true`；不会自动公开。

SSE 事件随任务持久化，可通过游标或 `Last-Event-ID` 补发。任务、材料和产物均校验用户归属。

## 文件、预览、发布与恢复

固定区域如下，正文只在统一 ContentStore 文件区域中保存：

| 区域 | 用途 | Disk |
| --- | --- | --- |
| `pages.sites` | 工作文件及历史修订 | 可见、可同步 |
| `pages.materials` | 上传材料 | 可见、可同步 |
| `pages.ai-workspace` | 任务产物 | 隐藏 |
| `pages.backends` | 后端 `server.js` 源码修订 | 隐藏 |

Mongo 的 `pages_sites` 只保存 `{fileId, revision, size, contentHash, contentType}` 等引用，不复制文件正文。`fileHeads` 跟踪当前写入头，版本恢复会从旧修订创建新的工作修订，避免旧快照修订与当前头冲突。站点元数据的读改写由进程内站点锁串行化，并以 `revision` 条件更新提交；多实例并发时旧 revision 明确返回 409，不会静默覆盖。

- 预览 token 是每站点独立随机值；预览读取当前工作修订。
- 发布要求 `index.html`，检查 HTML `src`/`href` 的危险或缺失内部引用，并保存不可变文件引用快照。
- 公开访问只读取 `publishedVersion` 对应快照；未发布修改不会出现。
- 恢复同时更新工作区和公开指针，不删除其他修订。
- 删除站点若仍有关联后端会返回 409；普通站点删除只删站点元数据，统一区域修订保留供对账，不静默物理清除。

## 租户后端

部署入口是单个 `server.js`，源码先写入 `pages.backends`，再 materialize 到每站点独立运行目录。每个后端有：

- 独立 Node 子进程、cwd、data/uploads 目录和堆内存上限；
- 只允许绑定 `127.0.0.1` 上的预分配端口；上报端口必须与分配值一致，否则停止进程；
- 由主数据库名和 siteId 派生的独立 Mongo 数据库名；
- 独立 `DATABASE_URL` 和秘密，不继承管理进程 env；**默认不带任何数据库凭据**，仅当显式配置 `tenantMongoKeyRef`（只授权租户库的专用账号）时才下发；
- 持久 `desiredStatus`、运行状态、停止和重启恢复；重启前按命令行标记清理遗留进程，不会按 PID 盲杀。

`/api/pages/tenant/:siteId/*` 代理有界请求流，剥离 `cookie`、`authorization`、host、转发链和 Pages/PagesAI 身份头，再设置服务端 tenant id。代理不转发管理会话；响应丢弃 hop-by-hop 头与 `Set-Cookie`，HTML 追加沙箱 CSP。部署或启动失败会保留源码与数据并明确报错；没有删除后端数据库或运行数据的 API。

这只是最小真实托管，不是恶意多租户安全沙盒。

## 验证

普通回归：

```bash
npm test
node --test modules/pages/tests/*.test.js
```

真实 Mongo 和干净安装 E2E（依赖和 mongod 在仓库外）：

```bash
NODE_PATH=/tmp/pagesai-mongo-build/node_modules \
MONGOMS_DOWNLOAD_DIR=/tmp/pagesai-mongo-build/binaries \
PAGESAI_MONGO_TEST=1 \
node --test tests/integration/pages-clean-install.test.js modules/pages/tests/repository-mongo.test.js
```

该测试在系统临时目录复制干净安装、执行 `tools/init.js`、启动本机单节点 Mongo replica set，并通过 Node 内置 fetch/流完成账号、模型、任务/SSE、材料、产物、预览、发布、恢复、重启队列和租户后端流程。`repository-mongo` 额外验证并发站点写入、旧 revision 409 与任务状态迁移单赢家。它不访问生产配置、生产 env 或外部模型。
