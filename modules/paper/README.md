# Paper 模块（论文上传 / 阅读 / 翻译 / 问答）

公开版 PagesAI 的论文精读最小闭环：**上传 → 提取 → 句子切分 → 逐句对齐翻译 → 带引用的 AI 问答**，
附同源网页控制台 `/paper`（论文库、PDF 原件内嵌、双语对照阅读、翻译进度与引用跳转）。
只依赖 Node 内置模块与公共核心的 `CoreError`、`JsonStore`，不引用旧 `source/site/` 代码，也不引入任何第三方依赖。

- 模块 ID：`paper`（版本 `0.2.0`）
- 路由前缀：`/api/paper`
- 数据命名空间：`paper`（JsonStore 集合：`docs` / `jobs` / `translations`）
- 存储区域声明：`paper.uploads`（原件目录，见下文「存储区域」）
- 生命周期入口：`server/index.js`

## 目录

```text
modules/paper/
  manifest.json                 模块清单（contracts/module-manifest.schema.json）
  config.schema.json            模块配置 JSON Schema
  server/
    index.js                    统一模块接口：start/stop/health/routes/tools
    dev.js                      本地 HTTP 装配（127.0.0.1:0，--once）
    service.js                  业务层：所有权、上传、切分、翻译、问答
    extract.js                  纯文本 + 简单 PDF 文本层提取（零依赖）
    segment.js                  确定性句子切分与 sid
    adapters.js                 翻译/问答/检索适配器解析与形状校验
    codes.js                    paper.* 错误码
  tests/
    helpers.js                  临时目录、fake ctx、PDF 构造器
    *.test.js                   node:test 用例（直接调用 handler，不启动 HTTP）
  web/
    index.html                  同源控制台（/paper）
    app.js                      列表、上传、阅读、翻译轮询、问答与引用跳转
    app.css                     明暗主题与三栏/双栏响应式布局
```

## 接口

所有接口都要求登录（`ctx.user` 非空）；**写操作未认证返回 403**。跨用户访问同一论文同样返回 403。
错误响应统一为 `{ code, message }`（`CoreError.details` 存在时附加 `details`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/paper/docs` | 上传：`{filename, contentBase64}`，成功 201 |
| POST | `/api/paper/docs/upload?filename=…` | 原始字节上传（不经 Base64/JSON），上限 128 MiB，成功 201 |
| GET | `/api/paper/docs` | 当前用户的论文列表（按创建时间倒序） |
| GET | `/api/paper/docs/:id` | 读取论文正文（blocks + segments）与最新翻译进度 |
| GET | `/api/paper/docs/:id/file` | 原件下载；支持 `Range` 与 `HEAD`，`?inline=1` 改为内嵌展示 |
| DELETE | `/api/paper/docs/:id` | 删除论文、译文、任务与原件 |
| POST | `/api/paper/docs/:id/translate` | 开始/恢复翻译；`{targetLang?, restart?}` |
| GET | `/api/paper/docs/:id/translate` | 翻译进度；`?include=text` 附带按 sid 的译文 |
| POST | `/api/paper/docs/:id/translate/stop` | 主动停止当前翻译，收敛为 `stopped`，已完成译文保留 |
| POST | `/api/paper/docs/:id/ask` | 问答：`{question, topK?}`，返回答案与合法引用索引 |

### 网页控制台

`GET /paper`（以及 `/paper/`、`/paper-app.js`、`/paper-app.css`）由核心同源托管，
只在 `paper` 模块已启用时可用；页面本身不含身份或论文内容，CSP 为
`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'`，
不使用内联脚本或第三方 CDN。

- **论文库**：左侧列表显示状态、页数/句数与翻译进度；支持拖拽或选择文件上传，超过 128 MiB 在浏览器侧直接拒绝。
- **阅读器**：原文与译文逐句成对显示，`data-sid` 与 API 的 sid 一致；可在「对齐 / 原文 / 译文」三种视图间切换。
- **PDF 原件**：通过同源 `iframe` 加载 `/api/paper/docs/:id/file?inline=1`，可新标签打开；未落盘 PDF 会明确提示无法内嵌。
- **翻译**：开始/继续/重新翻译、停止与 600ms 进度轮询；`stopped` 与 `interrupted` 都显示为「可继续」，不会伪装成完成。
- **问 AI**：问答结果按引用跳转到对应句子并高亮；检索适配器缺失时展示明确的降级说明。
- **单句右键**：可「问 AI 这句」或复制原文；删除论文有运行中保护。

### 上传与提取

- 接受 **PDF** 与 **UTF-8 纯文本**（`.txt/.text/.md/.markdown`，未知扩展名按内容判断）。
- JSON 上传：`contentBase64` 支持裸 Base64，也接受 `data:...;base64,` 前缀；请求体上限 48 MiB，解码后受 `maxUploadBytes`（默认 32 MiB）约束。
- 原始上传：`POST /api/paper/docs/upload?filename=…` 直接发送文件字节，上限 128 MiB，不经过 Base64 膨胀，网页控制台使用该路径。
- 文件名只保留 basename，控制字符被移除；原件按所有者隔离写入 `uploadsDir/<ownerKey>/<docId>.<ext>`。
- 提取在**上传请求内同步完成**：
  - 纯文本：检查空内容、NUL 字节与无效 UTF-8；
  - PDF：解析间接对象、页面树、FlateDecode 内容流，识别 `Tj/TJ/'/"` 与换行操作符；
  - 提取不到正文（扫描件、加密、不支持滤镜/字体）→ **422 `paper.extract_failed`**，不落库、不保存原件，绝不伪造内容。
- 切分结果持久化到 JsonStore；句子 ID 为 `${blockIndex}:${sentenceIndex}`，同样输入永远得到同样 sid。

### 原件下载

`GET /api/paper/docs/:id/file`

- 落盘原件以流式返回，支持 `Range`（206 + `content-range`）与 `HEAD`（只回头部）。
- 默认 `content-disposition: attachment`；`?inline=1|true|yes` 改为 `inline`，供同源阅读器内嵌 PDF。
- 纯文本即使未落盘也可由已提取正文重建；**PDF 未落盘时返回 409 `paper.file_not_available`**，绝不伪造内容。

### 翻译与进度恢复

`POST /api/paper/docs/:id/translate`

- `config.translateAdapter` 未配置或不可用 → **409 `paper.translate_not_configured`**。
- 同一论文同一目标语言正在翻译 → **409 `paper.translate_in_progress`**。
- `targetLang` 省略时用 `config.defaultTargetLang`（默认 `zh`）；非法语言代码 → 400。
- `restart: true` 会清空该语言旧译文并从头翻译；默认从断点继续。
- 每翻完一批立即持久化译文与进度；适配器报错或返回条数与输入不等时：
  - 已完成的句子保留，任务状态置为 `interrupted`，返回 **502 `paper.translate_failed`**（`details.job` 带进度）；
  - 已完成的句子保留；再次 POST 只补翻未完成 sid，已完成 sid 不会重复送上游。
- 适配器返回条数必须与输入严格相等：错位译文比失败更危险，宁可中断等待恢复。
- 用户调用 `POST /translate/stop` 时任务收敛为 `stopped`（已完成译文保留，可继续）；模块停止/进程重启时收敛为 `interrupted`，含义同样是「可恢复」。

进度查询 `GET /api/paper/docs/:id/translate`：

```json
{
  "job": {
    "docId": "…", "targetLang": "zh",
    "status": "idle|running|interrupted|stopped|done",
    "total": 42, "done": 18, "failed": 24, "pending": 24,
    "progress": 0.4286, "percent": 42.86, "completed": false,
    "error": null,
    "startedAt": 0, "updatedAt": 0, "completedAt": null
  },
  "translations": null
}
```

`?include=text` 时 `translations` 为 `{ "<sid>": "译文" }`。

### 问答与降级

`POST /api/paper/docs/:id/ask`

- `config.qaAdapter` 未配置 → **409 `paper.qa_not_configured`**。
- `config.searchAdapter` 未配置/失败/返回空 → **明确降级**为本地关键词检索：
  - `degraded.code` 分别为 `paper.search_unavailable` / `paper.search_failed` / `paper.search_empty`；
  - 响应同时给出 `search: {source:"local", configured:false}`。
- 检索适配器正常时 `degraded` 为 `null`，`search.source="adapter"`。
- `citations` 只包含论文里真实存在的 sid，并给出 `blockIndex/sentenceIndex/page/text`；适配器返回的非法引用被丢弃，计数在 `citationsIgnored`。
- `retrieved` 是实际送入问答适配器的句子 sid 列表。
- 问答适配器故障 → **502 `paper.qa_failed`**；不返回空答案冒充成功。

## 配置

`config.schema.json`（完整字段见文件）：

```json
{
  "dataFile": "/var/lib/pagesai/paper/store.json",
  "uploadsDir": "/var/lib/pagesai/paper/uploads",
  "maxUploadBytes": 33554432,
  "defaultTargetLang": "zh",
  "qaTopK": 6,
  "translateBatchSize": 20,
  "translateAdapter": { "endpoint": "https://…/translate", "apiKey": "…", "model": "…" },
  "qaAdapter": { "endpoint": "https://…/ask", "apiKey": "…", "model": "…" },
  "searchAdapter": { "endpoint": "https://…/search", "apiKey": "…" }
}
```

- **`dataFile` 未给 → JsonStore 纯内存**（进程退出即丢失，测试/试用）；给了则原子替换写、权限 0600。
- `uploadsDir` 未给时：有 `dataFile` 则用其同级 `uploads/`；两者都没有则纯内存且不保留原件。
- 秘密字段（`/translateAdapter/apiKey` 等）已在 manifest 的 `config.secrets` 登记，日志与错误信息不输出 apiKey。
- JSON 部署配置使用 **endpoint 形式**；进程内嵌入/测试也可以直接注入函数或带方法对象（这种形态不经过 JSON Schema 校验）。

### 适配器契约

```js
// 翻译：必须返回与 segments 等长的数组
translate({ segments: [{ sid, text }], targetLang, context, doc }) => string[] | { translations: string[] }

// 问答
ask({ question, segments: [{ sid, text, page, blockIndex }], doc }) => { answer: string, citations?: string[] }

// 可选检索
search({ question, topK, segments, doc }) => { results: [{ sid }] } | [sid] | [{ sid }]
```

endpoint 形式对应 `POST`，请求体在输入基础上附加 `model`；响应按上述结构解析。
`package.json` 不存在也不被需要：模块只用 `node:*` 内置模块。

## 错误码

| code | HTTP | 场景 |
| --- | --- | --- |
| `paper.extract_failed` | 422 | PDF/文本无正文、加密、扫描件、不支持的内容流 |
| `paper.unsupported_file` | 400 | 非 PDF/纯文本，或 `.pdf` 扩展名与内容不符 |
| `paper.not_ready` | 409 | 正文未就绪时翻译/问答 |
| `paper.translate_not_configured` | 409 | 未配置/不可用翻译适配器 |
| `paper.translate_in_progress` | 409 | 同一论文同一语言并发翻译 |
| `paper.translate_failed` | 502 | 上游翻译中断；已保留断点 |
| `paper.qa_not_configured` | 409 | 未配置/不可用问答适配器 |
| `paper.qa_failed` | 502 | 问答适配器故障或返回格式不可用 |
| `paper.file_not_available` | 409 | PDF/二进制原件未落盘，无法下载 |
| `INVALID_INPUT` | 400/413 | 输入、Base64、topK、语言代码、大小超限 |
| `FORBIDDEN` | 403 | 未登录或跨用户访问 |
| `NOT_FOUND` | 404 | 论文/路由不存在 |
| `MODULE_NOT_READY` | 503 | 模块未 `start()` 就调用路由 |

## 安全与隔离

- 所有者以 `user.id`（兼容 `userId` / `username`）为准；读、写、删、翻译、问答一律先做所有权检查。
- 原件路径只由服务端生成，API 不暴露宿主绝对路径；删除时校验解析后的路径不越出 `uploadsDir`。
- 上传大小、Base64 形状、文件名、语言代码、`topK` 均在进入业务前校验。
- JsonStore 不是数据库：不做并发控制与事务；单实例部署，写入方以 sid 去重。

## 本地运行与测试

```bash
cd source/site/public-release/pagesai/modules/paper
node --test tests/*.test.js        # 40/40
```

测试直接调用 `routes[i].handler(fakeCtx)`，不启动 HTTP；覆盖：

1. 上传切分与持久化（含跨重启读取）；
2. PDF 文本层提取成功与无文本层 **422 `paper.extract_failed`**；
3. 未配置翻译/问答 **409**；
4. 未登录与跨用户 **403**；
5. 翻译进度、用户停止、失败中断与断点恢复（已完成 sid 不重复翻译）；
6. 问答引用索引全部合法、检索不可用明确降级；
7. 原始字节上传、原件 Range/HEAD/inline 下载；
8. 清单/配置 schema/生命周期/核心 `ModuleHost` 装配。

干净安装端到端（真实 MongoDB + 真实 HTTP + 同源网页 + 回环假适配器；只在显式开启时运行）：

```bash
cd source/site/public-release/pagesai
NODE_PATH=/tmp/pagesai-mongo-build/node_modules \
PAGESAI_MONGO_TEST=1 \
MONGOMS_DOWNLOAD_DIR=/tmp/pagesai-mongo-build/binaries \
node --test tests/integration/paper-clean-install.test.js
```

该用例在仓库外临时目录安装核心与 `paper`，验证 `/paper` 静态资源与 CSP、注册登录、双用户隔离、
文本/PDF 上传、原件 `attachment/inline/HEAD/Range`、翻译成功与停止恢复、问答引用过滤、
运行中停用模块收敛为 `interrupted`、重启后文档/译文/原件持久化，以及删除清理。

本地 HTTP 冒烟（只监听 `127.0.0.1:0`）：

```bash
node server/dev.js --once                       # 打印 {"url":"http://127.0.0.1:PORT"} 后退出
node server/dev.js --data /tmp/paper.json --uploads /tmp/paper-uploads
# 请求头 x-dev-user: alice 切换用户；x-dev-user: anonymous 表示未登录
```

## 存储区域

`manifest.data.regions` 声明 `paper.uploads`，含义是上传原件区域。部署时应在核心 `StorageRegistry` 登记：

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

模块本身只读 `config.uploadsDir`，不自行扫描或推导数据根；两者应指向同一物理目录。

## 已知限制与缺口（不得宣称已完成）

| 缺口 | 影响 | 归属 |
| --- | --- | --- |
| PDF 只支持简单文本层 | 无 OCR；加密、ObjStm、LZW/ASCII85、CID/Identity-H 字体不支持，统一 422 | paper 后续 |
| 上传上限由传输层固定 | JSON 上传 48 MiB，原始上传 128 MiB；超大 PDF 需调整路由 `transport.maxBytes` | paper/core 后续 |
| `paper.uploads` 区域需部署时登记 | 未登记时模块仍可按 `uploadsDir` 工作，但不满足 §6.1 的区域登记要求 | 部署/核心 |
| 翻译在请求内执行，没有独立后台任务队列 | 进程崩溃会丢失「本批未提交」的进度；已提交批次可恢复。单实例足够，多实例需外部队列 | paper 后续 |
| 翻译/问答适配器未对真实模型做验收 | 端到端用例只用回环假适配器验证协议与状态机；真实翻译质量与配额属于外部接入 | 部署/验收 |
| JsonStore 无并发控制与事务 | 仅适合单实例；MongoDB 适配器待接（同一方法集） | core/paper 后续 |
| 问答/翻译历史不长期留存 | 只有当前译文与最新任务状态；审计需另建 | paper 后续 |
| 进程内函数适配器绕过 JSON Schema | 仅用于嵌入/测试；生产请用 endpoint 形式 | 约定 |
