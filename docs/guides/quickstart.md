# 快速开始（Core + Pages）

本文是当前 MongoDB 正式数据面的最小启动路径。其他业务模块的安装与连接状态见各自文档；不要把旧 `dev.js` 身份头当作认证。

## 前置条件

- Node.js 24；
- 可用的 MongoDB replica set；
- 独立、显式的数据根；
- `npm ci --ignore-scripts` 只安装公开包声明的 `mongodb` 等依赖。测试 Mongo 二进制和测试依赖必须放在仓库外，不读取生产 `.env`。

## 初始化与启动

```bash
cd pagesai
npm ci --ignore-scripts

node tools/init.js \
  --data-root /tmp/pagesai-quickstart-data \
  --modules pages \
  --install-root "$PWD" \
  --config "$PWD/config.json"

PAGESAI_MONGO_URL='mongodb://127.0.0.1:27017/?replicaSet=rs0' \
  node core/start.js --config "$PWD/config.json" --host 127.0.0.1 --port 8080
```

`tools/init.js` 不启动服务。`core/start.js` 要求绝对 `--config`，只启用配置选择的模块。数据库未登记、模式版本或 `deploymentId` 不匹配时启动失败，不回落内存或 JSON。

## 管理员和控制台

一次性引导管理员。启动服务时必须设置 `PAGESAI_BOOTSTRAP_TOKEN`；若使用 README 的 Compose 命令，继续在同一个终端执行：

```bash
printf '新管理员密码：'
stty -echo
IFS= read -r PAGESAI_ADMIN_PASSWORD
stty echo
printf '\n'
export PAGESAI_ADMIN_PASSWORD
node - <<'JS'
(async () => {
  if (!process.env.PAGESAI_BOOTSTRAP_TOKEN || !process.env.PAGESAI_ADMIN_PASSWORD) throw Error('需要 bootstrap token 和管理员密码');
  const response = await fetch('http://127.0.0.1:8080/api/admin/bootstrap', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({username: 'rootadmin', password: process.env.PAGESAI_ADMIN_PASSWORD, bootstrapToken: process.env.PAGESAI_BOOTSTRAP_TOKEN})
  });
  console.log('管理员引导 HTTP 状态：', response.status);
  if (response.status !== 201) process.exitCode = 1;
})();
JS
unset PAGESAI_ADMIN_PASSWORD
```

密码不作为命令行参数或固定示例写入历史。首次成功返回 201；后续引导会被拒绝。

打开 `http://127.0.0.1:8080/pages`，使用管理员登录，或注册普通用户。控制台使用核心 HttpOnly 会话 Cookie，不需要也不接受开发身份头。

管理员可在“模型配置”中添加 OpenAI 兼容模型。密钥仅配置为 `env:NAME` 引用，秘密值由启动环境提供。只有明确测试时才同时设置：

```json
{"moduleConfig":{"pages":{"allowTestModel":true}}}
```

以及环境 `PAGESAI_ALLOW_TEST_MODEL=1`，然后添加 `deterministic-test`。该模型完全本地、确定、无网络，不代表外部模型验收。

## 最小业务流程

1. 创建站点并上传材料；
2. 选择模型、提交任务，查看 SSE 过程和任务产物；
3. 在工作区预览、编辑和保存文件；
4. 显式发布后打开公开链接；
5. 继续修改工作区，确认公开页仍保持已发布快照；
6. 从版本列表恢复，确认工作区与公开指针一起恢复；
7. 可选部署租户后端，验证停止、恢复和独立数据库名。

预览与公开读取不同修订来源，均不需要管理会话。当前租户后端和 worker **不是容器安全沙盒**，不可用于抵御恶意代码。

## 测试

```bash
# 核心和集成测试；Mongo 用例在未显式启用时明确跳过
npm test

# Pages 旧兼容路径及清单测试
node --test modules/pages/tests/*.test.js

# 聚合全部核心与六模块测试
node tools/test-all.js
```

真实 Mongo、干净临时安装和 Pages 全 HTTP/SSE E2E：

```bash
NODE_PATH=/tmp/pagesai-mongo-build/node_modules \
MONGOMS_SYSTEM_BINARY=/tmp/pagesai-mongo-build/binaries/mongod-arm64-darwin-7.0.24 \
PAGESAI_MONGO_TEST=1 \
node --test tests/integration/pages-clean-install.test.js
```

E2E 使用仓库外依赖和系统临时目录，不访问生产环境。它验证本地确定性模型和本地协议桩，不验证真实外部模型；静态控制台资源经 HTTP 检查，真实浏览器交互自动化尚未执行。

## 停止与数据

按 `Ctrl-C` 会停止接收任务、取消运行 worker 并停止后端子进程；queued 任务和 `desiredStatus=running` 的后端在下次启动恢复。文件正文、修订、身份、任务和后端状态保留。不要用删除数据根的方式“清理”部署；后端关联站点会被拒绝删除，系统没有静默删除租户数据库的接口。
