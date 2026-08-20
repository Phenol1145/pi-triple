# 2026-08-21 v1.4.0 PTL Operator Console 交互体验升级

## 目标

在不回退任何 v1.3 安全/权威边界的前提下，把五页 Operator Console 从「vanilla DOM 拼装」升级为
**Preact + Vite** 组件化应用，并建立可重复的视觉/交互权威验收。

## 非目标

- 不更换服务端路由与 session/bootstrap/CSRF 模型；
- 不引入 `innerHTML` / `dangerouslySetInnerHTML` 渲染运行时值；
- 不向浏览器暴露 PTH/N30 token、上游错误正文或 secret；
- 不改变 N30 只读代理方向与 Memory/Debug/Config 只读语义；
- 不把前端运行时依赖带入生产镜像的 `node_modules`（构建产物静态化）。

## 任务拆解

### T0：构建链路与设计 token
- `packages/framework` 增加 devDependencies：`preact`、`vite`、`@preact/preset-vite`、
  `playwright`、`@playwright/test`（仅 dev，不进入生产镜像）。
- 新增 `packages/framework/web/operator-console-src/`（Preact 源码）与 `vite.config.ts`。
- 输出到 `packages/framework/dist/operator-console/public/`，固定 `index.html` + assets，
  并生成 `asset-manifest.json`（只含白名单文件路径与 hash）。
- 更新 `scripts/copy-framework-web-assets.mjs` 白名单逻辑：Vite 产物按 manifest 复制/校验。
- CSS 设计 token：明/暗主题、间距/圆角/阴影/字体/动效、`prefers-reduced-motion`、
  `:focus-visible`、对比度基线。

### T1：应用壳与导航
- Preact app shell：topbar（品牌、会话状态、主题切换、命令面板入口）、响应式侧栏/底部导航、
  页面懒加载、错误边界、断连横幅。
- 保留 fragment bootstrap 兑换与 `history.replaceState` 清理。
- Ctrl+K 命令面板：五页导航 + 常用动作。

### T2：组件原语
- `ui/`：Button、Badge、Card、Table（排序/筛选/空态）、Tabs、Dialog（原生 `<dialog>`）、
  Toast、Skeleton、EmptyState、ErrorState、Pagination、Progress。
- 统一 API 层：`api.ts`（fetch 封装、401/503 降级、重试）、`dom.ts`（安全文本渲染 helper）。
- 所有运行时值只经 Preact 文本节点渲染；lint 规则禁止 `dangerouslySetInnerHTML`。

### T3–T6：五页重构
- **Overview**：N30 只读代理消费；告警横幅、相对时间、加载骨架、失败重试。
- **Work**：三 mode 表单向导（表单→预览→确认），原生状态轮询与幂等重试提示；
  高风险确认继续要求输入 action label。
- **Debug**：worker 状态卡片、责任区/Working Set chips、生命周期与心跳 freshness。
- **Memory**：搜索/筛选 chips、可排序列、详情抽屉、自动加载更多、revision 时间线。
- **Config**：分组表格、搜索、secret 恒打码说明、roles lineage 展示。
- 响应式：≥1024 侧栏，<1024 可折叠，<768 底部导航；键盘导航完整可达。

### T7：Playwright 权威验收
- `e2e/operator-console.spec.ts`：真实 loopback server + fake PTH 上游。
- 覆盖：从 `/` 完成 bootstrap、五页导航、表单→预览→确认、断网降级、
  secret 零泄漏、focus 可见、移动视口、暗色主题。
- 截图基线 `e2e/screenshots/`（golden），`--update-snapshots` 仅在评审后使用。

### T8：服务端与安全门
- `server-assets.ts` 改为消费 `asset-manifest.json`；缺失/越权文件一律 fail-closed。
- 上游错误脱敏、DTO 适配、CSRF/session 回归保持 v1.3 行为。
- 新增：Preact 源中禁用 `dangerouslySetInnerHTML` 的静态检查脚本。

### T9：v1.4 权威验收
- 新增 `scripts/eval-v14-operator-console-ux.ts`：真实 HTTP 模块图、设计 token 存在性、
  component 覆盖、Playwright 结果引用、secret 泄露探针，双跑字节一致。
- 新增 `scripts/accept-v14.ts`：clean tree、evaluator 双跑、focused（组件测试 + 服务端回归）、
  Playwright、full、lint、build、N29/N30/N33 envelope、skip manifest 冻结。
- focused 与 full 必须与 v1.3 基线一致（351 files / 3053 passed / 9 skips）。

### T10：发布 v1.4.0
- 版本号 1.3.0 → 1.4.0（根包 + 7 子包 + package-lock）。
- `scripts/release.sh --skip-tests --docker --gh --notes=...`（全量已在 T9 绿）。
- 发布报告与 envelope 落 `docs/pth/v14-*`。

## 执行纪律

- 每个任务独立 lane worktree，TDD，commit 后合并 main；
- 重量级测试前声明目的/耗时/通过标准，先跑 `scripts/monitor-docker-resources.sh` 预检；
- full 使用 `--maxWorkers=4`，focused 使用 `--maxWorkers=2`，full 前重启 toolchain；
- N29/N30/N33 envelope 与 skip manifest 不回退。
