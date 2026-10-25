# Mail 模块

> **状态：发信、收件与网页邮箱已实现。** 统一发信接口、验证码（限流/时效）、幂等、收件列表/详情/删除、附件授权下载、HTML 净化、系统发件身份与用户发信权限分离均可用；**内置真实 SMTP/IMAP 协议客户端**（也可注入适配器），网页邮箱支持收发与删除。未实现：草稿、搜索、退信解析、附件上传。
>
> 自查：
>
> ```bash
> cd source/site/public-release/pagesai
> node modules/mail/server/dev.js --once
> node --test modules/mail/tests/*.test.js
> ```
>
> 预期：打印 `{"url":"http://127.0.0.1:PORT"}`；测试 `28 pass / 0 fail`。

## 1. 定位与边界

Mail 提供两件事：**系统发信**（验证码、通知）与**邮箱客户端能力**（收件列表、正文、附件、发送、删除）。

- 归属目录：`modules/mail/`（`manifest.json`、`config.schema.json`、`server/`）。
- 路由前缀：`/api/mail`。
- 系统发件身份固定为 `config.from`，用户不能伪造；普通用户发信由 `config.userSendEnabled` 单独开关。
- 外发记录区分 `transportStatus`（适配器是否受理）与 `deliveryStatus`（投递状态，未知为 `unknown`），不虚报「已投递」。

## 2. 依赖

### 2.1 必需基础设施

`manifest.requires.infrastructure = ["smtp", "imap"]`（声明），但**模块不内置协议实现**：

| 依赖 | 形态 | 说明 |
| --- | --- | --- |
| SMTP | 部署注入 `config.transport.sendMail` | 未配置 → `409 mail.transport_not_configured` |
| IMAP | 部署注入 `config.imap.*` 函数 | 未配置 → `409 mail.imap_not_configured` |
| 数据 | `core/storage/json-store.js` | 集合：`outbox`/`idempotency`/`verification`/`mailbox_index` |

不引入 `nodemailer`/`imapflow` 等第三方库（公开版禁止第三方依赖）。

### 2.2 模块间依赖

- 强依赖：无。
- 反向依赖：启用「邮箱验证注册」时，公共核心要求 Mail 已安装且已配置。核心通过模块导出的 `sendVerification()` / `isAvailable()` / `isConfigured()` 集成（当前 `createCore` 尚未自动注入，需装配层接线）。
- 可选：Glim 调用 Mail 需真实工具适配器（当前 `tools = {}`）。

### 2.3 运行时

- 只用 `node:*` 内置模块，不需要 `package.json`。
- 单进程 `JsonStore`；多实例部署需替换为共享存储并在适配器层保证原子性。

## 3. 单装步骤

### 3.1 独立运行

```bash
cd source/site/public-release/pagesai
node modules/mail/server/dev.js --config /tmp/mail-config.json
```

开发身份：`x-dev-user: <id>` 或 `Authorization: Bearer <id>`；缺省 `user=null`，写操作 403。JSON 配置只能表达可序列化字段，适配器函数仍需部署代码注入。

### 3.2 配置示例（占位值）

```json
{
  "dataFile": "/var/lib/pagesai/mail/store.json",
  "from": { "name": "PagesAI", "address": "noreply@example.com" },
  "userSendEnabled": false,
  "transport": { "provider": "smtp", "host": "smtp.example.com", "port": 587, "secure": false },
  "imap": { "provider": "imap", "host": "imap.example.com", "port": 993, "secure": true },
  "verification": { "public": false, "windowMs": 600000, "maxPerWindow": 5, "ttlMs": 600000, "maxAttempts": 5 }
}
```

`transport.password`、`transport.apiKey`、`imap.password` 是秘密（见 `manifest.config.secrets`），只允许部署注入。`sendMail`/`listMessages`/`getMessage`/`deleteMessage`/`getAttachment` 必须是部署代码注入的函数。

### 3.3 安装检查清单

- [ ] 未认证写 403。
- [ ] 未配置发信/收件适配器返回 409，不虚报成功。
- [ ] 用户不能伪造 `from`；系统发信不受 `userSendEnabled` 限制。
- [ ] 带 `idempotencyKey` 的重复/并发请求只调用一次适配器。
- [ ] 验证码：10 分钟 5 次、10 分钟有效、最多 5 次尝试；响应不泄露收件人是否存在。
- [ ] HTML 净化：脚本、`on*`、编码后的 `javascript:`、SVG 均被移除。
- [ ] 跨用户邮件 403；未知邮件 404；附件下载先校验所有权。

## 4. 能力清单

| 能力 | 状态 |
| --- | --- |
| 统一发信（内置 SMTP 或注入适配器） | 已实现 |
| 验证码发送与校验 | 已实现 |
| 幂等（顺序/并发/跨重启） | 已实现 |
| 收件列表、详情、单删/批删（内置 IMAP 或注入适配器） | 已实现 |
| 附件下载（所有权校验 + 类型加固） | 已实现 |
| HTML 净化 | 已实现 |
| 真实 SMTP/IMAP 协议栈 | 已实现（`providers/smtp.js`、`providers/imap.js`） |
| 网页邮箱（收发/删除） | 已实现（`modules/mail/web/`） |
| 草稿、搜索、退信解析、附件上传 | **未实现** |
| 对 Glim 的工具 | 已实现（4 个：列表/读取/删除/发信） |

## 5. 配置

`config.schema.json` 字段（全部可选）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dataFile` | `null` | JsonStore 路径；空 = 纯内存 |
| `from` | — | 系统发件身份（字符串或 `{name,address}`），用户不可覆盖 |
| `userSendEnabled` | `false` | 是否允许普通用户发信 |
| `sendTimeoutMs` | — | 单次发信超时 |
| `transport.*` | — | 适配器函数 + 非秘密连接参数；`password`/`apiKey` 为秘密 |
| `imap.*` | — | 收件适配器函数 + 连接参数；`password` 为秘密 |
| `verification.public` | `false` | 是否允许匿名请求验证码（注册前置） |
| `verification.windowMs` / `maxPerWindow` / `ttlMs` / `maxAttempts` | 10 分钟 / 5 / 10 分钟 / 5 | 验证码策略 |
| `attachments.maxBytes` | — | 附件大小上限 |

存储区域：`manifest.data.regions = ["mail.mailbox"]`，命名空间 `mail`。Maildir 不暴露给 Disk（`disk.visible=false`）。

## 6. 与 Glim 的连接

- 已声明 4 个工具：`mail_send`（write，对外后果）、`mail_list_messages`（read）、`mail_read_message`（read）、`mail_delete_message`（write，对外后果）。
- Glim 通过 `connectors/mail.js` 调用本模块 HTTP API；需先配置 SMTP/IMAP 才能真实收发与列出邮件。
- 落地要求：发件必须使用系统身份或受控身份，不能冒充任意发件人；对外后果操作逐次授权并审计；撤销后立即失效。
- 现状：Glim 侧 `mail_send` 为 `implemented:false`，调用返回 409。

## 7. 故障与卸载

| 场景 | 行为 |
| --- | --- |
| 发信适配器未配置 | `409 mail.transport_not_configured` |
| 收件适配器未配置 | `409 mail.imap_not_configured` |
| 发信适配器报错/超时 | 明确失败，记录 `failed`，不标记为已投递 |
| 验证码过频 | `429`；失败会回滚本次限流占位 |
| 跨用户邮件 | `403 mail.forbidden` |
| 停用 Mail | `stop()` 保留数据；`taskStopRules.drainTimeoutMs=2000`、`onStopFailure=keep-installed` |
| 卸载 Mail | 默认保留数据；若仍开启邮箱注册，核心启动会因依赖缺失而失败，需先改注册配置 |

## 8. 已知缺口

| ID | 缺口 |
| --- | --- |
| K6 | 无邮箱容量配额与用量统计 |
| K4 | 无网页邮箱 UI 与后台配置页 |
| K16 | 邮箱凭据依赖部署注入，公开包不得携带示例密码 |
| 非清单内 | 无真实 SMTP/IMAP 库、无附件上传/草稿/搜索/退信、无 DKIM、`deliveryStatus` 多为 `unknown` |

完整清单与来源见 [`docs/README.md`](../README.md#已知缺口清单)。