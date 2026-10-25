# 安全政策（SECURITY）

本文件说明**如何报告安全问题**、**哪些版本受支持**，以及公开版必须始终成立的**关键安全不变量**。
部署加固清单与"已实现/未实现控制"的完整清单在 `docs/guides/security.md`；本文只写披露渠道、支持范围与不变量，不重复那份表。

- 状态：**公开版尚未发布**（版本 `0.1.0` 开发中）。因此本文的渠道与时限是**发布前置项**，渠道未落实前不得对外宣称"有安全披露流程"。
- 责任边界：本文件由发布证明负责人维护；渠道与时限的最终确认人 = 项目负责人。

## 1. 漏洞报告渠道

负责人已于2026-10-25确认使用 GitHub Private Vulnerability Reporting，维护者署名 lfc070213，不设置占位安全邮箱。最终公开仓库的 Security → Advisories → Report a vulnerability 是报告入口。仓库公开后必须实际启用并核对该入口，发布验收记录需写明结果；在此之前仅表示渠道已选定。

请私密报告受影响版本、复现步骤、影响及是否已公开；不要在公开 Issue/PR 中披露漏洞、真实用户数据、密钥或令牌。

## 2. 响应时限（目标值，负责人确认后生效）

| 阶段 | 目标 | 说明 |
| --- | --- | --- |
| 确认收到 | ≤ 3 个工作日 | 只回复"已收到 + 报告编号" |
| 初步评估（是否成立、严重度） | ≤ 7 个工作日 | 可能要求补充信息 |
| 修复窗口：严重（可未授权读写/提权/远程代码执行） | ≤ 14 天 | 期间不公开细节 |
| 修复窗口：高（需登录的越权、会话固定、路径越界） | ≤ 30 天 | 可与报告者协商 |
| 修复窗口：中/低 | 下一个发布版本 | 在 `CHANGELOG.md` 记录 |
| 协调披露 | 修复版本发布后 ≤ 14 天，或与报告者另行约定 | 默认 90 天上限，早于上限修复完成即可披露 |

时限是**目标值**，不是对报告者的法律承诺；未按期完成时维护者必须主动告知原因与新的预计时间。

## 3. 支持版本

| 版本 | 支持状态 | 安全修复 |
| --- | --- | --- |
| `0.1.x`（未发布，开发中） | 开发版，不对外 | 不承诺 |
| 最新正式发布版（首发后由负责人填具体版本号） | **支持** | 只对最新一个次版本提供安全修复 |
| 更早的版本 | 不支持 | 请先升级；升级前的迁移与备份见 `docs/guides/upgrade.md` |

原则：**只支持最新发布版本**。公开版是自托管软件，维护者无法为每个历史部署回补补丁；部署者负责及时升级，并保留升级前的加密备份。

## 4. 关键安全不变量（发布即承诺；回归即阻断）

下列五条是"公开版不得退化"的底线。每条都给出实现位置、测试证据与**当前已知缺口**；缺口语义是"已知且记账"，不是"已修好"。

### 4.1 会话撤销

- **要求**：撤销后旧令牌**立即**失效，不能靠"等过期"；改密、强制下线、停用账号都必须触发撤销。
- **实现**：`core/identity/service.js` 用 `authVersion` 比对（`SESSION_REVOKED`，HTTP 401）；`revokeAllSessions()` 递增 `authVersion` 并清理该用户的会话记录；`core/identity/store.js` 会话表按令牌摘要索引。
- **令牌处理**：32 字节随机 `base64url`，**只存 SHA-256 摘要**，不存明文；Cookie 名 `pagesai_sid`，`HttpOnly; SameSite=Lax; Path=/`。
- **测试**：`tests/contracts/identity.test.js`（登出后 401、改密后旧会话失效）。
- **已知缺口**：Cookie **未设置 `Secure`**（`core/server.js` 的 `set-cookie` 串），必须由部署者用反向代理强制 HTTPS；TLS 不由核心终结。`SameSite=Lax` 只覆盖部分 CSRF 场景，**没有 CSRF token**。

### 4.2 最后管理员保护

- **要求**：系统任何时刻都必须至少有一名**有效**管理员；删除、停用、降级最后一名管理员必须被拒绝（HTTP 409 `LAST_ADMIN_PROTECTED`）。
- **实现**：`core/identity/service.js` 的三处判定（`setRole` / 停用 / 删除）；角色只有 `user` 与 `admin` 两种，**没有第二层管理员**。
- **引导**：首名管理员只能一次性引导（`POST /api/admin/bootstrap`），第二次返回 `BOOTSTRAP_CLOSED`；设置 `PAGESAI_BOOTSTRAP_TOKEN` 后必须带同值，否则 403。并发引导只允许一个成功。
- **测试**：`tests/contracts/identity.test.js`、`tests/integration/core-boot.test.js`。
- **已知缺口**：身份存储当前是**内存实现**，重启后用户与会话丢失（K1）。这条不变量在"持久化适配器接入前"只在进程生命周期内成立；不得把当前状态当作可正式部署。

### 4.3 路径越界

- **要求**：任何以用户输入参与文件路径的入口，都必须拒绝绝对路径、反斜杠、空字节、`.`/`..` 段，并保证解析结果仍在**已登记区域根**之内；未登记区域直接拒绝。
- **实现**：`core/storage/registry.js`（`PATH_ESCAPE`；解析后前缀校验；`REGION_UNKNOWN`；区域模块归属/允许操作/按用户所有权/Disk 只读视图四类授权）；`core/registry/manifest.js` 与 `core/registry/host.js` 对模块清单里的 `config.schema`、`serverEntry` 做同样的越界拒绝。
- **测试**：`tests/contracts/storage.test.js`、`tests/contracts/registry.test.js`。
- **已知缺口**：当前是**词法校验**，尚未做 `realpath`/`O_NOFOLLOW` 级别的符号链接防护（`docs/guides/security.md` §3 已登记）。在有不受信用户可创建符号链接的共享目录上部署时，这条缺口可被利用；此类部署不在当前支持范围。

### 4.4 变更幂等

- **要求**：文件变更必须带 `operationId`；**同一操作重放不得产生第二次写入**，必须返回 `idempotent: true`；基础修订不匹配必须 409 冲突且**不覆盖**；删除产生的墓碑只能由明确的 delete 操作产生，不能被失败的写入伪造。
- **实现**：`core/storage/registry.js`（`recordChange` 的幂等分支与 `baseRevision` 校验）、`core/storage/persistence.js`（`idempotent === true` 时不重复落盘）、契约 `contracts/file-change.schema.json`。
- **测试**：`tests/contracts/storage.test.js`（幂等重放、修订冲突、墓碑）、`tests/contracts/persistence.test.js`（跨重启仍幂等）。
- **已知缺口**：幂等与变更日志目前**未接入核心 HTTP 入口**（K2），只在库与测试层成立。上线前必须由模块调用同一契约，不能另写一套写入路径。

### 4.5 密码不落明文

- **要求**：口令只以慢哈希保存；任何响应、日志、错误详情、备份清单不得出现口令或哈希。
- **实现**：`core/identity/passwords.js`（`scrypt`，`N=16384, r=8, p=1`，格式 `scrypt$N$r$p$salt$hash`，校验用 `timingSafeEqual`）；`core/errors.js` 的错误对象只带稳定错误码与固定文案；`core/identity/service.js` 登录失败不区分"用户不存在"与"口令错误"。
- **测试**：`tests/contracts/identity.test.js`（存储中只有 `scrypt$` 前缀；错误响应不含哈希/口令）。
- **已知缺口**：没有登录限流（爆破面）；没有审计日志（无法追溯高风险操作）；秘密材料只以**引用**形式登记（`config.secrets`），未提供静态加密实现。这三项都写在 `docs/guides/security.md` §3，属已知限制。

### 4.6 附加不变量（同样属发布门禁）

| 不变量 | 实现/证据 |
| --- | --- |
| 未安装模块 = 不存在：不 `require`、不挂路由、不启动任务 | `core/registry/host.js`；`tests/integration/core-boot.test.js` 断言 `/api/pages|disk|survey|paper|glim|mail` 全 404 |
| 能力不得虚报：只暴露 `implemented: true` 的能力 | `contracts/module-manifest.schema.json`、`core/registry/host.js` |
| 请求体上限 64 KB（超限 413） | `core/server.js` |
| 秘密只从部署环境注入，配置中只存引用 | `config/config.schema.json` 的 `secrets` 块（`mode`/`reference`/`keys`） |
| 状态文件权限 `0600` + 原子替换写；损坏时拒绝启动而非重建空状态 | `core/storage/persistence.js`、`core/storage/json-store.js` |
| 拒绝隐式换根（数据根变更必须显式确认） | `core/storage/registry.js`、`core/storage/persistence.js`；`tests/contracts/persistence.test.js` |
| 邮箱注册强依赖 Mail（未安装则启动失败，未配置则注册被拒） | `core/config`、`core/identity/service.js`；`tests/integration/core-boot.test.js` |

## 5. 密钥与凭据泄露的处置顺序

1. **先撤销/轮换**受影响的密钥、令牌、证书、口令，再谈删文件。
2. 评估传播范围（是否已推送、已分发、已进入镜像层或备份）。
3. 清理历史（如已推送，按代码托管平台的敏感数据移除流程处理），并记录处置时间线。
4. 复核是否还有同源复用（例如同一 JWT 密钥被当作多种用途的密钥，见 A05 §2.2 的提示）。
5. 在 `CHANGELOG.md` 的"安全"分类下记录（不写密钥内容，只写影响面与修复版本）。

本仓库**不接收**任何真实 `.env`、私钥、证书私钥、数据库转储、Maildir、备份包。发现这类文件进入待发布树时，按发布阻断处理，见 `docs/release-checklist.md` 的制品门禁。

## 6. 范围与非范围

| 在范围内 | 不在范围内 |
| --- | --- |
| 公共核心（身份、会话、权限、配置、模块登记、存储契约） | 部署者的主机、容器编排、反向代理与 TLS 配置 |
| 六个业务模块（落盘后）的鉴权、越权、注入、路径、上传、依赖组件 | 第三方服务（模型 API、SMTP/IMAP 提供商、镜像仓库）自身的漏洞 |
| 官方分发制品（镜像、客户端安装包）的完整性与签名 | 被使用者自行改造后的分支 |
| 文档中与安全相关的错误指引（例如让人关闭校验的步骤） | 未启用 TLS 的裸 HTTP 部署所导致的凭据泄露（部署者责任，见 §7） |

## 7. 已知风险（报告仍欢迎，但按已知问题处理）

| 风险 | 说明 |
| --- | --- |
| 无 TLS 时凭据明文传输 | 核心不终结 TLS；必须由反代提供 HTTPS。部署在公网裸 HTTP 上属配置错误，不是产品漏洞 |
| 登录接口无速率限制 | 已知缺口；建议在反代加限流 |
| 无 CSRF token | 仅依赖 `SameSite=Lax`；高风险部署建议在反代加来源校验 |
| 无安全响应头（CSP/HSTS/X-Frame-Options/X-Content-Type-Options） | 由反代补齐 |
| 身份与存储状态为内存/文件实现 | 重启丢会话、状态未接数据库（K1/K2） |
| AI 生成内容的执行隔离未实现 | 沙盒落地前不得启用 Pages 的代码执行能力 |

## 8. 与发布证明的关系

`tools/verify-release.js` 检查的是**发布物**层面的证明（根 `LICENSE`、第三方声明、禁用制品、迁移台账、地址/密钥扫描），不替代本文件的安全不变量验收。两者都要在 `docs/release-checklist.md` 的 M6 行留证：

```bash
cd source/site/public-release/pagesai
node tools/verify-release.js; echo "exit=$?"              # 发布物证明
node --test tests/contracts/*.test.js tests/integration/*.test.js   # 不变量回归
```

不变量回归失败或 `verify-release.js` 退出码非 0 时，**不得发布**，也不得用"安全问题已知"作为放行理由。
