# Glim 模块（公开版）

Glim 是 PagesAI 公开版中**可单独安装、单独运行**的智能体模块（方案 §7.4）。本目录只实现最小闭环：会话与消息、每用户长期记忆、可配置模型适配、连接登记与授权、工具调用。没有前端页面，也没有任何对旧 `source/site/glim` 或私人网关的依赖。

## 1. 范围与不变量

| 能力 | 实现 |
| --- | --- |
| 会话与消息 | `GET/POST /api/glim/sessions`、`GET/POST /api/glim/sessions/:id/messages`，严格按 `ctx.user` 隔离 |
| 长期记忆 | `GET/PUT /api/glim/memory`，每用户一条，长度上限由 `memoryMaxChars` 控制 |
| 模型适配 | 只调用部署者提供的 `config.chatAdapter`；未配置返回 `409 glim.model_not_configured`，不生成任何模拟回复 |
| 连接登记 | `GET/POST /api/glim/connectors`，登记 `endpoint + capabilities`；不做局域网扫描、不探测未登记地址 |
| 授权 | `POST /api/glim/connectors/:id/grant`、`/revoke`，按 capability（read/write 分开）授权，撤销即时生效 |
| 工具 | `GET /api/glim/tools` 只返回已授权且 `implemented=true` 的能力；`POST /api/glim/tools/:name/invoke` 未授权 403、不兼容/未实现 409 |
| 身份 | 只信任 `ctx.user`；缺失时读 401、写 403；没有固定 owner 回落 |

关键约束：

- 所有数据按用户隔离；访问他人会话/连接返回 **403**。
- 未认证的写操作一律 **403**；未认证的读操作 **401**。
- 错误响应统一为 `{ code, message }`，不携带内部细节或密钥。
- 工具适配器不存在时返回 409，**不会**返回假数据。
- 只依赖 Node 内置模块与公共核心 `core/storage/json-store.js`。

## 2. 文件

```text
modules/glim/
  manifest.json          模块清单（通过 contracts/module-manifest.schema.json）
  config.schema.json     模块配置 schema（秘密只声明路径）
  server/index.js        统一模块入口：start/stop/health/routes/tools
  server/dev.js          本地 node:http 开发入口（127.0.0.1:0）
  tests/                 node:test 测试，直接调用 handler，不启动 HTTP
  README.md
```

`manifest.json` 的五个 connector 能力（Pages/Disk/Mail/Survey/Paper）当前均为 `implemented: false`，这是刻意声明“待完成”，避免用模拟适配器通过验收。

## 3. 统一模块接口

```js
const glim = require('./modules/glim/server/index.js');

await glim.start({ config, logger });   // config 见第 4 节；logger 可省略
const result = await glim.health();     // { ok: true, started, storage, model }
for (const route of glim.routes) {
  // route = { method, path, handler }
  // handler(ctx) => { status, body }
}
await glim.stop();                      // 保留数据，只清运行状态
```

`ctx` 形状：

```js
{
  req, res, url,
  params,   // 例如 { id, name }
  query,    // 普通对象或 URLSearchParams
  body,     // 已解析的 JSON
  user      // 可能为 null；有值时为公共身份 publicUser
}
```

所有路由都以 `/api/glim/` 开头。公共核心按 `manifest.activation.routePrefix` 装配，未启用模块不会注册这些路由。

## 4. 配置

完整 schema 见 [`config.schema.json`](./config.schema.json)。所有字段都可省略：

```json
{
  "dataFile": "/var/lib/pagesai/glim/store.json",
  "memoryMaxChars": 4000,
  "messageMaxChars": 8000,
  "historyLimit": 50,
  "systemPrompt": "这里是部署者提供的系统提示词，不接受请求体覆盖。",
  "chatAdapter": {
    "type": "openai-compatible",
    "endpoint": "https://model.example/v1/chat/completions",
    "model": "model-name",
    "timeoutMs": 30000
  },
  "allowConnectorRegistration": true,
  "requireAdminForConnectorRegistration": false,
  "trustedConnectorOrigins": ["https://pages.example", "https://mail.example"],
  "maxConnectorsPerUser": 20
}
```

- `dataFile` 省略或为 `null` 时使用**纯内存** `JsonStore`（测试/试用）；给定路径时原子替换写入，文件权限 `0600`。
- `chatAdapter.apiKey` 是声明秘密（`config.secrets = ["/chatAdapter/apiKey"]`），只能由部署秘密注入，禁止写进示例配置。
- `trustedConnectorOrigins` 一旦配置为非空数组，登记 endpoint 的 origin 必须精确匹配其中之一；空数组表示“登记动作本身即信任行为”。
- `requireAdminForConnectorRegistration=true` 时，只有 `ctx.user.role === 'admin'` 可登记 connector。

### 模型适配器

支持三种部署形态：

1. **进程内函数**（测试/嵌入）：`chatAdapter: async ({ messages, model, user, sessionId }) => ({ content: '...' })`
2. **对象方法**：`chatAdapter: { model, chat: async (ctx) => ... }` 或 `{ complete: ... }`
3. **OpenAI 兼容 HTTP**：`chatAdapter: { endpoint, model?, apiKey?, timeoutMs? }`，向 endpoint POST `{ model?, messages }`，读取 `choices[0].message.content`。

返回值可以是字符串，或含 `content` / `text` / `reply` / `message.content` / `choices[0].message.content` 的对象。取不到文本即视为失败，返回 `502 glim.model_failed`，不会伪造回复。

## 5. API

### 5.1 会话与消息

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/glim/sessions` | 当前用户会话列表（按更新时间倒序） |
| POST | `/api/glim/sessions` | 创建会话；body `{title?}`，默认“新会话” |
| GET | `/api/glim/sessions/:id` | 读取自己的会话 |
| DELETE | `/api/glim/sessions/:id` | 删除自己的会话及其消息 |
| GET | `/api/glim/sessions/:id/messages` | 读取消息；`?limit=1..200&before=<seq>` |
| POST | `/api/glim/sessions/:id/messages` | 追加用户消息并调用模型；body `{content}` |

`POST .../messages` 成功返回 `201`：

```json
{
  "userMessage": { "id": "...", "role": "user", "content": "你好" },
  "assistantMessage": { "id": "...", "role": "assistant", "content": "..." },
  "session": { "id": "...", "title": "...", "messageCount": 2 }
}
```

模型未配置时返回 `409 glim.model_not_configured`，且**不会写入任何消息**（避免半截对话和重试重复）。

### 5.2 对话

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/glim/chat` | 一次性补全（不落库）或带 `sessionId` 的持久对话 |

- `{content}`：一次性补全，返回 `{reply}`。
- `{messages:[{role:'user'|'assistant',content}]}`：由客户端提供历史，返回 `{reply}`；不接受 `system` 角色，系统提示只能来自部署配置。
- `{sessionId, content}`：在自己的会话中追加一轮，返回与 5.1 相同的结构（`201`）。

### 5.3 长期记忆

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/glim/memory` | `{content, updatedAt, maxChars}`；未写入时为 `''` / `null` |
| PUT | `/api/glim/memory` | body `{content}`；按 Unicode 码点计长度，超限返回 `400 glim.memory_too_long` |

### 5.4 连接与授权

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/glim/connectors` | 当前用户登记的 connector（含授权状态） |
| POST | `/api/glim/connectors` | 登记：`{name?, endpoint, version?, capabilities[]}` |
| GET | `/api/glim/connectors/:id` | 读取自己的 connector |
| DELETE | `/api/glim/connectors/:id` | 删除自己的 connector，同时清除其授权 |
| POST | `/api/glim/connectors/:id/grant` | body `{capabilities?: string[]}`；省略表示授权全部能力；重复 grant 取并集 |
| POST | `/api/glim/connectors/:id/revoke` | body `{capabilities?: string[]}`；省略表示撤销全部；撤销后下一次查询/调用立即失效 |

capability 形状：

```json
{
  "name": "pages_list_sites",
  "access": "read",
  "implemented": true,
  "externalEffect": false,
  "version": "1.0.0",
  "description": "列出站点"
}
```

- `name` 必须匹配 `^[a-z][a-z0-9_]{2,47}$`。
- `access` 只能是 `read` 或 `write`；授权按名称保存，天然区分读写。
- `implemented=false` 表示该能力尚待完成；即使已授权，调用也返回 409。
- 登记 connector **不等于**授权；必须再显式 grant。

信任边界：本模块只查询已登记的 connector，从不扫描局域网、不自动发现任意地址。`endpoint` 必须是绝对 `http/https` URL，且不得内嵌用户名/密码。

### 5.5 工具

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/glim/tools` | 只返回**已授权且 `implemented=true`** 的 capability |
| POST | `/api/glim/tools/:name/invoke` | body `{input?, access?}`；调用真实适配器 |

`GET /api/glim/tools` 返回项包含 `name/access/implemented/externalEffect/version/connectorId/connectorName/endpoint/adapterReady`。`adapterReady=false` 表示本机还没有注入同名适配器，调用会得到 409。

调用失败语义：

- 未授权（没有匹配的 grant）→ `403 glim.tool_not_authorized`。
- 已授权但 `implemented=false`、`access` 不匹配、或本机适配器缺失 → `409 glim.tool_incompatible`。
- 适配器抛出非业务错误 → `502 glim.tool_failed`。

本模块的 `tools` 导出目前为空对象。集成方可在部署代码中注入真实适配器：

```js
const glim = require('./modules/glim/server/index.js');
glim.tools.pages_list_sites = async (input, context) => {
  // context = { user, userId, connector, capability }
  return { sites: [] };
};
```

注意：只有 **manifest / connector 声明且用户已授权** 的同名能力才会被调用；工具名在路由层按白名单正则校验。

## 6. 本地开发入口

```bash
# 持续运行，stdout 只有一行 {"url":"http://127.0.0.1:PORT"}
node modules/glim/server/dev.js

# 冒烟：打印地址后立即退出
node modules/glim/server/dev.js --once

# 使用 JsonStore 文件与完整配置
node modules/glim/server/dev.js --data-file /tmp/glim.json --config /tmp/glim.config.json
```

- 只监听 `127.0.0.1:0`，不会占用固定生产端口。
- 开发身份用请求头 `x-glim-user: alice` 模拟；不带该头即未认证。`x-glim-role: admin` 可模拟管理员（仅用于本地验证授权策略）。
- `dev.js` 只用于本机开发，不能作为生产启动方式。

## 7. 测试

```bash
cd source/site/public-release/pagesai
node --test modules/glim/tests/*.test.js
```

测试**不启动 HTTP**，直接构造 fake `ctx` 调用 handler。当前覆盖：

- manifest 契约、config schema、入口导出与路由前缀；
- 无身份读 401 / 写 403；
- 会话与消息创建、模型回复、顺序/limit/before；
- 跨用户会话、消息、删除、记忆 403/不可见；
- 模型未配置 409、模型抛错 502、不落伪造消息；
- 记忆长度上限、清空、用户隔离；
- connector 登记校验、grant/revoke、按能力授权、撤销立即失效、跨用户拒绝、来源白名单、管理员/关闭登记策略、数量上限；
- `GET /tools` 只返回 implemented=true；invoke 403/409/成功路径（测试内注入真实适配器）；
- JsonStore 跨重启持久化、文件权限 0600、纯内存模式、损坏文件拒绝启动。

## 8. 已知缺口（未实现，不得宣称完成）

| 缺口 | 影响 | 后续 |
| --- | --- | --- |
| 五类 connector 的真实适配器均未实现 | manifest 中全部 `implemented:false`；工具调用只能走 409，或由集成方注入真实适配器 | 按模块逐个接入 Pages/Disk/Mail/Survey/Paper |
| 无 connector 健康探测/版本协商/自动发现 | 只能显式登记与授权；不验证远端在线状态 | 增加受信注册表与 health/version 契约 |
| 无审计日志与外部后果二次确认 | 写类工具调用只做授权检查，未记录可追溯审计 | 接入核心审计与授权票据 |
| 无流式输出、任务/定时、工作区/沙盒、渠道（微信/邮件） | 不是完整智能体运行时 | 按方案后续阶段实现 |
| 无前端页面与后台贡献 | 只有 server 模块 | 由 web/admin 负责 |
| JsonStore 无并发控制与事务 | 单进程使用；多进程并发写不安全 | 后续 MongoDB 适配器 |
| 无模型 token/费用统计、限流与配额 | 仅做长度上限 | 后续计量阶段 |
| 工具执行不校验远端服务状态 | 只按本地授权与 manifest/connector 的 implemented 判断 | 增加健康检查与调用前探测 |

## 9. 安全说明

- 不读取、不 require 旧 `source/site/glim` 或任何私人平台代码。
- 不写死 owner、主站地址、模型地址或密钥；身份只来自 `ctx.user`。
- 不扫描局域网；connector 必须显式登记，且可由部署白名单限制来源。
- 授权与撤销按请求实时计算；撤销后不缓存旧授权。
- 模型未配置、适配器失败、工具未实现时都失败关闭，不返回模拟业务结果。
