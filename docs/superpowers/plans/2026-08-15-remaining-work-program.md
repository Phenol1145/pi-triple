# 剩余工作总控计划（2026-08-15 盘点）

> 本计划把仓库中**尚未执行**的方案按风险与依赖顺序收敛为一条可执行主线。
> 依据：根 `TODO.md` · `docs/pth/backlog-priority.md` · 两个拆分包的 TODO · `docs/superpowers/specs/` 状态索引 · `docs/superpowers/plans/` 中的参考计划 · 工作树中未提交的部署改动与 sandbox 安全审计。
>
> 注意：历史计划文件的 checkbox 不反映真实进度（多项已完成但未勾选），本计划以 2026-08-15 代码状态为准。

**Goal:** 在不破坏当前绿线（195 文件 / 1645 测试、lint、build）的前提下，先闭合安全与在途改动，再按 backlog 顺序消化核心账本，最后对两个"未执行的架构级方案"（模块化迁移、分仓）做新范围下的裁决。

## 当前基线（2026-08-15 实测）

- `npm test`：195 文件 / 1645 测试全绿
- `npm run lint` / `npm run build`：通过
- 已完成：PTH 记忆域/沙箱域拆分、Plan C（mailbox/dev-container）拆分收尾、PTH/PTL 范围重界定与文档同步
- 参考计划状态：模块化迁移 5 份计划全部 Reference-only，未执行

## 阶段总表

| 阶段 | 内容 | 前置 | 退出门禁 |
|---|---|---|---|
| P0 | 在途改动收口（deploy 改动 + 审计文档纳管） | 无 | 工作树只剩本计划允许的改动；审计文档有明确归属 |
| P1 | Sandbox P0 安全整改（4 项阻断项） | P0 | 4 项 P0 全部有负向测试证据；干净环境可构建 sandbox 镜像 |
| P2 | 拆分收尾（memory 测试迁移 + 包 TODO 勾平 + 依赖方向验证） | P1 | 两个包 TODO 与磁盘状态一致；madge 无反向依赖 |
| P3 | 核心账本（按 backlog-priority 序列） | P2 | 根 TODO 核心剩余项清空或显式延期 |
| P4 | 架构裁决：模块化迁移、分仓、PTH 专属前端/无容器版本 | P3 | 每个方案都有 ADR：执行 / 修订 / 退役 |

---

## P0：在途改动收口

> P0 裁决（2026-08-15）：`pth.deployment.json` 维持"四服务生产拓扑的事实源"（dev/jupyter 留在 compose）；postgres 内存限额 512M→4G，修复 `shared_buffers=2GB` 起不来的矛盾。

- [x] 裁决并提交（或明确还原）`deploy/Dockerfile.dev` 的 root 运行说明注释 → `17a98a5`
- [x] 裁决并提交（或明确还原）`deploy/docker-compose.yaml` 的 `dev-home` 卷清理 → `6dbea6c`（同提交修正 postgres 限额）
- [x] 裁决 `deploy/pth.deployment.json` 的 postgres/redis 调优、env 补全、dev/jupyter 服务——与 compose 逐项核对后单独提交 → `2f97600`
- [x] 纳管 `docs/superpowers/explorations/2026-08-15-pth-sandbox-security-audit.md`（当前未跟踪）——它是 P1 的输入，须先入库 → `4b86787`
- [x] `git status` 只剩 P1+ 明确允许的改动

## P1：Sandbox P0 安全整改

> 输入：`docs/superpowers/explorations/2026-08-15-pth-sandbox-security-audit.md`。
> 设计参考：`docs/superpowers/plans/2026-08-15-pth-execution-isolation.md`（Reference-only——先按 PTH 新范围评审其任务切片，再转为可执行任务，不得原样照搬）。

- [x] **P0-1 默认密钥与公开入口**（`e0df40d` + `e89ae44`）：移除 `sandbox-dev-secret` 默认值（compose `:?` 强校验）；`/api/v1/kernel/memory-bridge` 取消 auth 豁免，tenant/space 只能来自 Redis token 声明，body 自报 space 一律 400；sandbox 上游改用独立 `PTH_MEMORY_BRIDGE_TOKEN`，缺失 fail-closed 503
- [ ] **P0-2 工作负载凭据暴露**：`/exec`、Python/Bash REPL 不传完整 `process.env`，改为严格 allowlist；短期、单用途、绑定任务/租户的 capability；工作负载与 API 不同 UID，应用根只读
- [ ] **P0-3 工作区租户隔离**：每任务/租户只挂载对应工作区子树（独立容器或命名挂载），`validateCwd` 不作为授权边界；补充跨租户读写负向测试
- [ ] **P0-4 kernel lease**：`acquire` 返回高熵一次性 lease（校验 lease/tenant/generation/in-flight）；TTL 到期原子失效并回收，禁止仅置 idle；补可预测 ID 重放/过期/并发执行负向测试
- [ ] 干净环境构建 sandbox 镜像（不依赖本地 `dist`），compose 全拓扑启动 + health 通过

## P2：拆分收尾

- [ ] 迁移 `test/pth-kernel-execution/memory-policy.test.ts` → `packages/pth-memory/test/`
- [ ] 迁移 `test/pth-kernel-storage/memory-store-pg.test.ts` → `packages/pth-memory/test/`
- [ ] 勾平 `packages/pth-memory/TODO.md` 与 `packages/pth-sandbox/TODO.md` 的"拆分后立即要做"（sandbox 侧实际已完成，补勾即可）
- [ ] 用 madge（或等价扫描）验证：`pth-memory`、`pth-sandbox` 零 `src/pth` 反向依赖
- [ ] 全量测试 + lint + build 绿线复核

## P3：核心账本（顺序 = `docs/pth/backlog-priority.md` 推荐序列）

### P3.1 知识层根基
- [ ] B4 / N2 Phase 2：skills.get 真实接线 + Level 0 清单 / Level 1 全文两级检索
- [ ] B4 / N2 Phase 3：memory-keeper 专项维护面 + 不可变语义 + controller:adversarial 审核
- [ ] B4 / N2 Phase 4：SKILL.md → skill 条目映射定稿

### P3.2 观测与路径还原（可合批：共用轨迹数据）
- [ ] D1：护栏进 scorecard 观测
- [ ] E1：N13 思考路径图重建器

### P3.3 机制链
- [ ] B3：N4 生态转化 pipeline（记忆侧 skill 条目化）
- [ ] B5：N1b 百科写入矛盾检测
- [ ] D3：T9 PTL 侧交接 flow + 提交指南（PTH CLI 为新规范接口）
- [ ] D5：失败任务回收机制（软终止/警告闭合任务的转派/归档/重试）

### P3.4 并行/顺手批次
- [ ] B7：N5 资源环采集
- [ ] C1：N10 剩余 21 子任务持续派发
- [ ] D4：role-doc 文案三要素对齐
- [ ] B1：N7 归档定期 trigger 接线

### P3.5 LLM→工具调用链审计遗留（根 TODO）
- [ ] HIGH：ts-interpreter 尾表达式/autoExport 插入 noise-aware（字符串含 `return`/`;` 被切坏）
- [ ] MEDIUM：非 ASP 模式工具 schema 与执行面同源；ASP 内联工具统一 try/catch 错误回填；surface 解构默认值/模板插值/`as` 断言漏检；ext.syncIndex / manage.scheme.publish 校验
- [ ] LOW：别名门控提前 · toolsDescription done 去重 · 命名一致性

### P3.6 调试闭环
- [ ] debug-case-writer 角色（parent=tester）：最小复现 + 回归测试 + 边界用例；接 controller 批准/developer 修复后派发

## P4：架构级裁决（每个方案产出一个 ADR）

- [ ] **模块化迁移计划重评审**：以 PTH = 自耦 NL 解释器 / PTL = 多环境平台的新范围为输入，逐模块核验 Reference-only 五计划中 tasking/runner/execution/catalog/session/knowledge 的边界是否仍然成立；输出：转可执行新计划 / 修订 / 退役
- [ ] **PTL/PTH 分仓裁决**：按新范围重新评估 `2026-08-08-repo-split-design.md`（5 新仓目标）——执行、修订为包级拆分，或明确维持单仓；涉及发布脚本与 Docker 构建链
- [ ] **PTH 专属前端与无容器版本**：承接 ADR-0001 的后续方向，产出范围草案（前端形态、无容器运行时边界、与 PTH CLI 的关系）

## 完成标准

- Sandbox 4 项 P0 全部闭合且有负向测试证据，干净构建可用
- 根 `TODO.md` 与两个包 TODO 只保留"显式延期"项，其余清空或勾平
- `docs/pth/backlog-priority.md` 的 P3 序列全部落地或标注延期原因
- 模块化迁移、分仓、PTH 专属前端/无容器版本三个方案各有一份 ADR 定调
- 全程保持：全量测试、lint、build 绿线；每阶段独立提交，不混入无关改动
