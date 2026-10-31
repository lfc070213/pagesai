# PagesAI 应用镜像（公共核心 + 已安装模块 + 控制台静态资源）
#
# 构建（上下文必须是公开版根目录）：
#   docker build -f deploy/docker/Dockerfile.app -t pagesai/app:local .
#
# 运行契约：
#   - Node 版本与 package.json engines 一致（>=24）；
#   - 非 root 用户 pagesai (uid/gid 10001)；
#   - 代码根 /opt/pagesai，数据根 /data，配置 /data/config.json；
#   - 入口 deploy/docker/entrypoints/app.js 读取 config.json，监听 config.port；
#   - 健康检查同时请求 /healthz 与 /readyz。
#
# 本文件不写入任何账号、口令、域名或镜像 digest。

FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

ENV NODE_ENV=production \
    PAGESAI_INSTALL_ROOT=/opt/pagesai \
    PAGESAI_DATA_ROOT=/data \
    PAGESAI_CONFIG=/data/config.json \
    PAGESAI_HOST=0.0.0.0

RUN groupadd --gid 10001 pagesai \
 && useradd --uid 10001 --gid pagesai --home-dir /home/pagesai --create-home --shell /usr/sbin/nologin pagesai

WORKDIR /opt/pagesai

# 先只复制依赖清单，利用层缓存；生产依赖只有 mongodb（见 package.json）。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY --chown=pagesai:pagesai . .

# 命名卷首次挂载会继承该目录的属主，保证非 root 进程可写。
RUN mkdir -p /data \
 && chown -R pagesai:pagesai /data

USER pagesai

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "deploy/docker/healthcheck.js"]

CMD ["node", "deploy/docker/entrypoints/app.js"]
