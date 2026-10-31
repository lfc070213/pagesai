# PagesAI

可模块化部署的 AI 网页与个人工具平台。**六个模块均可单独使用，也可自由组合；每个模块只依赖公共核心，不强制安装其他业务模块。**

本仓库是 `0.1.0` 网页预览版，用于展示源码与在独立环境中试运行。桌面客户端仍处于实验阶段，本次不分发安装包。它与现有 PagesAI 在线服务使用不同的部署和数据，不会自动连接现有用户或生产配置。

| 模块 | 功能 | 入口 | 文档 |
| --- | --- | --- | --- |
| Pages | AI 创建、修改、预览和发布网页 | `/pages` | [Pages](docs/modules/pages.md) |
| Disk | 单逻辑盘、文件与分享、版本和回收站 | `/disk` | [Disk](docs/modules/disk.md) |
| Glim | 智能助手；可选连接其余五模块 | `/glim` | [Glim](docs/modules/glim.md) |
| Mail | SMTP 发信与 IMAP 邮箱客户端 | `/mail` | [Mail](docs/modules/mail.md) |
| Survey | 问卷创建、发布、填写、答卷与统计 | `/survey` | [Survey](docs/modules/survey.md) |
| Paper | 论文上传、阅读、翻译与问答 | `/paper` | [Paper](docs/modules/paper.md) |

Glim 的连接由已安装模块、健康状态和用户授权决定；登记连接不等于获得数据权限。邮箱验证注册必须安装并配置 Mail。普通注册不依赖邮箱，后台只有一个管理员层级，功能按安装模块装配。

## 试运行

需要 Node.js 24、Docker Engine 和 Docker Compose v2。建议使用单独的测试机器或虚拟机。首次构建需要访问 npm 和镜像仓库。

```bash
git clone https://github.com/lfc070213/pagesai.git
cd pagesai
npm ci --ignore-scripts --no-audit --no-fund

export PAGESAI_BOOTSTRAP_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
export PAGESAI_MONGO_PASSWORD="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"

# 首次必须先构建，再运行初始化容器。
docker compose -f deploy/presets/single-pages.yml build
docker compose -f deploy/presets/single-pages.yml --profile setup run --rm --no-deps init
docker compose -f deploy/presets/single-pages.yml up -d --wait
```

访问 `http://localhost:8080/pages`。首次管理员创建方法见[快速开始](docs/guides/quickstart.md)。请在创建管理员前限制机器的入站访问；示例 Compose 会发布宿主机 8080 端口，公网使用前须配置 HTTPS、来源校验与限流。保存部署密码到自己的秘密管理系统，后续启动需要保持一致，勿提交到 Git。

换用任意 `single-disk.yml`、`single-glim.yml`、`single-mail.yml`、`single-survey.yml` 或 `single-paper.yml` 即可独立试用对应模块；`full-generic.yml` 装配全部模块。预设首次初始化后，不要直接切换预设来改变同一数据卷的模块列表，按[安装指南](docs/guides/install.md)管理配置。

AI 功能需要自己的模型服务配置，收发邮件需要自己的 SMTP/IMAP 服务；仓库不提供 API Key、邮箱账户或付费额度。本地协议桩通过不等于真实第三方服务投递或推理验收。

## 版本范围

- 当前以网页端与服务端模块为交付范围；客户端源码仅供研究，存在待修复的 API 配对路径问题，暂不建议使用。
- 通用 Disk 不使用校园分流；北大版保留网络策略，仍是同一个逻辑盘与数据根。真实校园链路尚未验收。
- 数据根和区域登记独立于 Disk 的安装；Disk 只提供已授权区域的可见视图。
- Pages worker 和租户后端目前是受限子进程，**不是恶意代码安全沙盒**，仅供可信测试者使用。
- 暂不建议直接承载真实用户或敏感数据。当前安全边界见 [SECURITY.md](SECURITY.md)，首发验收与后续工作见[网页预览版状态](docs/web-preview.md)。

## 开发与验证

```bash
npm ci --ignore-scripts --no-audit --no-fund
# 普通测试；MongoDB 集成用例会明确跳过
node tools/test-all.js
# 全量测试；临时 MongoDB、测试数据均不连接现有生产系统
NODE_PATH="$PWD/node_modules" PAGESAI_MONGO_TEST=1 node tools/test-all.js
node deploy/validate-presets.js
node tools/license-scan.js --check
# 白名单导出，自动排除内部审计、秘密、数据与构建缓存
node tools/public-bundle.js --out /tmp/pagesai-public-preview
node tools/verify-release.js --artifact /tmp/pagesai-public-preview
```

[安装](docs/guides/install.md) · [备份与恢复](docs/guides/backup-restore.md) · [故障排查](docs/guides/troubleshooting.md) · [贡献](CONTRIBUTING.md)

## 许可证

第一方源码使用 [MIT License](LICENSE)，Copyright (c) 2026 lfc070213。第三方组件保留各自许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 [依赖许可清单](docs/licenses/dependency-licenses.md)。
