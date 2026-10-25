# 故障排查

先分诊，再查错误码。所有命令都在公开版根目录执行：

```bash
cd source/site/public-release/pagesai
```

## 1. 五分钟分诊

```bash
# 1) Node 版本（需要 >= 18）
node --version

# 2) 契约与核心
node --test tests/contracts/*.test.js

# 3) 六个模块
for m in pages disk glim mail survey paper; do
  node --test modules/$m/tests/*.test.js
done

# 4) 模块能否单独启动
node modules/pages/server/dev.js --once

# 5) 核心是否活着（若已启动）
curl -s http://127.0.0.1:8787/healthz; echo
curl -s http://127.0.0.1:8787/readyz; echo
curl -s http://127.0.0.1:8787/api/modules; echo

# 6) 配置是否按预期解析（不打印秘密）
node -e '
const { loadConfig } = require("./core/config");
const c = loadConfig({ env: process.env });
console.log({ dataRoot: c.dataRoot, installRoot: c.installRoot, installedModules: c.installedModules,
  registration: c.registration, sessionTtlMs: c.sessionTtlMs, bootstrapTokenSet: Boolean(c.bootstrapToken) });
'
```

预期：契约 `40 pass / 0 fail`；模块合计 `148 pass / 0 fail`；`dev.js --once` 打印 `{"url":"http://127.0.0.1:PORT"}`。

## 2. 核心错误码

错误响应统一为 `{"code","message"}`，`code` 稳定、可判断，`message` 可安全展示且不含秘密。

### 2.1 注册与登录

| 错误码 | HTTP | 含义 | 处置 |
| --- | --- | --- | --- |
| `INVALID_INPUT` | 400 / 413 | 字段非法，或请求体过大 | 按 `message` 修参数；核心上限 64 KiB |
| `USERNAME_TAKEN` | 409 | 用户名被占用（大小写不敏感） | 换名 |
| `USERNAME_RESERVED` | 400 | 命中保留名（`admin`、`root` 等） | 换名 |
| `WEAK_PASSWORD` | 400 | 口令不在 8–200 或全为空白 | 改口令 |
| `INVALID_CREDENTIALS` | 401 | 用户名或密码错误（不区分） | 检查输入 |
| `ACCOUNT_DISABLED` | 403 | 账号被停用 | 管理员恢复 |
| `EMAIL_UNVERIFIED` | 403 | 邮箱注册未验证 | 完成验证 |
| `REGISTRATION_CLOSED` | 403 | 公开注册关闭 | 开启注册或使用既有账号 |
| `VERIFICATION_INVALID` | 400 | 验证码错误/过期 | 重新获取 |
| `VERIFICATION_RATE_LIMITED` | 429 | 发送过频或尝试过多 | 等窗口结束 |
| `MAIL_MODULE_REQUIRED` | 409 / 500 | 邮箱注册开启但未装 Mail | 装 Mail 或关闭邮箱注册 |
| `MAIL_NOT_CONFIGURED` | 409 | Mail 未配置发信 | 配置 SMTP 适配器 |

### 2.2 会话与权限

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `SESSION_INVALID` | 401 | 缺少/无效/过期会话 |
| `SESSION_REVOKED` | 401 | 会话被撤销（`authVersion` 变化） |
| `FORBIDDEN` | 403 | 已登录但无权限，或引导令牌错误 |
| `NOT_FOUND` | 404 | 资源或接口不存在 |
| `BOOTSTRAP_CLOSED` | 409 | 管理员引导已完成 |
| `LAST_ADMIN_PROTECTED` | 409 | 不能删除/停用/降级最后一名管理员 |

### 2.3 模块与存储

| 错误码 | HTTP | 含义 | 处置 |
| --- | --- | --- | --- |
| `MODULE_NOT_INSTALLED` | 409 | 模块未登记 | 先 `install` |
| `MODULE_NOT_READY` | 409 / 500 | 入口加载失败、缺生命周期函数、`start()` 抛错 | 看 `describe(id).startError` |
| `CONFIG_INVALID` | 409 / 500 | 配置不完整、清单非法、持久化损坏 | 按 `details.errors` 修 |
| `CONFLICT` | 409 | 同 `operationId` 不同内容，或重复登记 | 换 ID / 先卸载 |
| `REGION_UNKNOWN` | 404 | 区域未登记 | 登记区域 |
| `REGION_NOT_AUTHORIZED` | 403 | 归属/操作/所有权/Disk 只读不允许 | 检查调用方 |
| `PATH_ESCAPE` | 400 / 500 | 绝对路径、反斜杠、`..`、空字节、越界 | 用区域内相对路径 |
| `IMPLICIT_DATA_ROOT_CHANGE` | 409 | 区域物理根变化未确认 | 恢复原配置或显式确认 |

## 3. 模块错误码

### 3.1 Pages

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `pages.ai_not_configured` | 409 | 未注入 AI 适配器（不会生成模拟内容） |
| `pages.ai_failed` | 502 | 适配器报错 |
| `pages.ai_timeout` | 504 | 适配器超时（默认 60s） |
| `pages.ai_invalid_result` | 502 | 返回空/无法识别/无实际变更/内容超限 |
| `pages.unsupported_file_type` | 400 | 扩展名不在允许列表 |
| `pages.no_previous_version` | 409 | 没有更早版本可回滚 |
| `PATH_ESCAPE` | 400 | 虚拟路径越界（`..`、绝对路径、盘符、编码绕过） |

### 3.2 Disk

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `REGION_NOT_EXPOSED` | 404 | 区域不在 `config.regions` |
| `DISK_ADAPTER_NOT_CONFIGURED` | 409 | `object-storage` 适配器未实现/未配置 |
| `FILE_TOO_LARGE` | 413 | 单文件超过 `maxFileBytes` |
| `CONFLICT` | 409 | `baseRevision`/`operationId` 冲突，不覆盖新内容 |
| `NOT_FOUND` | 404 | 文件/上传任务不存在 |

分享过期或撤销后公开读取不可用（撤销返回 `410`）；空文件 Range 返回 `416`。

### 3.3 Glim

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `glim.model_not_configured` | 409 | 未配置 `chatAdapter` |
| `glim.model_failed` | 502 | 模型返回不可解析或无文本 |
| `glim.tool_not_authorized` | 403 | 未 grant 对应能力 |
| `glim.tool_incompatible` | 409 | 未实现、access 不匹配或本机无适配器 |
| `glim.tool_failed` | 502 | 适配器抛错 |

### 3.4 Mail

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `mail.transport_not_configured` | 409 | 未注入 `transport.sendMail` |
| `mail.imap_not_configured` | 409 | 未注入收件适配器 |
| `mail.forbidden` | 403 | 邮件属于其他用户 |
| `mail.message_not_found` | 404 | 未知邮件（不猜测存在性） |

验证码过频 `429`；未认证写 `403`。

### 3.5 Survey

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `MODULE_NOT_READY` | 503 | 模块未 `start()` |
| `SURVEY_CLOSED` | 409 | 问卷已关闭，拒绝新答卷 |
| `ATTACHMENT_STORAGE_NOT_CONFIGURED` | 409 | 未配置 `dataFile` 却含文件题 |
| `FORBIDDEN` | 403 | 跨用户操作 |

### 3.6 Paper

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `paper.translate_not_configured` | 409 | 未配置翻译适配器 |
| `paper.qa_not_configured` | 409 | 未配置问答适配器 |
| `paper.translate_in_progress` | 409 | 同论文同语言正在翻译 |
| `paper.extract_failed` | 422 | 无文本层/加密/不支持字体，不落库 |
| `paper.translate_failed` | 502 | 适配器报错或返回条数不等，保留已完成句 |
| `paper.qa_failed` | 502 | 问答适配器故障 |
| `paper.search_unavailable` / `search_failed` / `search_empty` | — | 检索降级原因（在 `degraded.code`） |

## 4. 常见症状

| 症状 | 最可能原因 | 处理 |
| --- | --- | --- |
| 经核心上传 Paper 返回 413 | 核心请求体上限 64 KiB（Base64 后约 48 KiB 原件） | 用 `modules/paper/server/dev.js` 本地验证；生产需调大核心上限 |
| 模块路由 404 | 模块未登记、未启用，或配置不完整 | 查 `/api/modules` 与 `describe(id)` |
| `enable` 返回 `CONFIG_INVALID` | 模块配置缺必填/不匹配 schema | 看 `details.errors` 的 `path` |
| `enable` 返回 `MODULE_NOT_READY` | 入口缺 `start/stop/health` 或 `start()` 抛错 | 看 `startError` |
| `dev.js` 写操作 403 | 没带开发身份头（`x-pages-user-id`、`x-dev-user`、`x-glim-user` 等） | 加对应头（仅本地） |
| `dev.js` 启动即退出 | 参数错误/端口被占 | 看 stderr |
| Mail 发信 409 | JSON 配置无法携带函数适配器 | 在部署代码注入 `transport.sendMail` |
| Glim 对话 409 | 未配置 `chatAdapter` | 注入适配器 |
| Pages AI 409 | 未注入 `aiAdapter` | 注入适配器 |
| 核心启动失败 `MAIL_MODULE_REQUIRED` | 邮箱注册开启但未装 Mail | 加 `mail` 或关闭邮箱注册 |
| 核心启动失败「会话有效期不得小于」 | `PAGESAI_SESSION_TTL_MS` < 300000 | 调大或删除 |
| 改数据根后仍读写旧目录 | 隐式换根被拒，或基线硬编码（K13） | 查 `IMPLICIT_DATA_ROOT_CHANGE`；核对硬编码 |
| 持久化文件存在但启动失败 | 损坏或格式版本不支持 | 从备份恢复，不要删文件重建 |
| `EADDRINUSE` | 端口被占用 | 换端口或停占进程 |
| 模块用例全过、集成用例失败 | `module-mount` 用例使用保留用户名 `root` | 属用例问题，见下 |

## 5. 业务路由 404 的正确理解

未安装/未启用模块**必须**没有任何可调用路由：

```bash
for p in pages disk survey paper glim mail; do
  printf '%s ' "$p"
  curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:8787/api/$p/ping"
done
```

预期全部 `404`。若某个前缀返回 200/401，说明存在「隐藏但可调用」的接口，属于必须修复的问题。

## 6. 已知的用例问题

`tests/integration/module-mount.test.js` 的「管理接口可启用/停用模块」用例用保留用户名 `root` 引导管理员，稳定得到 `400 USERNAME_RESERVED`。这是用例自身问题，不代表模块装配不可用；单模块装配可用 `docs/guides/install.md` §4.2 的命令验证。

## 7. 收集诊断信息

报告问题时请附（**不要**附密钥、Token、真实用户数据）：

1. `node --version`、操作系统。
2. 相关测试命令的末尾统计。
3. `GET /readyz` 响应。
4. 错误的 `code` 与 `details`（不要贴完整请求头与 Cookie）。
5. 复现步骤与期望结果。

当前没有结构化日志与日志分级（`ModuleHost` 的 logger 默认空实现），只能收集进程 stdout/stderr。这是 K4/G01 的待补能力。

## 8. 已知缺口

| ID | 与本篇相关的影响 |
| --- | --- |
| K1 | 重启丢会话，容易误判为「登录失效」 |
| K2 | 核心无持久化状态文件，重启后区域/变更日志消失 |
| K4 | 无后台诊断页与模块状态卡 |
| K13 | 硬编码数据根导致「改了配置却没生效」难定位 |
| K5 | 无安装器，装配需手写命令 |

完整清单与来源见 [`docs/README.md`](../README.md#已知缺口清单)。