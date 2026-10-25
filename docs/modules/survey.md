# Survey 模块

> **状态：问卷闭环与网页端已实现。** 新建/编辑、发布快照、匿名填写、关闭、答卷列表、统计、CSV 导出、文件题附件均可用，并有管理与公开填写两个网页入口；未实现答卷修改票据、配额、审核、通知、二维码与 Excel 导出。
>
> 自查：
>
> ```bash
> cd source/site/public-release/pagesai
> node modules/survey/server/dev.js --once
> node --test modules/survey/tests/*.test.js
> ```
>
> 预期：打印 `{"url":"http://127.0.0.1:PORT"}`；测试 `8 pass / 0 fail`。

## 1. 定位与边界

Survey 是自有简易问卷：创建、发布、填写、关闭、答卷查询、基础统计、CSV 导出、文件题附件。

- 归属目录：`modules/survey/`（`manifest.json`、`config.schema.json`、`server/`）。
- 路由前缀：`/api/survey`。
- **不依赖** MongoDB、Mail、Disk、Glim、AI 或第三方包；未安装 Disk 时文件题仍可用。
- 发布快照不可变；发布后继续编辑草稿不改变已发布内容。

## 2. 依赖

### 2.1 必需基础设施

`manifest.requires.infrastructure = []`：**无**外部基础设施依赖。

| 能力 | 依赖 | 说明 |
| --- | --- | --- |
| 问卷与答卷 | `core/storage/json-store.js` | 纯内存或 `dataFile` |
| 文件题附件 | `dataFile` 同级 `attachments/` | 未配置 `dataFile` 时带文件题的答卷返回 `409 ATTACHMENT_STORAGE_NOT_CONFIGURED` |

### 2.2 模块间依赖

- 强依赖：无。
- 可选：Glim 调用需真实工具适配器（当前 `tools = {}`）。
- 安装/卸载 Disk 不改变问卷附件的位置与归属。

### 2.3 运行时

- 只用 `node:*` 内置模块，不需要 `package.json`。
- 单进程 `JsonStore`，无并发控制与事务。

## 3. 单装步骤

### 3.1 独立运行

```bash
cd source/site/public-release/pagesai
node modules/survey/server/dev.js --data-file /tmp/pagesai-survey.json
```

开发身份（仅 dev.js）：`x-user-id`、`x-user-name`、`x-user-role: admin`。

### 3.2 最小流程（HTTP）

1. `POST /api/survey/surveys`（登录）创建问卷。
2. `POST /api/survey/surveys/:id/publish` 生成公开 slug 与快照。
3. `GET /api/survey/public/:slug` 读取已发布内容（匿名）。
4. `POST /api/survey/public/:slug/responses` 提交答卷（匿名）。
5. `GET /api/survey/surveys/:id/stats`、`.../export.csv` 查看与导出。

### 3.3 安装检查清单

- [ ] 未认证创建/编辑/发布/关闭 403；公开填写允许匿名。
- [ ] 跨用户读取/编辑/统计/导出/关闭 403；不存在 404。
- [ ] 发布快照不随后续编辑变化；重复发布版本 +1、slug 不变。
- [ ] 关闭后填写 `409 SURVEY_CLOSED`。
- [ ] 单选/多选/文本统计口径正确（`percentage` 以全部答卷为分母，`answeredPercentage` 以答该题为分母）。
- [ ] CSV 正确转义逗号、引号与换行。
- [ ] 文件题附件写入 `dataFile` 同级目录；越权下载 403；未配置 `dataFile` 409。
- [ ] 重启后数据保留；非法题目/选项/超大附件被拒。

## 4. 能力清单

| 能力 | 状态 |
| --- | --- |
| 创建/编辑问卷（四种题型 + 别名） | 已实现 |
| 发布快照与公开 slug | 已实现 |
| 匿名填写、关闭 | 已实现 |
| 答卷列表、基础统计 | 已实现 |
| CSV 导出（RFC 4180） | 已实现 |
| 文件题附件 | 已实现（需 `dataFile`） |
| Web 前端（管理 + 公开填写） | 已实现（`modules/survey/web/`） |
| 答卷修改票据、撤回、去重、访问密码、配额、限流 | **未实现** |
| AI 审核、邮件通知、定时开关、协作、二维码、Excel | **未实现** |
| 对 Glim 的工具 | 由 Glim 的 `connectors/survey.js` 直接调用本模块 API；本模块不声明工具 |

## 5. 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dataFile` | `null` | JsonStore 路径；空 = 纯内存（重启清空） |
| `maxAttachmentBytes` | 10 MiB | 单个文件题附件上限（1 B–100 MiB） |

存储区域：`manifest.data.regions = ["survey.responses", "survey.attachments"]`，命名空间 `survey`。

> 与基线的差异：`docs/m0/A03` 记录的 `survey.attachments` 与网盘同根冲突（K13）在公开版模块中通过「附件跟随 `dataFile` 同级目录」规避；部署时应把该目录登记为独立区域，**不要**指向任何网盘用户目录。

## 6. 与 Glim 的连接

- 当前 `tools = {}`，Glim 无法调用 Survey。
- 规划工具：`survey_list`（read）、`survey_read`（read）、`survey_create`（write）、`survey_publish`（write，对外后果）、`survey_results`（read）、`survey_export`（read，数据外带）。
- 落地要求：发布与导出属对外后果/数据外带，逐次授权并审计；撤销后立即失效。
- 现状：Glim 侧 `survey_publish` 为 `implemented:false`，调用返回 409。

## 7. 故障与卸载

| 场景 | 行为 |
| --- | --- |
| 模块未 `start()` | `503 MODULE_NOT_READY` |
| 问卷已关闭 | 提交答卷 `409 SURVEY_CLOSED` |
| 未配置 `dataFile` 且含文件题 | `409 ATTACHMENT_STORAGE_NOT_CONFIGURED`，不伪造成功 |
| 附件过大 | `413` |
| 跨用户操作 | `403` |
| 停用 | `stop()` 保留数据与附件 |
| 卸载 | 默认保留数据与附件目录；永久删除为独立操作 |

## 8. 已知缺口

| ID | 缺口 |
| --- | --- |
| K4 | 无 Web 前端与管理页面 |
| K6 | 无配额与用量统计 |
| K5 | 无安装器；需部署注入 `dataFile` 并登记附件区域 |
| K13 | 附件区域必须显式独立登记，否则仍可能落进网盘目录 |
| 非清单内 | 无答卷修改票据、撤回、去重、访问密码、限流、AI 审核、邮件通知、二维码、Excel |

完整清单与来源见 [`docs/README.md`](../README.md#已知缺口清单)。