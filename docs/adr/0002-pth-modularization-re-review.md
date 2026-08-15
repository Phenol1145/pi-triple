# PTH 模块化迁移计划重评审

背景：`docs/superpowers/plans/` 下的五份模块化迁移计划（
`2026-08-15-pth-modularization-program.md`、
`2026-08-15-pth-contracts-boundaries.md`、
`2026-08-15-pth-tasking-runner.md`、
`2026-08-15-pth-execution-isolation.md`、
`2026-08-15-pth-catalog-profiles.md`）
自创建起标记为 Reference-only。2026-08-15 同日，ADR 0001 重新界定 PTH 与 PTL 范围
（解除前后端关系，PTL 通过 PTH CLI 调用 PTH），且用户裁决 `split-design.md`
（单仓 workspace 包；pth-memory / pth-sandbox 拆分；内核契约留在 pth-sandbox 内）。
这两项新范围输入与旧计划的核心假设冲突，需要重评审并建立新的执行入口。

现状盘点（2026-08-15）确认：pth-memory / pth-sandbox 拆分与 storage 归并已落地；
sandbox P0-1~P0-5 安全整改已落地；但旧计划的主体步骤未执行——
`packages/pth-contracts` 不存在，`TaskLease`/`ExecutionGrant`/`ExecutionPort` 等协议不存在，
`tasks` 表无 lease 列，`TaskLoop` 仍一体执行，gateway 仍直连 `KernelRuntime.pool/dataWorld`，
无 `tasking/runner/execution/catalog/bootstrap` 模块目录，`ExtRegistry` 仍保留虚构激活语义，
Control/Standard/Full 三 Profile 未实现。

决定（2026-08-15）：

- 旧五份计划从 Reference-only 转为**历史参考**；不再按其中任何 checkbox 执行。
- 新的唯一执行入口为 `docs/superpowers/plans/2026-08-15-pth-modularization-v2.md`。
- v2 未列出的旧步骤一律**退役**，包括：新建 `@away_from/pth-contracts` 独立 workspace 包、
  把内核 interpreter 契约迁出 `pth-sandbox`、Control/Standard/Full 三产品 Profile 发布、
  以 PTL 前端/HTTP 桥定位为前提的 PTL bridge 兼容改造步骤。
- 旧计划中仍然有效的工程约束（每阶段全量 vitest + lint + build 绿线、独立提交、TDD、
  兼容 facade、import boundary 检查）由 v2 继承并继续执行。
- 后续模块化范围变更必须先更新 v2 或另立新计划；旧五份文件不再接收修订。

**Consequences**：

- 测试/构建不变量：v2 每个阶段必须通过全量 `npx vitest run`、`npm run lint`、`npm run build`
  （基线 204 文件 / 1716 用例不回退），并新增 `npm run check:pth-boundaries` 作为边界检查门禁。
- 旧文档保留策略：五份旧计划文件保留在仓库中，计划完成后在文件顶部添加 Retirement notice
  （标注被 v2 取代、保留历史）；不删除文件、不改写历史正文。
- 模块边界以 `contracts / tasking / runner / execution / catalog / bootstrap / gateway` 为整理目标；
  `packages/pth-sandbox` 继续拥有内核 interpreter 契约，不新建 `packages/pth-contracts`。
- 已落地的 sandbox P0-1~P0-5 安全整改只做回归保护，不在 v2 中重复实现；
  未完成的 P1-1~P1-6（cancel-ack-release、reset await、输出上限、进程组收割、readiness、部署渲染）
  转入 v2 P2 继续。
- PTL 前端、PTH 专属前端、无容器版本、进一步分仓、三产品 Profile 发布均不在 v2 内，
  由 ADR 0001 后续方向或新的独立 ADR 管理。
