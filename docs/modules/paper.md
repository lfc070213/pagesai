# Paper 模块

> **状态：论文闭环与网页阅读器已实现。** 上传（PDF/纯文本，支持流式直传原件）→ 提取 → 句子切分 → 分批翻译（断点恢复、可停止）→ 带引用的 AI 问答（检索不可用时明确降级）可用；`web/` 提供论文列表、正文、对齐译文与 PDF 原件阅读。PDF 仅支持简单文本层（无 OCR）；翻译在请求内分批执行，无独立后台队列。
>
> 自查：
>
> ```bash
> cd source/site/public-release/pagesai
> node modules/paper/server/dev.js --once
> node --test modules/paper/tests/*.test.js
> ```
>
> 预期：打印 `{"url":"http://127.0.0.1:PORT"}`；测试 `40 pass / 0 fail`。

## 1. 定位与边界

Paper 负责论文上传、阅读、翻译、句子对齐与 AI 问答。

- 归属目录：`modules/paper/`（`manifest.json`、`config.schema.json`、`server/`、`web/`）。
- 路由前缀：`/api/paper`；命名空间 `paper`（集合 `docs`/`jobs`/`translations`）。
- 所有接口要求登录；写操作未认证 403，跨用户 403。
- 非目标：不做 OCR；不伪造检索来源；不执行任意代码。

## 2. 依赖

### 2.1 必需基础设施

`manifest.requires.infrastructure = []`：**无**外部基础设施依赖。

| 能力 | 依赖 | 说明 |
| --- | --- | --- |
| 存储 | `core/storage/json-store.js` | 纯内存或 `dataFile`；原件目录 `uploadsDir` |
| 翻译 | `config.translateAdapter`（endpoint 或注入函数） | 未配置 `409 paper.translate_not_configured` |
| 问答 | `config.qaAdapter` | 未配置 `409 paper.qa_not_configured` |
| 检索 | `config.searchAdapter`（可选） | 不可用时降级为本地关键词检索 |

### 2.2 模块间依赖

- 强依赖：无。不装 Disk 也能上传、阅读、翻译、问答。
- 可选：Glim 通过 `connectors/paper.js` 调用本模块 8 个连接能力（含 `paper_search`、`paper_get_translation`）。
- 安装 Disk 后原论文位置与归属不变。

### 2.3 运行时

- 只用 `node:*` 内置模块，不需要 `package.json`。
- 单实例 `JsonStore`；无并发控制与事务。

## 3. 单装步骤

### 3.1 独立运行

```bash
cd source/site/public-release/pagesai
node modules/paper/server/dev.js --data /tmp/paper.json --uploads /tmp/paper-uploads
```

开发身份：`x-dev-user: alice`；`x-dev-user: anonymous` 表示未登录。

### 3.2 配置示例（占位值）

```json
{
  "dataFile": "/var/lib/pagesai/paper/store.json",
  "uploadsDir": "/var/lib/pagesai/paper/uploads",
  "maxUploadBytes": 33554432,
  "defaultTargetLang": "zh",
  "qaTopK": 6,
  "translateBatchSize": 20,
  "translateAdapter": { "endpoint": "https://model.example.com/translate", "model": "example" },
  "qaAdapter": { "endpoint": "https://model.example.com/ask", "model": "example" }
}
```

`/translateAdapter/apiKey`、`/qaAdapter/apiKey`、`/searchAdapter/apiKey` 是秘密，只允许部署注入。JSON 部署配置用 endpoint 形式；进程内嵌入可用函数适配器（不经过 JSON Schema）。

### 3.3 安装检查清单

- [ ] 上传 PDF/纯文本成功；无文本层 PDF 返回 `422 paper.extract_failed`，不落库。
- [ ] 未登录/跨用户 403。
- [ ] 未配置翻译/问答适配器 409，不返回伪造内容。
- [ ] 翻译中断后可恢复；已完成 sid 不重复送上游。
- [ ] 问答引用只包含论文中真实存在的 sid；检索不可用时 `degraded.code` 明确。
- [ ] 重启后论文、切分与译文仍在（`dataFile`）；纯内存模式清空。

## 4. 能力清单

`manifest.capabilities.tools` 中 6 个工具全部 `implemented: true`：

| 工具 | 访问 | 对外后果 | 说明 |
| --- | --- | --- | --- |
| `paper_list_docs` | read | 否 | 列出当前用户论文 |
| `paper_read_doc` | read | 否 | 读取正文与切分 |
| `paper_upload_doc` | write | **是** | 上传（占用存储） |
| `paper_translate_doc` | write | 否 | 触发翻译（外部模型调用与费用） |
| `paper_ask_doc` | read | 否 | 问答（外部模型调用与费用） |
| `paper_delete_doc` | write | **是** | 删除论文与原件 |

`externalEffect=false` 不等于「无副作用」：翻译与问答会产生外部调用与费用，应计量与授权。

## 5. 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dataFile` | — | JsonStore 路径；不给 = 纯内存 |
| `uploadsDir` | `dataFile` 同级 `uploads/` | 原件目录；都不给则不保留原件 |
| `maxUploadBytes` | 32 MiB | 单次上传解码后上限 |
| `defaultTargetLang` | `zh` | 翻译默认目标语言 |
| `qaTopK` | 6 | 问答引用句子上限 |
| `translateBatchSize` | 20 | 单次翻译最大句数 |
| `translateAdapter` / `qaAdapter` / `searchAdapter` | — | endpoint + `apiKey`（秘密）+ `model` + `timeoutMs` |

存储区域：`manifest.data.regions = ["paper.uploads"]`，命名空间 `paper`。

部署时应在核心登记区域（示例）：

```json
{
  "regionId": "paper.uploads",
  "module": "paper",
  "physicalRoot": { "configKey": "storage.paper.uploads", "defaultSubpath": "paper-uploads", "allowImplicitChange": false },
  "ownership": { "rule": "per-user", "ownerField": "ownerId" },
  "allowedOperations": ["read", "write", "delete"],
  "disk": { "visible": false, "syncable": false }
}
```

模块只读 `config.uploadsDir`，不自行扫描或推导数据根；两者应指向同一物理目录。

## 6. 与 Glim 的连接

- Glim 的 `connectors/paper.js` 直接调用本模块 `/api/paper`，对外声明 8 个连接能力：`paper_search`、`paper_list_docs`、`paper_read_doc`、`paper_upload_doc`、`paper_translate_doc`、`paper_get_translation`、`paper_ask_doc`、`paper_delete_doc`。
- 本模块自身 manifest 声明 6 个工具；`paper_search` 与 `paper_get_translation` 是连接侧的检索/进度封装（前者在本人论文列表上按标题过滤，后者读取本模块翻译记录），不新增数据面。
- 授权要求：读取（列表/正文/问答）与写入（上传/翻译/删除）分开；上传与删除属对外后果。
- 撤销后下一次调用立即失败；已产生的模型费用不回滚，但应可追溯。

## 7. 故障与卸载

| 场景 | 行为 |
| --- | --- |
| 无文本层/加密/不支持字体 | `422 paper.extract_failed`，不落库、不保存原件 |
| 翻译适配器未配置 | `409 paper.translate_not_configured` |
| 同一论文同语言翻译中 | `409 paper.translate_in_progress` |
| 适配器返回条数不等 | `502 paper.translate_failed`，保留已完成句，状态 `interrupted` |
| 问答适配器未配置 | `409 paper.qa_not_configured` |
| 检索不可用 | 降级本地关键词检索，`degraded.code` 明确，不伪造来源 |
| 问答适配器故障 | `502 paper.qa_failed`，不返回空答案冒充成功 |
| 停用 | `stop()` 保留 `dataFile` 与原件；`taskStopRules` 容忍 10s 收敛 |
| 卸载 | 默认保留论文与原件；永久删除为独立操作 |

## 8. 已知缺口

| ID | 缺口 |
| --- | --- |
| K14 | 原件路径由服务端生成，业务记录未接稳定文件 ID/修订契约 |
| K6 | 无字节配额与用量统计；只有单次上传上限 |
| K4 | **已关闭**：`web/` 提供列表、正文、对齐译文与 PDF 原件阅读 |
| K5 | 无安装器；适配器需部署注入并登记 `paper.uploads` 区域 |
| 非清单内 | PDF 仅支持简单文本层（无 OCR）；翻译在请求内分批执行，无独立后台队列 |

> 大文件上传走 `transport: { kind: 'upload' }` 流式通道，核心不把原件解析为 JSON；Paper 模块仍收集到有界整文件 Buffer 后提取；模块传输硬上限 128 MiB（`maxUploadBytes` 默认 32 MiB），核心上传通道默认上限 1 GiB，因此不再受 64 KiB JSON 请求体限制。

完整清单与来源见 [`docs/README.md`](../README.md#已知缺口清单)。