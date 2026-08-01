# pit 全量更新 + 会话内更新提示 设计

日期：2026-08-01 · 状态：已确认（brainstorming 完成）

## 背景与问题

Pi-Triple 已发布 GitHub 发行版（`Phenol1145/pi-triple`，Release v0.1.0 + tarball）。但更新机制存在缺口：

1. **更新入口分散且不完整**：`pit update` 只升级 pi SDK（npm 全局包）与扩展/共享层，**Pi-Triple 本体（pit/pth 代码）没有任何更新机制**——发行版用户只能手动下载替换。
2. **提示不一致**：pi 会话内会弹"New version available. Run `pi update`"——对 Pi-Triple 用户，`pi update` 只更新 pi SDK 组件，产品本体/扩展/共享层不更新，照做会困惑。
3. **无版本感知**：`main.ts` 里 `VERSION` 硬编码 `"0.1.0"`，与 `package.json` 双源漂移风险。

## 目标

- `pit update` 成为**全量更新命令**：一次完成 pi SDK + Pi-Triple 本体 + 扩展包 + 共享层。
- **会话内更新提示**：用户日常在 pi TUI 会话内工作，更新可用时通过扩展机制在会话内弹出通知（仿 pi 的提示模式），统一引导到 `pit update`。
- 本体更新走 **GitHub Release 拉包**（用户决策）：查询 releases/latest → 下载 tarball → sha256 校验 → `npm install -g`。
- **完全不修改 pi 源码**（R0，用户决策）：pi 的原生提示保留，pit 提示作为权威引导。

## 架构

### 组件 1：`pit update` 全量更新（4 阶段）

```
pit update                    # 全量（默认全部执行，单阶段失败不中断后续）
pit update --dry-run          # 只检查报告，不下载不安装
pit update --pi-only          # 仅阶段①（保留现有 flag 语义）
pit update --extensions       # 阶段①+③（向后兼容现有行为）
pit update --all              # 全量（兼容现有 flag）
```

| 阶段 | 内容 | 实现 |
|---|---|---|
| ① pi SDK | npm view 比较 → `npm install -g @earendil-works/pi-coding-agent@<ver>` | 现有逻辑（`handleUpdate`）不动 |
| ② Pi-Triple 本体 | GitHub API `repos/Phenol1145/pi-triple/releases/latest` → tag `vX.Y.Z` vs 本地版本 → 下载 asset tarball（HTTPS）→ sha256 校验（GitHub `assets[].digest`）→ `npm install -g <tmp.tgz>` → 提示"重启会话生效" | 新增 |
| ③ 扩展包 | `pi update --extensions`（带 `PI_CODING_AGENT_DIR`） | 现有逻辑不动 |
| ④ 共享层 | `syncBundledExtensions(sharedDir)` | 现有逻辑不动 |

**阶段②细节**：
- 仓库常量 `PIT_REPO = "Phenol1145/pi-triple"`（硬编码常量，将来可挪 config）。
- 本地版本读取：`package.json` 的 `version` 字段（消除 `main.ts` 硬编码 `VERSION` 双源——`main.ts` 改为 import `package.json`）。
- 下载 URL：`https://github.com/<repo>/releases/download/<tag>/pi-triple-<ver>.tgz`（asset 名与 tag 对应）。
- 校验：GitHub API 返回 `assets[].digest`（sha256），下载后比对；不匹配则中止且不安装。
- 安装：`npm install -g <tmp.tgz>`——npm 自动处理 symlink→真实安装转换、bin 链接、依赖树（本机当前全局 pi-triple 是 symlink 指向源码仓库，安装后自动断开联动）。
- 临时文件：`os.tmpdir()` 下载 → 安装后删除。
- 版本比较：无外部依赖手写 `x.y.z` 数字比较（PTL 运行时零依赖，不引入 semver）。
- 阶段②完成后继续③④（旧进程逻辑即可执行），最后提示"pit 本体已更新，重启会话生效"。

### 组件 2：会话内更新提示（扩展机制）

**主通道（会话内）**：新增 `extensions/_shared/version-check.ts`（共享层模块，**不建 index.ts**，遵守 _shared 约束）：
- `checkForUpdates(currentVersion)` → `{ pit?: {version, note?}, piSdk?: {version} }`：
  - GitHub `releases/latest`（本体）→ 与本地版本比较
  - `npm view @earendil-works/pi-coding-agent version`（pi SDK）→ 与 `pi --version` 比较
- 尊重 `PI_OFFLINE` / `PI_SKIP_VERSION_CHECK`（任一设置则跳过）。
- 10s 超时（`AbortSignal.timeout`），异常全吞（网络失败/解析失败 → 静默）。
- **24h 缓存**：`dataDir/version-check.json`（`{checkedAt, pit, piSdk}`），tmp+rename 原子写；缓存有效期内不重复请求（GitHub API 未认证限流 60 req/h；多会话并发时首写者查网络、其余读缓存——原子写保证无竞态损坏）。
- 纯函数 + 注入式 fetch/shell，可单测。

接入点：`pit-communicate/index.ts` factory（每个 pi 会话加载）异步调用（不阻塞启动），有更新则：
- `ctx.ui.notify(\`⚠ pit 更新可用: v${v}（当前 ${cur}）→ 运行 pit update 一次更新全部\`, "warning")`
- pi SDK 有更新同理（文案区分）。

**辅通道（CLI）**：`pit start` / `pi` 命令启动前 stderr 一行同样文案（兜底：无扩展环境的瞬时可见）。

**不提示场景**：`pit update` / `pit help` / `pit --version` / `pit onboard` 自身；离线 env；缓存未过期；无更新。

## 决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | 本体更新源 = GitHub Release 拉包 | 用户选择；与已建 Release 流程闭环 |
| D2 | 安装方式 = `npm install -g <tarball>` | npm 处理 symlink 转换/bin/依赖，原子性最好 |
| D3 | 提示通道 = 扩展会话内 notify（主）+ CLI stderr（辅） | 用户日常在 pi TUI 内；扩展有 `ctx.ui.notify` |
| D4 | pi 完全不修改（R0） | 用户选择；pi 原生提示保留，pit 提示权威引导 |
| D5 | 版本比较手写，零新依赖 | PTL 运行时零依赖现状 |
| D6 | 24h 缓存 + 原子写 | GitHub 限流 60 req/h；多会话并发安全 |
| D7 | VERSION 从 package.json 读取 | 消除双源漂移 |
| D8 | `--dry-run` 只报告 | 预览能力，安装类命令标配 |

## 错误处理

- 阶段②网络失败：报告 ❌ 原因（fetch 失败/超时），不中断后续阶段。
- sha256 不匹配：报告 ❌ 并删除临时文件，不安装。
- `npm install -g` 失败：报告 ❌（含 stderr），后续阶段继续。
- 检查提示（组件 2）：任何异常静默（不打扰用户）。
- 缓存损坏（JSON 解析失败）：视为无缓存，重新检查并覆盖。

## 测试计划

- `test/unit/version-check.test.ts`（新）：注入式 fetch——semver 比较分支、GitHub 响应解析（tag/assets/digest）、npm view 解析、缓存命中/过期/损坏、env 跳过、异常吞掉。
- `test/unit/update-release.test.ts`（新）：阶段② dry-run 报告格式、下载 URL 构造、sha256 比对（好/坏 digest）、版本比较函数。
- 现有 `admin` 相关测试回归（pi SDK 检查逻辑不动）。
- 手动验证清单（发行版流程）：真实 `pit update --dry-run` → 真实发布 v0.1.1 后 `pit update` 端到端（下载→校验→安装→新会话生效）、会话内 notify 显示。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| tarball 附件缺失/改名（asset 名与 tag 不匹配） | API 按 `assets[].name` 匹配 `pi-triple-<ver>.tgz`，找不到则报错提示发布问题 |
| GitHub API 限流（60 req/h） | 24h 缓存；检查失败静默 |
| `npm install -g` 权限问题（EACCES） | 报错提示 `sudo` 或 nvm 方案 |
| pi 升级后扩展 API 变化（notify 签名） | notify 是稳定 API；失败静默 |
| 本机 symlink 安装被替换为真实安装后，源码开发流程变化 | 预期行为（用户决策）；源码开发仍走 git pull + build |
