# 部署预设（deploy/）

本目录提供 PagesAI 公开版的 **真实运行单元编排**、**进程入口**、**镜像定义** 与 **静态校验器**。

- 归属：P6 / G03 与 C30–C32（镜像、安装器、Compose 预设与组合验收）。
- 编排状态：`presets/` 下 12 个文件由 `presets/model.js` 单一来源生成，静态校验通过。
- 运行状态：**尚未在真实 Docker 主机构建与启动**。本开发机没有容器运行时（`docker`、`podman`、`nerdctl`、`colima` 均不可用），因此镜像标记为 **未构建**，Compose 只完成静态与语义校验，没有任何运行证据。
- 边界：本目录只负责进程编排、数据卷、健康/就绪顺序与最小配置；不包含模块实现、后台管理页、模型凭据、SMTP/IMAP 凭据或 TLS 证书。
- 约束：只使用 Node 内置模块；不写真实域名、IP、账号或密钥；`generic` 与 `pku` 共用同一套镜像与同一个数据卷。

## 1. 运行单元

首版只有四类运行单元，均由真实进程入口驱动，不存在“给不存在的服务填镜像”的情况：

| 服务 | 镜像 | 入口 | 端口 | 职责 |
| --- | --- | --- | --- | --- |
| `gateway` | `pagesai/gateway:local` | `deploy/docker/entrypoints/gateway.js` | 发布 `8080:8080`（唯一对外端口） | 流式反向代理，转发到 `http://app:8080`；自己不做鉴权，也不读 `config.json` |
| `app` | `pagesai/app:local` | `deploy/docker/entrypoints/app.js` | 仅 `expose 8080` | Node 公共核心 + 已安装模块 + 控制台静态资源；读写 `/data` |
| `mongo` | `mongo:7` | 官方入口 | 仅集群内 `27017` | 身份与元数据；只在需要时启动 |
| `init` | `pagesai/app:local` | `node tools/init.js` | 无 | 只在 `--profile setup` 下运行一次，写 `/data/config.json` |

关键事实：

- **Glim 与 Disk 是 `app` 进程内的 Node 模块**，不是独立 Python 服务，也不监听 8090 / 8091。
- **Pages worker 是 `app` 通过 `fork` + IPC 启动的子进程**，不是独立监听端口的服务，因此没有 `worker` Compose 服务，也不发布端口。`deploy/docker/Dockerfile.worker` 只作为可复用的执行资产镜像，其 `--check` 用于 CI / HEALTHCHECK。
- 因此服务集合恒为 `gateway`、`app`、`mongo`（按需）、`init`（仅 profile）；模块选择只改变 `app` 的 `PAGESAI_MODULES` 与 `init` 的 `--modules`，不改变服务拓扑。

镜像定义见 `deploy/docker/Dockerfile.gateway`、`Dockerfile.app`、`Dockerfile.worker`，构建上下文必须是公开版根目录。

## 2. 预设清单

12 个文件与方案 §13.1 第 4 条一一对应，全部由 `presets/model.js` 生成：

| 预设 | 模块 | 启动服务 | 注册方式 | Disk 版本 |
| --- | --- | --- | --- | --- |
| `core-only.yml` | 无（仅核心） | gateway、app | open | — |
| `single-pages.yml` | pages | gateway、app、mongo | open | — |
| `single-disk.yml` | disk | gateway、app、mongo | open | generic |
| `single-glim.yml` | glim | gateway、app、mongo | open | — |
| `single-mail.yml` | mail | gateway、app | open | — |
| `single-survey.yml` | survey | gateway、app、mongo | open | — |
| `single-paper.yml` | paper | gateway、app、mongo | open | — |
| `pages-disk.yml` | pages、disk | gateway、app、mongo | open | generic |
| `survey-disk.yml` | survey、disk | gateway、app、mongo | open | generic |
| `paper-disk.yml` | paper、disk | gateway、app、mongo | open | generic |
| `full-generic.yml` | 六模块全部 | gateway、app、mongo | open | generic |
| `full-pku.yml` | 六模块全部 | gateway、app、mongo | email | pku |

`init` 在全部预设中都存在，但只在 `--profile setup` 下运行。

- `mail` 单装不启动 `mongo`：Mail 使用外部 SMTP/IMAP，不需要本地数据库；核心身份此时落在数据根。
- `full-pku.yml` 同时把注册方式切到 `email`（北大版按邮箱准入），因此必须安装 `mail`；校验器会拒绝“邮箱注册但未安装 Mail”的组合。
- 除上表显式标注外，其余预设的 Disk 版本为 `generic`、注册方式为 `open`。

### 64 种静态组合校验

六模块共有 `2^6 = 64` 种选择组合。运行：

```bash
node deploy/validate-presets.js --matrix
```

该校验会：

1. 用 `presets/model.js` 生成全部 64 种组合；含 Disk 的 32 种组合各覆盖 `generic` 与 `pku` 两个版本，得到 96 次版本检查，并对每个版本跑一次“邮箱注册依赖 Mail”“pku 依赖 Disk”的负向探针；
2. 把每个模型渲染为受限 YAML，再解析回读，核对“渲染 → 解析”与模型逐字段一致；
3. 校验模块集合决定的服务集合、`PAGESAI_MODULES`、`init` 的 `--modules`、数据卷与依赖顺序；
4. 校验 `generic` 与 `pku` 除 `--disk-variant` / `--registration` 两个取值外完全相同；
5. 校验镜像引用、Dockerfile 契约、真实地址与明文秘密。

完整校验（默认即执行）：

```bash
node deploy/validate-presets.js
```

额外核对 12 个静态预设与 `model.js` 渲染结果逐字节一致。任何违规都会打印 `[作用域] 原因` 并以退出码 `1` 结束。

> 64 种组合只做静态闭包校验；真实启动覆盖 12 个代表预设。当前**一个都没有真实启动过**，见第 9 节。

## 3. 首次初始化

`init` 用与应用镜像相同的代码，把模块选择、Disk 版本与注册方式写进 `/data/config.json`。它必须与后续 `app` 使用同一组参数，否则 `app` 启动时会因配置不一致而拒绝启动。

```bash
export PAGESAI_BOOTSTRAP_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
export PAGESAI_MONGO_PASSWORD="$(node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))")"

# 1. 写配置（一次性容器，复用 data 卷）
docker compose -f deploy/presets/full-generic.yml --profile setup run --rm init

# 2. 启动运行单元
docker compose -f deploy/presets/full-generic.yml up -d

# 3. 经唯一的对外入口验证
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
```

`init` 的完整参数由 `model.js` 生成，例如 `full-pku.yml`：

```text
node tools/init.js --container --data-root /data --install-root /opt/pagesai \
  --config /data/config.json --modules pages,disk,glim,mail,survey,paper \
  --port 8080 --disk-variant pku --registration email
```

- `--container` 要求容器环境（`/.dockerenv` 或 `PAGESAI_CONTAINER=1`），防止在宿主机误写 `/data`。
- `--disk-variant` 与 `--registration` 是唯一区分 `generic` / `pku` 的开关；它们只写配置，不改变数据面。
- 重复执行是幂等的：已有配置且参数一致时原样保留；参数不一致时拒绝覆盖，需要显式迁移命令。
- 端口 `27017` 永远被拒绝，避免业务服务占用数据库端口。

## 4. 健康检查与启动顺序

- `gateway` 的健康检查 `deploy/docker/gateway-healthcheck.js` 经自身转发请求 `/healthz` 与 `/readyz`，验证“入口 → 上游”整条链路。
- `app` 的健康检查 `deploy/docker/healthcheck.js` 直接请求本机 `/healthz`（存活）与 `/readyz`（核心与模块就绪）。
- `mongo` 使用 `ping` 探测。
- 启动顺序用 `condition: service_healthy` 表达：

```text
mongo (healthy)
  └── app (healthy)
        └── gateway (healthy)
```

- 容器 `running` 不等于业务 `ready`；`/readyz` 非 2xx 时依赖方不会启动。
- 未安装的模块没有路由、定时任务或配置校验；这由 `PAGESAI_MODULES` 与 `config.json` 共同保证。

镜像运行契约（改动镜像时必须遵守）：代码根 `/opt/pagesai`，数据根 `/data`，配置 `/data/config.json`；`app` 与 `gateway` 都监听 `8080`；uid/gid 固定 `10001`（用户 `pagesai`）；不使用 python3。

## 5. 配置与秘密

| 变量 | 服务 | 说明 |
| --- | --- | --- |
| `PAGESAI_CONFIG` | app、init | 固定 `/data/config.json` |
| `PAGESAI_DATA_ROOT` | app、init | 固定 `/data` |
| `PAGESAI_INSTALL_ROOT` | app、init | 固定 `/opt/pagesai` |
| `PAGESAI_HOST` / `PAGESAI_PORT` | app | 固定 `0.0.0.0` / `8080` |
| `PAGESAI_MODULES` | app | 已安装模块 ID 列表，必须与预设一致 |
| `PAGESAI_MONGO_*` | app | 主机 `mongo`、端口 `27017`、库 `pagesai`；用户名默认 `pagesai`，密码必填 |
| `PAGESAI_BOOTSTRAP_TOKEN` | app | 管理员首次引导令牌，必填 |
| `MONGO_INITDB_*` | mongo | 初始化管理员与数据库 |
| `PAGESAI_GATEWAY_PORT` / `_HOST` / `_UPSTREAM` | gateway | 监听 `8080` / `0.0.0.0`，上游 `http://app:8080` |

秘密处理：

- 秘密变量一律使用 `${VAR:?提示}` 引用；未设置时 Compose 直接报错，不会落成空值或默认明文。
- 只在当前 shell 导出，不写入仓库、不写入预设、不提交 `.env`。
- 密码使用十六进制或 base64url 随机串，避免连接串保留字符。
- 模型服务密钥、SMTP/IMAP 账号、对象存储凭据由管理员后台写入加密配置，**不放在 Compose 里**。Mail 采用外部 SMTP/IMAP 模式，预设不启动自建邮件服务器。

管理员引导示例（密码至少 8 位）：

```bash
curl -fsS -X POST http://127.0.0.1:8080/api/admin/bootstrap \
  -H 'content-type: application/json' \
  -d "{\"username\":\"owner\",\"password\":\"$PAGESAI_ADMIN_PASSWORD\",\"bootstrapToken\":\"$PAGESAI_BOOTSTRAP_TOKEN\"}"
```

## 6. 数据卷、备份与恢复

所有预设共用同一顶层项目名 `pagesai`，卷名稳定：

| 卷 | 容器路径 | 内容 |
| --- | --- | --- |
| `pagesai_data` | `/data` | 统一数据根：`config.json`、`pages/`、`files/`、`glim/`、`mail/`、`survey/`、`paper/` 等 |
| `pagesai_mongo-db` | `/data/db` | MongoDB 数据（仅需要 Mongo 的预设） |

约束：

- 六个模块共用**一个** `data` 卷；`generic` 与 `pku` 也共用同一个数据卷，不存在两套数据面。
- 安装、停用、卸载、重装 Disk 都不改变任何文件区域的物理位置。
- 不允许宿主机绑定挂载；不使用 `privileged`、host 网络、设备直通、额外 capability 或 `docker.sock`；校验器会拒绝这些字段。
- 不要在有数据后修改顶层项目名或手工改卷名：Compose 会创建新卷，看起来像“数据消失”。

备份与恢复：

```bash
# 备份文件数据面（一次性容器，复用同一 data 卷）
docker compose -f deploy/presets/full-generic.yml run --rm --no-deps -T app \
  tar -czf - -C /data . > pagesai-data-backup.tar.gz

# 备份数据库
docker compose -f deploy/presets/full-generic.yml exec -T mongo sh -c \
  'mongodump --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" \
   --authenticationDatabase admin --archive --gzip' > pagesai-mongo-backup.gz

# 恢复：先停业务写入，再写回同一卷
docker compose -f deploy/presets/full-generic.yml stop gateway app mongo
docker compose -f deploy/presets/full-generic.yml run --rm --no-deps -T app \
  tar -xzf - -C /data < pagesai-data-backup.tar.gz
docker compose -f deploy/presets/full-generic.yml up -d
```

备份恢复必须校验用户归属、文件哈希与业务引用，不能只看数据库进程能启动；该演练已由 `tests/integration/deploy-acceptance.test.js` 在仓库外的独立数据根上真实执行（升级 → 备份 → 校验恢复 → 拒绝覆盖 → 改名恢复 → 不兼容中止 → 卸载 → 重装重启）。容器内 `mongodump`/`mongorestore` 的等价步骤仍需在具备容器运行时的宿主上复验（见第 9 节）。

## 7. 升级、回滚、停用与卸载

### 7.1 单装

```bash
node deploy/validate-presets.js
docker compose -f deploy/presets/single-paper.yml --profile setup run --rm init
docker compose -f deploy/presets/single-paper.yml up -d
curl -fsS http://127.0.0.1:8080/readyz
```

验收要求：没有未选模块的配置要求、路由或定时任务；`PAGESAI_MODULES` 只含所选模块。

### 7.2 升级

```bash
# 1. 记录当前版本与镜像摘要，备份数据与数据库
# 2. 静态校验新预设
node deploy/validate-presets.js
# 3. 模块集合变化时重跑 init（参数一致则幂等），再滚动替换
docker compose -f deploy/presets/full-generic.yml up -d --remove-orphans
# 4. 验证就绪与数据
curl -fsS http://127.0.0.1:8080/readyz
```

模块集合缩小时必须加 `--remove-orphans`；该参数不会删除命名卷。`down -v` 会删除数据卷，除非确认永久删除，否则禁止使用。

升级必须包含：兼容性检查 → 备份 → 幂等迁移 → 启动 → 验证。

### 7.3 回滚

- 仅当数据模式兼容时，才允许把镜像切回上一个 `@sha256:` 摘要并 `up -d`。
- 数据模式不兼容时，必须恢复升级前备份或执行已验证的逆向迁移；**不得只换回旧镜像**。
- 回滚后同样验证 `/healthz`、`/readyz`、用户归属、文件哈希与业务引用。
- 当前没有执行过真实回滚。

### 7.4 停用与卸载 Disk

```bash
# 停用 Disk 模块：改模块列表并重跑 init，app 重启后不再装载 Disk
docker compose -f deploy/presets/single-disk.yml stop
docker compose -f deploy/presets/core-only.yml --profile setup run --rm init
docker compose -f deploy/presets/core-only.yml up -d
```

停用前先停止新的同步任务、收敛运行中任务、撤销设备同步授权；默认保留数据。永久删除数据是独立的显式维护操作，**预设不提供一键删卷**。模块停用不得触发同步端的误删，这一点在升级/停用验收项中单独验证。

## 8. 镜像与摘要

| 镜像引用 | 来源 | 当前状态 |
| --- | --- | --- |
| `pagesai/app:local` | `deploy/docker/Dockerfile.app` 本地构建 | **未构建**（无容器运行时） |
| `pagesai/gateway:local` | `deploy/docker/Dockerfile.gateway` 本地构建 | **未构建** |
| `mongo:7` | 官方镜像，未锁摘要 | 待锁定 `@sha256:` |
| `pagesai/worker:local` | `deploy/docker/Dockerfile.worker` 本地构建 | **未构建**，不是 Compose 服务 |

规则：

- 预设允许三种镜像写法：完整的 `@sha256:` 摘要、`pagesai/app:local` / `pagesai/gateway:local` 这类与 `build` 配对的本地标签、以及 `mongo:7` 这类明确的基础标签。其余写法一律拒绝。
- 不允许自定义/私有仓库主机（首段带点或端口）、本机地址、私有网段或任何真实 URL。
- 发布前必须把 `mongo:7` 锁到 `mongo:7@sha256:<64 位十六进制>`，并把本地标签替换为带摘要的正式引用；改动后同步更新 `presets/model.js` 与本表，再重跑校验。
- 在完成摘要锁定前，正式发布不得引用这些镜像；本地 `:local` 标签只用于开发机构建。

## 9. 已知缺口（不得宣称完成）

| 缺口 | 影响 | 归属 |
| --- | --- | --- |
| 所有镜像均**未构建** | 没有镜像、没有真实启动证据 | C30 / 发布 |
| 12 个预设都未在真实 Docker 主机启动 | 只有静态证据 | C31 / C32 |
| TLS 未包含 | 网关支持证书环境变量，但证书与终止由部署方提供 | 发布 |
| 北大真实校内外链路未验证 | 北大版只能标记**未完成** | C32 / G06 |
| 备份恢复、升级、回滚未演练 | 第 6、7 节命令未在真实数据上验证 | C33 |
| worker 沙盒隔离未完成 | 资源限制与逃逸防护未证明 | C11 |
| 自建邮箱模式未包含 | Mail 只覆盖外部 SMTP/IMAP 模式 | D06 |
| 后台管理页未完成 | 模块状态、配置缺失诊断无法在界面展示 | G01 / G02 |

## 10. 命令速查

以下命令均在公开版根目录（本目录的上一级）执行：

```bash
# 静态校验
node deploy/validate-presets.js
node deploy/validate-presets.js --matrix
node deploy/validate-presets.js --json
node deploy/validate-presets.js --print full-pku.yml

# 生成或重新生成 12 个预设（唯一来源：presets/model.js）
node deploy/presets/model.js --write

# Compose 语法（需要 Docker Compose v2；本开发机未安装，未执行）
export PAGESAI_BOOTSTRAP_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
export PAGESAI_MONGO_PASSWORD="$(node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))")"
docker compose -f deploy/presets/full-generic.yml config --quiet

# 启停（真实部署主机执行）
docker compose -f deploy/presets/full-generic.yml --profile setup run --rm init
docker compose -f deploy/presets/full-generic.yml up -d
docker compose -f deploy/presets/full-generic.yml ps
docker compose -f deploy/presets/full-generic.yml logs --tail=100 app
docker compose -f deploy/presets/full-generic.yml down   # 保留命名卷
```

`--print` 输出规范正文（不含头部注释）；12 个文件与 `model.js` 渲染结果不一致时校验会失败。

本机静态验证记录（2026-10-24，Node v24.15.0，开发机未安装 Docker）：

- `node deploy/validate-presets.js` → PASS，12/12 预设、64 种组合 / 96 次版本检查，退出码 0。
- `node deploy/validate-presets.js --matrix` → 输出 64 行，退出码 0。
- 负向用例（缺服务、错误健康检查、真实 IP / 域名、私钥、明文密钥、错误注册方式、额外数据卷、坏缩进、README 漏登记等）→ 退出码 1。

这些只是**静态**证据；镜像构建、Compose 语法检查与真实启动仍未执行。

## 11. 维护

- `presets/model.js` 是唯一的规则来源；`presets/*.yml`、`validate-presets.js` 与本文档必须与它保持一致。
- 修改编排规则时先改 `model.js`，再执行 `node deploy/presets/model.js --write`，最后跑完整校验。
- 校验器只使用 Node 内置模块；不要为 YAML 解析引入第三方依赖，预设也只使用受控的 YAML 子集（映射与标量序列，无锚点/别名/多行块）。
- 任何真实域名、IP、账号、密钥、证书或私有镜像地址都不得进入本目录。