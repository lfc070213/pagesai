# PagesAI Disk 桌面客户端

Tauri 2 壳 + Rust 同步引擎。服务地址和同步目录由使用者选择，不内置域名，不同步整个设备或用户主目录。

## 构建

```bash
cd src-tauri
CARGO_TARGET_DIR=/tmp/pagesai-disk-client-target cargo check --offline
CARGO_TARGET_DIR=/tmp/pagesai-disk-client-target cargo check --offline --no-default-features --features pku
```

打包需要 Tauri CLI、平台工具链与部署者签名材料；当前仓库只验证 Rust 编译，未生成签名安装包。

## 凭据与状态

- 设备令牌：macOS Keychain / Windows Credential Manager / Secret Service，服务名 `cn.pagesai.disk`，账户名是设备 ID。
- 非秘密设置：系统配置目录下的 `settings.json`（服务地址、同步目录、间隔、开机自启）。
- 同步状态：`<同步目录>/.pagesai/`，详见 [`../../docs/disk-sync.md`](../../docs/disk-sync.md)。

## 已知外部条件

- `tauri.conf.json` 的更新端点与公钥是占位值，替换前不构成可信更新链。
- Windows/macOS 真机安装、代码签名和公证未在开发环境完成。
- 校园链路需要在北大版构建中配置真实端点，并与直连指向同一服务实例。
