# Survey · 自有简易问卷（方案 §7.6）

PagesAI 公开版的 Survey 业务模块：新建/编辑问卷、发布快照、公开链接匿名填写、关闭、答卷查询、基础统计、CSV 导出与文件题附件。

只依赖 Node 内置模块与公共核心（`core/errors.js`、`core/storage/json-store.js`）。**不依赖** MongoDB、Mail、Disk、Glim、AI 或任何第三方包；未安装 Disk 时文件题仍可用。

## 目录

```text
modules/survey/
  manifest.json          # 模块清单（通过 contracts/module-manifest.schema.json）
  config.schema.json     # 模块配置 schema
  server/index.js        # 生命周期、路由与业务实现（CommonJS）
  server/dev.js          # 独立 node:http 开发入口
  web/index.html         # 同源控制台与公开填写页（#fill/<slug>）
  web/app.js             # 控制台逻辑；textContent 写入所有服务端文本
  web/app.css            # 响应式样式
  tests/survey.test.js   # node:test；直接调用 handler，不启动 HTTP
  README.md
```

## 网页控制台

核心在已启用 Survey 时提供同源静态路由：

| 路径 | 内容 |
| --- | --- |
| `/survey`、`/survey/` | 控制台外壳 |
| `/survey-app.js` | 控制台逻辑 |
| `/survey-app.css` | 样式 |

- 控制台：问卷列表与状态筛选、新建、题目编辑（单选/多选/文本/文件）、必填、排序、预览、保存草稿、发布、关闭、公开链接复制。
- 答卷与统计：每题计数/占比条形图、逐份答卷、文件题附件下载、CSV 导出。
- 公开填写：`/survey#fill/<slug>`（发布后控制台生成并复制），匿名读取快照并提交；关闭后只读并禁止提交。
- 页面本身不含身份或答卷数据；所有请求同源携带核心会话 Cookie，未登录访问控制台会提示先登录。
- 服务端文本全部通过 `textContent`/`value` 写入，页面不使用 `innerHTML`；CSP 与 Pages/Disk/Glim/Mail 控制台一致。
- 文件题由浏览器读取为 Base64 后提交，不依赖 Disk；未配置 `dataFile` 时服务端仍返回 409。


## 配置

```json
{
  "dataFile": "/var/lib/pagesai/survey/data.json",
  "maxAttachmentBytes": 10485760
}
```

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `dataFile` | 否 | `null` | `JsonStore` 数据文件。缺省/`null` 时纯内存运行，重启即清空。 |
| `maxAttachmentBytes` | 否 | 10 MiB | 单个文件题附件上限，1 字节–100 MiB。 |

文件题附件固定写入 `path.dirname(dataFile)/attachments/<surveyId>/<responseId>/`。若 `dataFile` 未配置而答卷包含文件题答案，返回 **409 `ATTACHMENT_STORAGE_NOT_CONFIGURED`**，不会伪造成功结果。

## 生命周期与接口

```js
module.exports = {
  async start({ config, logger }) {},
  async stop() {},
  async health() { return { ok: true }; },
  routes, // [{ method, path, handler }]
  tools: {}
};
```

- 所有路由以 `/api/survey/` 开头；`manifest.activation.routePrefix` 为 `/api/survey`。
- `handler(ctx)` 返回 `{ status, body }`；`ctx = { req, res, url, params, query, body, user }`。
- 错误统一返回 `{ code, message }`；`body` 已由宿主解析。
- 未认证的**管理型写操作**（创建/编辑/发布/关闭）返回 **403 `FORBIDDEN`**；公开填写是按需求允许匿名的例外。
- `capabilities.tools` 为空：不向 Glim 登记任何未实现能力。

## 路由

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/survey/health` | 公开 | 模块 HTTP 健康检查 |
| POST | `/api/survey/surveys` | 登录 | 创建问卷（所有者 = 当前用户） |
| GET | `/api/survey/surveys` | 登录 | 列出自己的问卷；管理员列出全部 |
| GET | `/api/survey/surveys/:id` | 所有者/管理员 | 读取草稿与状态 |
| PATCH / PUT | `/api/survey/surveys/:id` | 所有者/管理员 | 编辑标题/描述/题目 |
| POST | `/api/survey/surveys/:id/publish` | 所有者/管理员 | 生成不可变快照与公开 slug |
| POST | `/api/survey/surveys/:id/close` | 所有者/管理员 | 关闭问卷；之后填写返回 409 |
| GET | `/api/survey/surveys/:id/responses` | 所有者/管理员 | 答卷列表（附件只暴露元数据） |
| GET | `/api/survey/surveys/:id/stats` | 所有者/管理员 | 每题计数与占比 |
| GET | `/api/survey/surveys/:id/export.csv`（别名 `/export`） | 所有者/管理员 | CSV 导出 |
| GET | `/api/survey/surveys/:id/attachments/:attachmentId` | 所有者/管理员 | 下载文件题附件（JSON base64） |
| GET | `/api/survey/public/:slug` | 公开 | 读取已发布快照；关闭后仍可读状态 |
| POST | `/api/survey/public/:slug/responses` | 公开/匿名 | 提交答卷；关闭后 **409 `SURVEY_CLOSED`** |

跨用户读取/编辑/统计/导出/关闭均返回 **403**；不存在返回 **404**；输入非法返回 **400**；模块未 `start()` 返回 **503 `MODULE_NOT_READY`**。

## 题目与答卷格式

题型固定为四种（兼容常见别名）：

| 类型 | 别名（示例） | 答案 |
| --- | --- | --- |
| 单选 `single` | `single_choice`、`radio`、`单选` | 选项 id 或 label 字符串 |
| 多选 `multiple` | `multiple_choice`、`checkbox`、`多选` | 选项 id/label 数组 |
| 文本 `text` | `short_text`、`long_text`、`textarea`、`文本` | 字符串（≤ 20000 字符） |
| 文件 `file` | `file_upload`、`upload`、`文件` | `{ filename, contentType?, dataBase64 }` |

创建示例：

```json
{
  "title": "满意度调查",
  "description": "匿名填写",
  "questions": [
    { "type": "single", "title": "部门", "required": true, "options": ["研发", "市场"] },
    { "type": "multiple", "title": "关注方向", "options": ["AI", "Web"] },
    { "type": "text", "title": "建议" },
    { "type": "file", "title": "证明材料" }
  ]
}
```

提交答卷：

```json
{
  "answers": {
    "q1": "o1",
    "q2": ["o1", "o2"],
    "q3": "第一行\n第二行",
    "q4": { "filename": "证明.txt", "dataBase64": "aGVsbG8=" }
  }
}
```

- 题目/选项未显式给 `id` 时自动生成 `q1…`、`o1…`；显式 id 必须唯一。
- 必填题缺失、未知题目、非法选项、类型不符均返回 400。
- 文件附件也支持 `content`（UTF-8 文本）或 `contentBase64`/`base64`；文件名会做路径穿越清理，存储名另加随机附件 id。
- 匿名答卷的 `ownerId` 始终是**问卷所有者**，而非填写者。

## 发布快照

- `publish` 生成 `snapshot`（含题目、标题、描述、版本号）并写入 `slugs` 索引。
- 公开读取只读快照；发布后继续编辑草稿不会改变已发布内容。
- 再次发布：版本号 +1，沿用原 `slug`，公开入口指向新快照；旧快照保留为历史记录。
- 关闭后再次发布视为重新开放（`status` 回到 `published`）。

## 统计口径

```json
{
  "surveyId": "srv_…",
  "version": 2,
  "responseCount": 3,
  "total": 3,
  "questions": [
    {
      "id": "q1",
      "type": "single",
      "answered": 3,
      "unanswered": 0,
      "answeredPercentage": 100,
      "counts": { "o1": 2, "o2": 1 },
      "options": [
        { "id": "o1", "label": "研发", "count": 2, "percentage": 66.67, "ratio": 0.6667, "answeredPercentage": 66.67 }
      ]
    }
  ]
}
```

- `count`：选择该选项的答卷数（多选可多项合计大于答卷数）。
- `percentage` / `ratio`：以**全部答卷数**为分母。
- `answeredPercentage` / `answeredRatio`：以**实际答该题**的答卷数为分母。
- 文本/文件题只给 `answered` 计数，不泄露原文；非选择题 `counts` 为空对象。
- 统计与导出使用当前活动快照的题目口径；跨版本的答卷仍计入总数。

## CSV 规则

- RFC 4180 风格：字段含逗号、双引号、`\r`/`\n` 时整体加双引号，内部 `"` 双写为 `""`。
- 行尾 `\r\n`；UTF-8，无 BOM；`content-type: text/csv; charset=utf-8`。
- 列：`response_id,submitted_at,<每题标题>`。
- 多选以 `; ` 连接选项 label；文件题输出原始文件名；空答案输出空字段。
- 未配置 `dataFile` 时也可导出 CSV（纯内存答卷）。

## 开发服务器

```bash
cd modules/survey

# 纯内存启动，stdout 输出 {"url":"http://127.0.0.1:PORT"}
node server/dev.js

# 只探测能否启动：打印 URL 后退出
node server/dev.js --once

# 落盘数据并带附件目录
node server/dev.js --data-file /tmp/pagesai-survey.json
```

本地调试可用请求头模拟身份（仅 dev.js，不是生产认证）：`x-user-id`、`x-user-name`、`x-user-role: admin`。

## 测试

```bash
# 在 public-release/pagesai 下
node --test modules/survey/tests/*.test.js

# 或在模块目录内
cd modules/survey && node --test tests/*.test.js
```

当前结果：**8 tests / 8 pass / 0 fail**（本文件落笔时的真实计数）。覆盖：

- manifest 与 config schema 公共契约校验、路由前缀；
- 未认证创建 403、所有者隔离、跨用户 403、管理员读取；
- 匿名填写、发布快照不随后续编辑变化、重新发布版本递增；
- 关闭后填写 409 `SURVEY_CLOSED`；
- 单选/多选/文本统计计数与占比；
- CSV 引号、逗号与换行转义；
- 文件题附件写入 `dataFile` 同级 `attachments/`、越权下载 403、未配置 `dataFile` 409；
- `dataFile` 重启持久化；
- 非法题目、未知题目、非法选项、超大附件 413。

## 已知边界（未实现，不对外宣称）

- 无答卷修改票据/编辑、撤回、去重、登录限制、访问密码、配额与限流。
- 无 AI 审核、邮件通知、定时开关、协作管理、二维码、Excel 导出。
- 统计按活动快照题目口径聚合跨版本答卷；不提供逐版本对比。
- `capabilities.tools` 为空，未向 Glim 暴露读写工具；Glim 通过 HTTP 连接器调用 Survey API。
