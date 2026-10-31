# 第三方组件声明

第一方源码按根 [LICENSE](LICENSE) 的 MIT 许可提供，Copyright (c) 2026 lfc070213。第三方组件保留各自许可；根 MIT 不覆盖、替换或重新授权第三方代码。

## 当前随源码提供的材料

- 依赖声明与锁文件：`package.json` / `package-lock.json`、各 Rust workspace 的 `Cargo.toml` / `Cargo.lock`。
- 离线依赖清单：[`docs/licenses/dependency-licenses.md`](docs/licenses/dependency-licenses.md)及对应 JSON。当前共 603 项：npm 49、Cargo 552（含两个第一方 workspace）、素材 1、项目 1。
- Cargo 来源证据：`docs/licenses/cargo-evidence.json` 记录真实 crate 归档校验和、许可声明和附带文本哈希；第三方许可与 NOTICE 位于 `docs/licenses/cargo/<名称-版本>/`。少数文本经 Git 换行归一化，证据中明确记录，并已与原始文件核对内容。
- 素材证据：`docs/licenses/asset-evidence.json` 记录项目图标的哈希与许可。新增素材必须另行登记来源。

“已确认”表示工具已核对声明、锁文件与相应证据，不表示第三方许可全部相同，也不替代对具体分发方式的许可审查。

## 安装及构建依赖

Node.js 运行时不随本源码包分发。运行依赖为 `mongodb` 及其传递依赖；`mongodb-memory-server` 等仅用于测试。使用者安装 npm 依赖后，应保留各包自带的 LICENSE、NOTICE 和版权声明。

Rust 同步引擎与 Tauri 客户端的依赖列在 Cargo 清单中。本次网页预览版不分发桌面二进制；未来分发客户端或其他二进制时，必须根据实际链接内容再次核对许可与附带声明，不能只引用源码包结论。

Python 不是当前公开版的运行依赖；旧私人 Glim 环境的 Python 包不在本次分发范围。

## PDF.js 与 KaTeX

本次源码包没有 vendored PDF.js（上游 Apache-2.0）或 KaTeX（上游 MIT），不把“计划引入”写成已经分发。若未来加入二者的代码、字体或压缩产物，必须同时提供对应版本的完整许可、版权及必要 NOTICE，并更新依赖证据和实际文件登记。

## 容器

Dockerfile 的 Node.js 与 MongoDB 基础镜像已锁定来源摘要；它们包含独立授权的软件。源码仓库不托管预构建镜像，使用者本地构建时仍须保留基础镜像及安装依赖的原有许可文件。

## 可复核命令

```bash
node tools/license-scan.js --check
node --test tests/contracts/license-evidence.test.js
```

采集器只读、离线，不安装依赖；不能确认的条目保留“待确认”，不能为使门禁通过而改写第三方许可。
