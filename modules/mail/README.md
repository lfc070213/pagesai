# Mail（发信与邮箱客户端）

PagesAI 公开版 Mail 模块，对应施工方案 §7.5。只使用 Node 内置模块与公共核心（`core/errors.js`、`core/storage/json-store.js`），不依赖任何第三方包。

## 范围与边界

已实现的最小闭环：

1. **统一发信**：`POST /api/mail/send` 使用内置 SMTP 客户端（`transport.provider=smtp`）或部署注入的 `config.transport.sendMail`；未配置时返回 `409 mail.transport_not_configured`，绝不虚报已发送。
2. **验证码**：`POST /api/mail/verification` 默认 10 分钟窗口最多 5 次，验证码 10 分钟有效；响应与收件人是否存在无关。
3. **幂等**：带 `idempotencyKey` 的重复请求返回首次结果，不重复调用发信适配器；并发重复请求合并为一次。
4. **收件**：`GET/DELETE /api/mail/messages`；内置 IMAP 客户端（`imap.provider=imap`）或部署注入适配器；未配置时返回 `409 mail.imap_not_configured`。
5. **附件**：发信支持 Base64 附件；收件解析 multipart 附件，下载前校验当前用户对邮件的所有权。
6. **网页邮箱**：`/mail` 提供收件列表、正文、附件下载、删除、写邮件（含附件）与状态提示。
7. **安全**：HTML 白名单净化（去除 `script`、`on*`、`javascript:` 等）；系统发件身份固定为 `config.from`，普通用户发信由 `config.userSendEnabled` 单独开关，用户不能伪造 `from`。
8. **状态分离**：外发记录区分 `transportStatus`（适配器是否受理）、`deliveryStatus`（投递状态，未知时为 `unknown`）与失败记录。

明确不在本模块内：

- 登录、会话与密码校验（使用公共核心的身份服务）；
- 完整自建邮件服务器（DKIM、退信解析、Maildir 扫描、垃圾邮件过滤）；
- 草稿箱同步、全文搜索、文件夹创建/重命名；
- 平台明文密码存储：邮箱凭据只来自配置秘密字段或部署注入的解析器。

## 文件

```text
modules/mail/
  manifest.json          模块清单（通过 contracts/module-manifest.schema.json）
  config.schema.json     配置 JSON Schema
  server/index.js        统一模块接口 + 路由 + 发信/收件/验证码/净化
  server/dev.js          开发用 node:http 挂载器（--once 打印 URL 后退出）
  providers/smtp.js      内置 SMTP 客户端（net/tls、STARTTLS、AUTH、MIME）
  providers/imap.js      内置 IMAP 客户端（EXAMINE/SELECT、UID FETCH、MIME 解析）
  web/                   网页邮箱（由核心以 /mail 同源静态提供）
  tests/*.test.js        node:test，直接调用 handler 或本地假 SMTP/IMAP
  README.md
```

## 模块接口

`server/index.js` 使用 CommonJS 导出：

```js
module.exports = {
  async start({ config, logger, imapCredentialsFor }) {},
  async stop() {},
  async health() { return { ok: true, ... }; },
  routes: [{ method, path, handler }],
  tools: {
    mail_list_messages, mail_read_message, mail_send, mail_delete_message
  },
  // 可选集成面：供核心身份服务直接装配
  async sendVerification({ to, code, purpose }),
  isAvailable(),
  isConfigured()
};
```

- `handler(ctx)` 返回 `{ status, body }`；`ctx = { req, res, url, params, query, body, user }`。
- `body` 已由宿主解析，`user` 可能为 `null`。
- `tools` 与 manifest 的 `capabilities.tools` 同名，调用时复用同一套处理函数（权限、幂等、所有权、净化完全一致）。
- `start` 的 `imapCredentialsFor(user)` 是可选的部署注入解析器，返回 `{ user, password }` 或 `false`；模块不会把返回值写入数据文件。
- 错误统一返回 `{ code, message }`，不返回内部堆栈或秘密。
- 所有路由都以 `/api/mail/` 开头。

## 路由

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/mail/send` | 必须 | 用户发信；需 `userSendEnabled=true`，`from` 固定为系统身份 |
| POST | `/api/mail/verification` | 默认必须 | 发送验证码；`verification.public=true` 时允许匿名注册前置流程 |
| POST | `/api/mail/verification/verify` | 默认必须 | 校验验证码；与发送共用 `public` 策略 |
| GET | `/api/mail/messages` | 必须 | 收件列表；支持 `folder`、`limit`、`offset`；适配器返回正文时一并净化 |
| DELETE | `/api/mail/messages` | 必须 | 批量删除；body `{ ids, folder? }` 或 query `?ids=` |
| GET | `/api/mail/messages/:id` | 必须 | 邮件详情（正文 HTML 已净化） |
| DELETE | `/api/mail/messages/:id` | 必须 | 删除单封邮件 |
| GET | `/api/mail/messages/:id/attachments/:attachmentId` | 必须 | 下载附件（JSON base64，先校验所有权） |

所有写操作在未认证时返回 `403`；唯一例外是显式开启 `verification.public=true` 的验证码发送/校验流程（供注册前置流程使用）。收件接口只返回当前用户邮箱的邮件；索引记录中属于其他用户的邮件返回 `403 mail.forbidden`，完全未知的邮件返回 `404 mail.message_not_found`（不猜测存在性）。

## 配置

```json
{
  "dataFile": "/var/lib/pagesai/mail/mail.json",
  "from": { "name": "PagesAI", "address": "no-reply@example.com" },
  "userSendEnabled": false,
  "verification": {
    "public": false,
    "windowMs": 600000,
    "maxPerWindow": 5,
    "ttlMs": 600000,
    "maxAttempts": 5
  },
  "attachments": { "maxBytes": 20971520 }
}
```

- `dataFile` 缺省或为 `null` 时使用纯内存 `JsonStore`，进程退出即丢弃；给出路径时原子落盘。
- `from` 支持字符串或 `{ name, address }`；用户发信一律使用它，客户端传入 `from` 会被拒绝。
- `transport` / `imap` 优先使用内置协议客户端；也可以由部署代码注入函数适配器。

内置 SMTP/IMAP 示例（密码请通过核心秘密配置注入，或由安装器写入受限权限文件，不要提交到仓库）：

```json
{
  "dataFile": "/var/lib/pagesai/mail/mail.json",
  "from": { "name": "PagesAI", "address": "no-reply@example.com" },
  "userSendEnabled": true,
  "transport": {
    "provider": "smtp",
    "host": "smtp.example.com",
    "port": 587,
    "secure": false,
    "user": "no-reply@example.com",
    "password": "由秘密配置提供",
    "requireTls": true
  },
  "imap": {
    "provider": "imap",
    "host": "imap.example.com",
    "port": 993,
    "secure": true,
    "user": "alice@example.com",
    "password": "由秘密配置提供",
    "maxMessageBytes": 1048576
  }
}
```

- SMTP：`secure=true` 直连 TLS（通常 465）；`secure=false` 时服务器支持 STARTTLS 就自动升级，`requireTls=true` 会拒绝无 TLS 的服务器。认证优先 `AUTH PLAIN`，其次 `AUTH LOGIN`。
- IMAP：`secure=true` 直连 TLS（通常 993）；`secure=false` 时优先 STARTTLS。只有显式 `allowInsecure=true` 才允许完全明文连接（仅建议本机或可信内网）。
- `imap.userFrom` 可设为 `email` 或 `username`，用当前登录用户身份作为 IMAP 账号；密码仍来自配置或 `imapCredentialsFor`。
- `maxMessageBytes` 控制单封邮件抓取上限（默认 1 MiB）；被截断的正文或附件会如实缺失，不会伪造。
- 凭据只在内存中使用，不写入 `JsonStore`；日志与错误响应不会输出密码。

也可以继续注入函数适配器：

```js
const mail = require('./modules/mail/server/index.js');

await mail.start({
  config: {
    dataFile: '/var/lib/pagesai/mail/mail.json',
    from: { name: 'PagesAI', address: 'no-reply@example.com' },
    userSendEnabled: true,
    transport: {
      async sendMail(message) {
        // message = { from, to, subject, text, html, attachments, meta }
        // 返回 { accepted: true, messageId, deliveryStatus? }
        return smtp.send(message);
      }
    },
    imap: {
      async listMessages({ user, folder, limit, offset }) {},
      async getMessage({ user, folder, id }) {},
      async deleteMessage({ user, folder, id }) {},
      async getAttachment({ user, folder, messageId, attachmentId }) {}
    }
  },
  logger: console
});
```

`config` 中的秘密字段 `/transport/password`、`/imap/password` 已在清单中标记，日志与错误响应都不会输出它们。

## 适配器契约

内置 `providers/smtp.js` 与 `providers/imap.js` 实现下述契约；注入自定义适配器时同样适用。

### `transport.sendMail(message)`

```js
{
  from: { name?: string, address: string },
  to: [string],
  subject: string,
  text: string,
  html: string,              // 已净化
  attachments: [{ filename, contentType, content: Buffer }],
  meta: { module: 'mail', kind: 'user'|'verification'|'system', outboxId }
}
```

返回值建议：

```js
{ accepted: true, messageId: '...', deliveryStatus: 'unknown'|'delivered'|'deferred'|'failed' }
```

- 抛错、`accepted: false`、`accepted: []`、`ok: false` 或 `error` 都会被视为失败（`502 mail.send_failed`），不会写成已发送。
- 适配器应自行处理 SMTP 连接、TLS、认证与重试；本模块只负责幂等、状态与审计记录。
- 调用超时由 `sendTimeoutMs` 控制，默认 30 秒。
- 内置 SMTP 每次发信独立连接，完成 DATA 后 QUIT；不对收件人做隐式重试，失败如实记录。

### `imap` 适配器

- `listMessages({ user, folder, limit, offset })`：返回 `{ messages, total }` 或消息数组。
- `getMessage({ user, folder, id })`：返回单封邮件；不提供时详情回退到列表时缓存的摘要。
- `deleteMessage({ user, folder, id })`：删除单封邮件。
- `getAttachment({ user, folder, messageId, attachmentId })`：返回 `{ filename, contentType, contentBase64 }`（也接受 `content: Buffer`）。
- `user` 是 `{ id, username, email }`，适配器必须按该用户隔离数据；模块自身再按索引做跨用户检查。
- 消息 `id` 必须稳定且在同一用户邮箱内唯一；缺少 `id` 会被视为适配器错误（`502`），不会伪造 ID。
- 内置 IMAP 以 UID 作为邮件 `id`，附件 `id` 为稳定的 `part.N`；每次操作独立登录并在结束时 LOGOUT。删除使用 `UID STORE +FLAGS.SILENT (\Deleted)`，有 UIDPLUS 时用 `UID EXPUNGE` 只清理目标邮件，否则降级 `EXPUNGE`。

## 网页邮箱

核心在 Mail 已启用时以同源静态资源提供：

- `/mail`、`/mail/`：单页邮箱；
- `/mail-app.js`、`/mail-app.css`：脚本与样式。

页面不含身份或邮件内容，所有数据通过同源 Cookie 调用 `/api/mail/*`。功能包括文件夹切换、分页列表、正文阅读、附件下载、删除、写邮件（多附件、纯文本/HTML）与 SMTP/IMAP/用户发信状态提示。服务端文本一律用 `textContent` 写入；只有服务端已净化的 HTML 正文使用 `innerHTML`。CSP 限制为同源脚本、样式与连接，远程图片不会自动加载。

## 验证码

- 默认窗口 `10 分钟`、最多 `5 次`、验证码 `10 分钟`有效、最多尝试 `5 次`，均可在 `config.verification` 中调整。
- 限流键是规范化后的收件邮箱；计数独立于验证是否成功，避免“验证后立刻重置限流”。
- 发送失败会回滚本次限流占位，允许用户重试。
- 响应固定为 `{ ok: true, status: 'accepted', expiresIn }`，不返回验证码，也不返回账号是否存在。
- 验证码只以 `sha256(salt + ':' + code)` 形式保存在 `JsonStore`，外发记录不保存验证码正文。
- 默认要求登录。邮箱注册等前置流程需要匿名发送时，显式设置 `verification.public=true`；核心身份服务也可以直接调用模块导出的 `sendVerification()`（该方法不做用户权限判断，由调用方负责限流）。

## HTML 净化

- 标签白名单：`a/p/br/div/span/strong/b/em/i/u/s/blockquote/pre/code/ul/ol/li/table/thead/tbody/tfoot/tr/th/td/h1-h6/hr/img`。
- 属性白名单：链接 `href/title/rel/target`，图片 `src/alt/title/width/height`，表格单元格 `colspan/rowspan`。
- 丢弃 `script/style/iframe/object/embed/svg/math/form` 等标签及其内容。
- 丢弃 `on*` 事件属性、`style`、`srcset`、`formaction` 等未列出的属性。
- URL 只允许 `http:`、`https:`、`mailto:`（图片只允许 `http/https`），并做实体解码、控制字符剔除与协议相对地址拒绝，覆盖 `java&#x61;script:` 等编码绕过。
- 外发 HTML 与收件 HTML 都会净化；附件下载响应带 `disposition: "attachment"`，危险类型（`text/html`、`image/svg+xml` 等）降级为 `application/octet-stream`。宿主应据此以附件方式返回，不得内联渲染。

## 数据

使用核心 `JsonStore`，默认纯内存；`config.dataFile` 指向文件时持久化。集合：

- `outbox`：外发审计记录（不含正文与验证码），含 `status`、`transportStatus`、`deliveryStatus`、`providerMessageId`、`attempts`。
- `idempotency`：`userId + idempotencyKey` 的首次响应与内容指纹。
- `verification`：验证码哈希、过期时间、限流窗口与尝试次数。
- `mailbox_index`：当前用户已见过的邮件摘要与所有权索引，用于跨用户 403 与附件授权。

## 开发服务器

```bash
node modules/mail/server/dev.js
# stdout: {"url":"http://127.0.0.1:PORT"}

node modules/mail/server/dev.js --once
# 打印 URL 后立即退出（用于冒烟）

node modules/mail/server/dev.js --config ./mail-config.json
```

开发服务器不是生产入口。它不实现登录：请求头 `x-dev-user: <id>`（或 `Authorization: Bearer <id>`）会被当作当前用户；不提供时 `user=null`，写操作仍返回 403。JSON 配置文件可表达 `provider=smtp/imap` 的内置适配器字段；函数型适配器仍需部署代码注入。

## 测试

```bash
cd modules/mail
node --test tests/*.test.js
```

测试直接调用 `handler(fake ctx)`，或使用只监听 `127.0.0.1` 的假 SMTP/IMAP 服务器验证真实协议；不连接任何外部邮件服务。覆盖：

- manifest 契约与 config schema；
- 统一接口、Glim 工具与 `/api/mail/` 路由前缀；
- 未认证写操作 403；
- 未配置发信/收件适配器 409；
- 系统 `from` 与用户发信权限分离；
- 发送成功、失败、空受理；
- 幂等（顺序、并发、跨用户、持久化重启）；
- 验证码 429、10 分钟 TTL、匿名注册模式、不泄露收件人是否存在；
- HTML 净化（脚本、事件属性、编码后的 `javascript:`、SVG）；
- 收件列表/详情、跨用户 403、附件授权与文件名/类型加固、单删/批删、适配器异常；
- 内置 SMTP：EHLO、AUTH PLAIN、MAIL/RCPT/DATA、MIME 头编码、multipart 与附件；
- 内置 IMAP：LOGIN、EXAMINE、UID SEARCH/FETCH、multipart 正文/附件解析、分页、删除与跨用户隔离。

## 已知缺口

- 内置 SMTP/IMAP 只覆盖常规投递/收件路径：不支持 OAuth2/XOAUTH2、S/MIME、PGP、IDLE 推送、邮件全文搜索与草稿同步。
- HTML 正文中的远程图片被 CSP 阻止，不提供“加载远程图片”开关；`cid:` 内联图片暂不重写为本地附件。
- 单封邮件抓取上限内截断的附件会如实缺失；超大邮箱分页依赖 `UID SEARCH ALL`，未做服务器端日期过滤。
- `deliveryStatus` 仅透传适配器返回；没有独立投递回执通道时保持 `unknown`。
- 幂等与限流状态存在单进程 `JsonStore` 中；多实例部署需把 `JsonStore` 换成共享存储并在适配器层保证原子性。
- 邮箱凭据不写入模块数据；需要“每用户独立邮箱账号”时，由部署注入 `imapCredentialsFor` 并从加密凭据服务读取，公开版不内置凭据保险箱。
- 尚未完成对真实第三方 SMTP/IMAP 服务的联调（需负责人提供隔离测试邮箱与发件额度）；本地假服务器测试已覆盖协议与安全边界。
