# CI 与发布流水线

权威配置为 `.github/workflows/ci.yml`、`acceptance.yml` 和 `release.yml`。历史施工文档中的旧 job 名与旧测试数不再适用。

## CI

push、PR 或人工触发后，在 Ubuntu 与 Node.js 24 上安装锁定依赖，运行全部 Node 测试（启用临时 MongoDB）、Rust 同步协议测试、12 预设静态矩阵、许可清单一致性、白名单导出和导出制品检查。

干净安装测试会复制源码到临时目录，因此通过 `NODE_PATH=$GITHUB_WORKSPACE/node_modules` 使用明确安装的测试依赖；不会读取生产环境或用户数据。

## 容器验收

`acceptance.yml` 只在人工触发时执行。隔离运行器构建 app、gateway 和 MongoDB 镜像，逐个启动 12 个预设，检查管理员事务写入、登录、模块隔离和重启持久化，再删除该预设的测试容器及数据卷。

第一方镜像由源码构建，基础镜像锁定真实 sha256；日志与验收报告作为短期 Actions artifact 保存。验收不发送真实邮件，不调用付费模型，不部署现有 PagesAI 服务，也不验证校园链路或桌面客户端。

## 打包

`release.yml` 只在人工触发时运行，绑定 `release` environment。需要人工审批时，仓库管理员必须实际配置 Required reviewers；配置文件中的环境名本身不会自动产生审批要求。

流水线连续导出两次并比较清单与归档，上传源码包与校验信息，不自动部署、不自动改变仓库可见性，也不自动发布客户端。
