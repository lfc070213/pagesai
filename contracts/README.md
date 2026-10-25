# 契约目录（contracts/）

本目录存放**跨模块、跨服务、跨客户端**的版本化契约。契约先冻结、再实现：任何模块实现不得私自扩展字段语义。

## 现有契约

| 文件 | 作用 | 方案依据 | 阶段 |
| --- | --- | --- | --- |
| `module-manifest.schema.json` | 模块清单：标识、依赖、装配、配置、数据、生命周期、对 Glim 开放的能力 | §4.2 | P1 / M1a |
| `storage-region.schema.json` | 存储区域登记：物理根、所有权、允许操作、Disk 暴露方式、配额口径 | §6.1、§6.2 | P2 / M1b |
| `file-change.schema.json` | 文件变更记录：operation ID、基础修订、提交状态、冲突、墓碑、游标 | §6.3 | P2 / M1b |
| `runtime-topology.json` | C03 目标进程、Node Glim、配置事实源与构建隔离 | 续建方案 §2、§4 | C03 契约冻结；入口已实现，镜像未构建（各单元 `implementationStatus` 与 `evidence` 为准） |
| `runtime-contracts.md` | 异步适配器、HTTP/文件/任务/主体契约 | 续建方案 §2、§4 | C03 契约冻结，接口已按此实现 |

## 冻结规则

1. **契约是唯一事实源**：Compose profiles、Node 装配、后台菜单、文档示例与 Glim 检测都从同一份已验证配置生成（§4.3）。
2. **加字段是兼容变更**：只能新增可选字段；必填字段、枚举取值与语义变更属于不兼容变更，必须提升主版本并同时更新 `coreCompatibility`。
3. **不得声明未实现的能力**：`capabilities.tools[].implemented` 必须如实为 `false`，不得用只返回模拟数据的适配器置为 `true` 通过验收（§7.4-8）。
4. **不得声明隐含的私人依赖**：`requires` 只能引用固定枚举内的基础设施与其他模块，不能引用私人平台、固定域名或私有网段。
5. **物理根只经配置解析**：`storage-region` 的 `physicalRoot.configKey` 指向配置键，禁止硬编码个人路径；`allowImplicitChange` 恒为 `false`（§6.1）。
6. **写入必须发变更记录**：模块自身写文件与网盘入口写文件走同一条记录（§6.3）。

## 校验方式

```bash
# JSON 语法
for f in contracts/*.json; do python3 -c "import json;json.load(open('$f'))"; done

# 契约测试（P1 起补齐）
node --test tests/contracts/
```

契约测试属于 B07 / C01 的验收证据，最少覆盖：合法清单通过、缺必填字段失败、越界路径失败、未登记 region 失败、未实现能力被误标为可用失败。