# Glim 模块

> **状态：可单独使用的智能体已实现，含五连接。** 会话、消息、长期记忆、模型适配、connector 登记/授权/撤销、工具清单与调用、任务控制、每用户工作区、网页端与后台贡献均可用；**五个真实 HTTP 连接器（pages/disk/mail/survey/paper）已实现**并有授权、撤销、能力发现与调用用例。未实现：流式输出、执行沙盒、外部渠道、connector 健康探测与审计日志。
>
> 自查：
>
> ```bash
> cd source/site/public-release/pagesai
> node modules/glim/server/dev.js --once
> node --test modules/glim/tests/*.test.js
> ```
>
> 预期：打印 `{"url":"http://127.0.0.1:PORT"}`；模块测试 `34 pass / 0 fail`（总聚合见 `node tools/test-all.js`）。

## 1. 定位与边界

Glim 是**可单独安装、单独运行**的智能体：会话与消息、每用户长期记忆、可配置模型适配、连接登记与授权、工具调用、任务控制、私有工作区。

- 归属目录：`modules/glim/`（`manifest.json`、`config.schema.json`、`server/`、`connectors/`、`web/`）。
- 路由前缀：`/api/glim`。
- 身份只信任 `ctx.user`；缺失时读 401、写 403，**没有固定 owner 回落**。
- 非目标：不实现登录、不扫描局域网、不生成模拟模型回复、不把未实现能力登记为可用。

## 2. 依赖

### 2.1 必需基础设施

`manifest.requires.infrastructure = []`：**无**外部基础设施依赖。

| 能力 | 依赖 | 说明 |
| --- | --- | --- |
| 会话/记忆 | `core/storage/json-store.js` | 纯内存或 `dataFile` 持久化（`0600`） |
| 模型 | 部署者提供的 `config.chatAdapter` | 未配置返回 `409 glim.model_not_configured`，不伪造回复 |
| 工具执行 | `connectors/` 的五个 HTTP 适配器 | 目标模块未安装/未授权返回 409/403，不伪造结果 |

### 2.2 模块间依赖

- 强依赖：无。仅装 Glim 即可对话、记忆、登记连接。
- 可选连接：`optionalConnections: ["pages", "disk", "mail", "survey", "paper"]`，五个连接器均已实现；目标模块未安装时连接调用返回明确错误。
- 连接失败不影响普通对话。

### 2.3 运行时

- 只用 `node:*` 内置模块，不需要 `package.json`。
- 当前实现是 Node 模块，不是独立 Python 服务；Python/FastAPI 形态未在公开版落地。

## 3. 单装步骤

### 3.1 独立运行

```bash
cd source/site/public-release/pagesai
node modules/glim/server/dev.js --data-file /tmp/glim.json
# 另开终端（开发身份）：
curl -s http://127.0.0.1:PORT/api/glim/sessions -H 'x-glim-user: alice'
```

开发身份：`x-glim-user: <id>`，管理员模拟 `x-glim-role: admin`。只用于本机。

### 3.2 配置模型

```json
{
  "dataFile": "/var/lib/pagesai/glim/store.json",
  "chatAdapter": {
    "type": "openai-compatible",
    "endpoint": "https://model.example.com/v1/chat/completions",
    "model": "example",
    "timeoutMs": 30000
  }
}
```

`chatAdapter.apiKey` 是秘密（`/chatAdapter/apiKey`），只允许部署注入。`chatAdapter` 也支持进程内函数（测试/嵌入）。

### 3.3 安装检查清单

- [ ] 仅 Glim 可运行，普通对话不依赖其他模块。
- [ ] 无身份读 401、写 403；跨用户会话/记忆/连接 403。
- [ ] 模型未配置 409；模型失败 502；不落伪造消息。
- [ ] 登记 connector 不等于授权；未 grant 调用 403。
- [ ] 撤销后下一次查询/调用立即失效。
- [ ] `GET /tools` 只返回已授权且 `implemented=true` 的能力。
- [ ] 重启后数据保留（`dataFile`）；纯内存模式清空；损坏文件拒绝启动。

## 4. 能力清单

### 4.1 自身能力

| 能力 | 状态 |
| --- | --- |
| 会话与消息 | 已实现 |
| 长期记忆（每用户一条，长度上限） | 已实现 |
| 模型适配（函数/对象/OpenAI 兼容 HTTP） | 已实现 |
| connector 登记、授权、撤销 | 已实现 |
| 工具清单与调用（五个 HTTP 连接器） | 已实现 |
| 任务控制（排队/运行/停止/重启恢复） | 已实现 |
| 每用户工作区（受控路径、大小上限） | 已实现 |
| 前端页面与后台贡献 | 已实现 |
| 流式输出、执行沙盒、外部渠道 | **未实现** |

### 4.2 五连接工具（全部已实现）

`manifest.capabilities.tools` 声明 37 个工具，按连接分布在 `connectors/`：

| 连接 | 工具 | 访问 | 对外后果 | 状态 |
| --- | --- | --- | --- | --- |
| Pages | `pages_list_sites`、`pages_read_site`、`pages_create_site`、`pages_write_file`、`pages_read_file`、`pages_delete_file`、`pages_preview_site`、`pages_publish_site` | read/write | 写操作有 | 已实现 |
| Disk | `disk_list_files`、`disk_list_folders`、`disk_read_file`、`disk_write_file`、`disk_move_file`、`disk_delete_file`、`disk_create_folder`、`disk_quota` | read/write | 写操作有 | 已实现 |
| Mail | `mail_list_messages`、`mail_read_message`、`mail_delete_message`、`mail_send` | read/write | 发信/删除有 | 已实现 |
| Survey | `survey_list`、`survey_read`、`survey_create`、`survey_update`、`survey_publish`、`survey_close`、`survey_responses`、`survey_stats`、`survey_export` | read/write | 写操作有 | 已实现 |
| Paper | `paper_search`、`paper_list_docs`、`paper_read_doc`、`paper_upload_doc`、`paper_translate_doc`、`paper_get_translation`、`paper_ask_doc`、`paper_delete_doc` | read/write | 写操作有 | 已实现 |

未授权调用返回 403；连接不可达或目标模块未安装返回 502/409，不会返回模拟数据。

## 5. 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dataFile` | `null` | JsonStore 路径；空 = 纯内存 |
| `memoryMaxChars` | 4000 | 每用户记忆上限（Unicode 码点） |
| `messageMaxChars` | 8000 | 单条消息上限 |
| `historyLimit` | 50 | 调用模型时携带的历史条数 |
| `systemPrompt` | — | 仅部署配置，不接受请求体覆盖 |
| `chatAdapter` | — | 模型适配器；未配置 409 |
| `chatAdapter.apiKey` | — | **秘密**（`/chatAdapter/apiKey`） |
| `allowConnectorRegistration` | `true` | 是否允许用户登记 connector |
| `requireAdminForConnectorRegistration` | `false` | 登记是否要求管理员 |
| `trustedConnectorOrigins` | `[]` | 非空时 endpoint origin 必须精确匹配 |
| `maxConnectorsPerUser` | 20 | 每用户 connector 上限 |

存储区域：`manifest.data.regions = ["glim.state"]`，命名空间 `glim`。

## 6. 与 Glim 的连接（五连接实现状态）

| 连接 | 目标能力 | 实现状态 | 外部条件 |
| --- | --- | --- | --- |
| Pages | 创建站点、发布、读写文件 | 已实现（`connectors/pages.js`） | 目标模块已安装且 URL 可达 |
| Disk | 列文件、读写、移动、删除、配额 | 已实现（`connectors/disk.js`） | 同上 |
| Mail | 发信、收件列表/详情/删除 | 已实现（`connectors/mail.js`） | 收发还需配置 SMTP/IMAP |
| Survey | 创建、发布、读答卷、统计、导出 | 已实现（`connectors/survey.js`） | 目标模块已安装 |
| Paper | 检索、上传、翻译、问答 | 已实现（`connectors/paper.js`） | 翻译/问答需模型适配器 |

连接语义（已实现）：

1. **显式登记**：`POST /connectors` 登记 `endpoint + capabilities`；不做局域网扫描。
2. **来源白名单**：`trustedConnectorOrigins` 非空时精确匹配 origin。
3. **登记 ≠ 授权**：必须 `POST /connectors/:id/grant`；重复 grant 取并集。
4. **撤销即时**：`POST /connectors/:id/revoke` 后下一次查询/调用立即失效。
5. **能力过滤**：`GET /tools` 只返回已授权且 `implemented=true` 的能力（`implemented` 由适配器能力决定）。
6. **失败语义**：未授权 403 `glim.tool_not_authorized`；未实现/不兼容 409 `glim.tool_incompatible`；适配器/目标异常 502 `glim.tool_failed`。
7. **端点校验**：必须是绝对 `http/https` URL，且不得内嵌用户名/密码。

未实现：connector 健康探测、版本协商、自动发现、审计日志、外部后果二次确认。

## 7. 故障与卸载

| 场景 | 行为 |
| --- | --- |
| 模型未配置 | `409 glim.model_not_configured` |
| 模型失败 | `502 glim.model_failed`，不落伪造消息 |
| 工具未授权 | `403 glim.tool_not_authorized` |
| 工具未实现/适配器缺失 | `409 glim.tool_incompatible` |
| connector 来源不匹配 | 登记被拒（`trustedConnectorOrigins`） |
| 停用 | `stop()` 保留会话、记忆与 connector 登记 |
| 卸载 | 默认保留数据；撤销授权由部署/核心处理 |

## 8. 已知缺口

| ID | 缺口 |
| --- | --- |
| ~~K8~~ | **已关闭**：五个 HTTP 连接器（pages/disk/mail/survey/paper）已实现，授权、撤销、能力发现与调用均有测试 |
| ~~K4~~ | **已关闭**：网页端与后台贡献已接入（`modules/glim/web/`、`server/admin.js`） |
| K6 | 无 token/费用统计、限流与配额，只有消息/记忆长度上限 |
| 非清单内 | 无 connector 健康探测/版本协商；无审计日志；无流式输出、执行沙盒（`sandbox/` 为空）、外部渠道 |

完整清单与来源见 [`docs/README.md`](../README.md#已知缺口清单)。