# 参与贡献

欢迎通过本公开仓库的 Issue 与 Pull Request 提交问题、修复和文档。安全问题请使用 [私密漏洞报告](https://github.com/lfc070213/pagesai/security/advisories/new)，不要公开利用细节或真实凭据。

## 开发环境

使用 Node.js 24；运行完整测试还需要临时 MongoDB 二进制，测试工具会下载到测试缓存。安装仓库声明的依赖即可，不要提交 node_modules、数据库、上传、日志或任何真实配置。

```bash
npm ci --ignore-scripts --no-audit --no-fund
node tools/test-all.js
NODE_PATH="$PWD/node_modules" PAGESAI_MONGO_TEST=1 node tools/test-all.js
node deploy/validate-presets.js
node tools/license-scan.js --check
node tools/public-bundle.js --out /tmp/pagesai-contribution-check
node tools/verify-release.js --artifact /tmp/pagesai-contribution-check
```

普通测试会明确跳过需要 MongoDB 的用例；提交涉及存储、身份或部署的行为改动时，需要运行对应 MongoDB 用例。不得为了让 CI 变绿删除测试或放宽已有安全断言。

## 提交方式

从默认分支创建自己的分支，保持改动聚焦。在 PR 中说明解决什么问题、最终行为、验证命令与结果。文档和评审可使用中文，代码标识符与协议字段使用英文。

核心与模块协议位于 `contracts/`，模块实现位于 `modules/<id>/`，部署模型位于 `deploy/presets/model.js`。预设文件由模型生成，修改后运行 `node deploy/presets/model.js --write` 和校验器。

涉及协议、身份或授权的变更，应提供合法与拒绝场景的回归测试，并同步模块兼容声明及文档。涉及模块装配时，验证未安装模块不加载、不挂路由。

## 维护者同步

维护者在受保护的开发仓库中维护权威源码，再导出到公开仓库。外部 PR 合并后，维护者需要先将改动同步回权威源码，避免下次导出覆盖贡献；贡献者不需要访问私人开发环境或运行内部同步脚本。

## 许可与署名

提交贡献表示你有权以本项目的 MIT 许可提供该贡献。第三方来源需保留原有许可与署名，不能把第三方代码改称第一方 MIT 代码。请为提交添加 `Signed-off-by`，按 [Developer Certificate of Origin](https://developercertificate.org/)确认贡献来源。

本次网页预览版不分发客户端安装包；客户端签名、真实设备和校园链路验收属于后续工作，不能用静态测试替代。
