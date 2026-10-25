# 安装指南

本指南说明 PagesAI 的安装模型、公共核心安装、六个模块的单独安装与组合规则。

> **现状**：公共核心与六个模块的服务端最小闭环已实现；安装器 `tools/init.js` 已实现，生成的配置与 `deploy/presets/` 同源；真实启动、升级、备份、恢复、停用/启用、卸载与重装演练已在 `tests/integration/deploy-acceptance.test.js` 通过。容器镜像构建仍缺宿主机运行时，预设使用 `pagesai/app:local` / `pagesai/gateway:local` 本地标签。

## 1. 安装模型

| 层 | 内容 | 现状 |
| --- | --- | --- |
| 公共核心 | 身份、会话、单层管理员、模块登记与生命周期、存储契约 | 已实现（MongoDB 引擎持久化；内存仅开发模式） |
| 业务模块 | Pages / Disk / Glim / Mail / Survey / Paper 的服务端入口 | 已实现（含页面与后台贡献） |
| 前端 | 六模块页面、统一后台 | 已实现（C27–C29） |
| 编排 | 安装器生成配置 + Compose 预设 + 静态校验 | 已实现（配置与预设同源；容器镜像未验证） |

原则：

1. **模块选择是唯一事实来源**：部署配置里选了哪些模块，才启动哪些服务、挂载哪些路由、出现哪些菜单。
2. **默认独立**：每个模块只带公共核心即可运行；模块之间不设硬依赖。
3. **未安装即不存在**：不导入代码、不注册路由、不启动任务、不做模块专属配置校验。
4. **登记不来自请求**：模块只能由构建与管理员配置登记。

## 2. 依赖矩阵

| 模块 | 声明的基础设施 | 真正需要的外部条件 | 单独可用 |
| --- | --- | --- | --- |
| 公共核心 | 无 | 无 | 是 |
| Pages | 无 | 可选：模型适配器（AI 修改） | 是 |
| Disk | 无 | 无（对象存储适配器未实现） | 是 |
| Glim | 无 | 可选：模型适配器（对话） | 是 |
| Mail | `smtp`、`imap` | 配置 SMTP/IMAP（内置协议客户端）或注入收发适配器 | 是（未配置时其余功能可用） |
| Survey | 无 | 无 | 是 |
| Paper | 无 | 可选：翻译/问答/检索适配器 | 是 |

> 模块清单的 `requires.infrastructure` 只允许固定枚举；模型服务不在枚举内，属部署配置或适配器注入。

## 3. 安装公共核心

### 3.1 环境变量

| 变量 | 作用 | 默认 | 约束 |
| --- | --- | --- | --- |
| `PAGESAI_DATA_ROOT` | 数据根 | `<cwd>/data` | 正式部署用专用目录 |
| `PAGESAI_INSTALL_ROOT` | 部署根；`modules/` 相对它解析 | 当前目录 | 发布目录 |
| `PAGESAI_MODULES` | 已安装模块 ID 列表 | 空 | **只记录，不校验、不加载** |
| `PAGESAI_REGISTRATION_ENABLED` | 开放注册 | `true` | 关闭后 `403 REGISTRATION_CLOSED` |
| `PAGESAI_EMAIL_REGISTRATION` | 邮箱验证注册 | `false` | 为真时必须已安装 Mail，否则启动失败 |
| `PAGESAI_EMAIL_DOMAINS` | 允许的邮箱域名 | 不限 | 仅邮箱验证模式 |
| `PAGESAI_SESSION_TTL_MS` | 会话有效期 | 7 天 | ≥ 5 分钟 |
| `PAGESAI_BOOTSTRAP_TOKEN` | 管理员引导令牌 | 未设置 | 设置后引导必须带同值 |

### 3.2 启动

```bash
cd source/site/public-release/pagesai

PAGESAI_BOOTSTRAP_TOKEN='<占位：从密钥文件读取>' \
PAGESAI_DATA_ROOT=/srv/pagesai/data \
node -e '
const { loadConfig } = require("./core/config");
const { createCore, createServer } = require("./core/server");
const app = createServer(createCore({ config: loadConfig({ env: process.env }) }));
app.listen({ port: 8787, host: "127.0.0.1" }).then((info) => console.log("listening " + info.url));
'
```

引导管理员：

```bash
curl -s -X POST http://127.0.0.1:8787/api/admin/bootstrap \
  -H 'content-type: application/json' \
  -d '{"username":"rootadmin","password":"<占位：至少 8 位>","bootstrapToken":"<与变量一致>"}'
```

预期：无令牌 `403`；有令牌 `201`；重复 `409 BOOTSTRAP_CLOSED`。

### 3.3 核心验收

- [ ] `/healthz`、`/readyz` 200。
- [ ] `/api/modules` 的 `installed` 与部署配置一致。
- [ ] 未安装模块前缀全部 404。
- [ ] 注册 → 登录 → `/api/me` → 退出 正常。
- [ ] 普通用户访问 `/api/admin/users`、`/api/admin/modules` 403。
- [ ] 唯一管理员不可删除/停用/降级（`409 LAST_ADMIN_PROTECTED`）。
- [ ] 启用邮箱注册但未装 Mail 时启动失败（`MAIL_MODULE_REQUIRED`）。

## 4. 安装业务模块

### 4.1 方式一：独立运行（不经过核心）

适合验证模块本身：

```bash
cd source/site/public-release/pagesai
node modules/pages/server/dev.js --data-file /tmp/pages-dev.json
# stdout 第一行：{"url":"http://127.0.0.1:PORT"}
```

六个模块的入口一致：

| 模块 | 命令 |
| --- | --- |
| pages | `node modules/pages/server/dev.js --data-file /tmp/pages-dev.json` |
| disk | `node modules/disk/server/dev.js --data-file /tmp/disk.json` |
| glim | `node modules/glim/server/dev.js --data-file /tmp/glim.json` |
| mail | `node modules/mail/server/dev.js --config /tmp/mail-config.json` |
| survey | `node modules/survey/server/dev.js --data-file /tmp/survey.json` |
| paper | `node modules/paper/server/dev.js --data /tmp/paper.json --uploads /tmp/paper-uploads` |

`dev.js` 只监听 `127.0.0.1:0`，**不是生产入口**；开发身份头只用于本地调试。

### 4.2 方式二：装进公共核心

以下命令可用（模块装配接口由 P3 落地）：

```bash
node -e '
const path = require("node:path");
const { createCore, createServer } = require("./core/server");
const { loadConfig } = require("./core/config");
const core = createCore({ config: loadConfig({ env: {}, dataRoot: "/tmp/pagesai-mount" }) });
core.modules.configProvider = (id) => (id === "pages" ? { dataFile: "/tmp/pagesai-mount/pages.json" } : undefined);
core.modules.install(require("./modules/pages/manifest.json"), { dir: path.join(process.cwd(), "modules", "pages") });
(async () => {
  const state = await core.modules.enable("pages");
  console.log("ready:", state.ready, "configured:", state.configured);
  const app = createServer(core);
  const info = await app.listen({ port: 0, host: "127.0.0.1" });
  const res = await fetch(info.url + "/api/pages/info");
  console.log("info:", res.status, await res.text());
  const disk = await fetch(info.url + "/api/disk/files");
  console.log("disk route:", disk.status);
  await app.close();
  process.exit(0);
})();
'
```

预期：`ready: true configured: true`；`/api/pages/info` 200；`/api/disk/files` 404（未安装）。

要点：

- `install()` 只校验清单，不加载代码；`enable()` 才 `require`。
- 配置通过 `configProvider` 注入；当前 `loadConfig()` 不产出 `moduleConfig`，装配层必须自行提供。
- 只有启用后，模块路由才进入 `modules.allRoutes()` 并被挂载。
- 管理员可通过 `POST /api/admin/modules/:id/enable|disable` 启停已登记模块。
- 管理员可通过 `GET /api/admin/modules` 查看全部已登记模块的状态与后台贡献，`GET /api/admin/modules/:id` 查看单个模块（未登记返回 `404 MODULE_NOT_INSTALLED`）。这两个接口与启停接口都只接受管理员：未登录 `401`，普通用户 `403`。
- 后台贡献来自各模块 `activation.adminContribution` 声明的文件（默认 `server/admin.js`），只在模块启用后加载；贡献不可用时接口返回真实原因，不返回占位内容。

### 4.3 方式三：安装器与部署预设

安装器生成配置，预设的 init 命令与生成的配置逐字段一致：

```bash
cd source/site/public-release/pagesai
node tools/init.js --data-root /srv/pagesai-data --modules all \
  --disk-variant generic --registration open --domain example.com --port 8080 --dry-run
node deploy/validate-presets.js --matrix
```

预期安装器打印计划、`validate-presets.js` 末尾 `结果：PASS`。限制：容器镜像未在本机构建（预设为 `:local` 标签）；`validate-presets.js` 只校验静态计划；不含模块实现之外的前端、凭据与 TLS；不要在生产主机直接 `up`。

### 4.4 记录存储区域

模块清单声明了区域（`pages.sites`、`pages.materials`、`pages.ai-workspace`、`pages.backends`、`disk.user-files`、`glim.state`、`mail.mailbox`、`survey.responses`、`survey.attachments`、`paper.uploads`）。部署时应在核心登记，例如：

```bash
node -e '
const { StorageRegistry } = require("./core/storage/registry.js");
const reg = new StorageRegistry({ dataRoot: "/srv/pagesai/data" });
console.log(reg.registerRegion({
  regionId: "disk.user-files",
  module: "disk",
  physicalRoot: { configKey: "storage.disk.root", defaultSubpath: "disk", allowImplicitChange: false },
  ownership: { rule: "per-user", ownerField: "username" },
  allowedOperations: ["read", "write", "delete", "rename", "mkdir"],
  disk: { visible: true, syncable: true },
  quota: { basis: "logical-bytes", accounting: "per-user" }
}));
'
```

`disk` 数据面只对外暴露清单声明的 `disk.user-files`；`disk.upload-tmp`、`disk.preview-cache`、`disk.share-registry` 以及仅北大版使用的 `disk.pku-archive` 属于部署内部区域，由 `tools/init.js` 一并登记，不由业务请求直接寻址。其余模块的区域名与其 `tools/init.js` 部署表尚在收敛中，当前以模块清单为准。

未登记区域时模块仍可按自己的 `dataFile`/`uploadsDir` 工作，但不满足「物理根只经配置解析」的验收要求。

## 5. 组合规则与负向依赖

| 组合 | 期望行为 | 现状 |
| --- | --- | --- |
| 仅核心 | 可启动，无业务路由 | 已实现 |
| 核心 + 任一模块 | 只有该模块路由，其他前缀 404 | 已实现 |
| 任意组合（64 种） | 静态依赖闭包与配置完整性 | 静态校验 PASS；真实运行级未验证（G05） |
| 核心 + 未装 Mail + 邮箱注册开启 | 启动失败 | 已实现 |
| 核心 + 装 Mail 但未配置发信 + 邮箱注册开启 | 注册 `MAIL_NOT_CONFIGURED` | 核心侧已实现；Mail 适配器需注入 |

避免的隐性依赖：不要求未选模块的配置；不因未装模块而启动失败（邮箱注册是唯一显式例外）；后台菜单不出现未安装模块；不留隐藏可调用接口。

## 6. 停用与卸载

| 操作 | 行为 | 数据 |
| --- | --- | --- |
| 停用模块 | 先 `stop()`；路由消失，`installed` 保留 | 默认保留 |
| 重新启用 | 正常配置校验与健康检查 | 不变 |
| 卸载模块 | 停用后移除登记 | **默认保留**数据与区域 |
| 永久删除 | 独立维护操作，执行前列出范围 | 显式删除 |

`ModuleHost.uninstall()` 只移除进程内登记；物理数据与区域清理属部署工具职责（当前无该工具）。客户端/本地文件不会因卸载而删除。

## 7. 安装检查清单（发布前）

- [ ] 全新环境可启动核心并通过冒烟。
- [ ] 六个模块各自 `node --test modules/<id>/tests/*.test.js` 全绿。
- [ ] 每个模块单独 `dev.js --once` 可启动。
- [ ] 装进核心后只有已启用模块的路由存在。
- [ ] 重复安装/初始化幂等；失败可回退，不静默重建空库。
- [ ] 安装过程不连接生产服务、不写入既有站点数据根。
- [ ] 配置与日志不含真实域名、IP、账号或密钥。

## 已知缺口

| ID | 与本篇相关的影响 |
| --- | --- |
| K5 | **部分**：安装器与预设已实现，真实部署演练通过；容器镜像未构建、未在 Docker 主机验证 |
| K1 | ~~核心身份在内存~~（已关闭）：MongoDB 为权威，内存仅开发模式 |
| K2 | ~~核心未接入持久化存储注册表~~（已关闭）：区域、修订与事件在 `storage_*` 集合 |
| K4 | ~~无后台界面~~（已关闭，C29：统一后台与模块管理贡献） |
| K6 | 无统一配额与用量统计 |
| K7 | **部分**：`THIRD_PARTY_NOTICES.md` 与许可清单已建立；根 LICENSE 待决策，尚不可发布 |

完整清单与来源见 [`docs/README.md`](../README.md#已知缺口清单)。