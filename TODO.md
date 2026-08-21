# TODO（2026-08-19 对齐真实进度）

> 未执行方案的统一入口与执行顺序见 [剩余工作总控计划](./docs/superpowers/plans/2026-08-15-remaining-work-program.md)。

## v1.4.0 / Operator Console 交互体验升级（Preact + Vite + Playwright）

> 计划：[v1.4 PTL Operator Console UX](./docs/superpowers/plans/2026-08-21-v14-operator-console-ux.md)。

- [x] **T0 构建链路 + 设计 token**：Preact/Vite/Playwright devDeps；dist 静态产物 + asset-manifest；
- [x] **T1 应用壳**：topbar/sidebar/响应式导航/命令面板/错误边界/断连横幅；
- [x] **T2 组件原语**：Button/Card/Table/Dialog/Toast/Skeleton/Empty/Error/Pagination；
- [x] **T3–T6 五页重构**：Overview/Work/Debug/Memory/Config；
- [x] **T7 Playwright 视觉与交互验收**：bootstrap/五页/断网/secret/focus/移动端/暗色主题；
- [x] **T8 服务端资产 manifest 与安全门**：无 innerHTML、secret 零泄漏、DTO/CSRF 不回退；
- [x] **T9 v1.4 权威验收**：eval/accept、N29/N30/N33 不回退、full 351 文件 3053+9 基线；
- [x] **T10 发布 v1.4.0**：版本 bump、release.sh、报告/envelope。

## v1.5 / 产品形态与基础重构（已确认，待实施）

> 产品形态基线：[Pi-Triple 产品形态](./product-shape.md)。
> 下一迭代：基础重构优先；PTH 完整操作台「先搬迁再扩展」；服务端权限模型留白。

- [x] **R0 产品预期形态确认**：已对齐定位/入口/双引擎/交互策略/部署/迁移路径；
- [x] **B1 基础重构**：协议/边界/文档固化（API v1、OpenAPI、契约测试、product-boundaries）`5fa256f`；
- [x] **B2 PTH 侧 Web/CLI 边界**：PTH 操作 CLI/Web 归 PTH（`pth web`），PTL 只保留便捷调用；`64effcf`；
- [x] **B3 现有 Console 先搬迁再扩展**：operator-console 迁至 `@away_from/pth-console`，五页能力零回退（lint/build/Playwright 4·4/full 353 文件 3060 通过 9 跳过）；`64effcf`；
- [x] **R1 ContainerRuntimeAdapter 接口**：`id/probe/version/socket/features` + `list/inspect/stats` 三个只读方法；`f6a18f3`；
- [x] **R2 运行时选择协议**：`PI_CONTAINER_RUNTIME` 显式优先 → lock socket 白名单自动 probe → 多可用 fail-closed；`f6a18f3`；
- [x] **R3 container-runtime-lock.json**：允许 runtime、`*|>=|>|<=|<|=` 版本约束、GET probe/version 定义；`f6a18f3`；
- [x] **L1 PTH compose 启动器**：`pth init/up/down/status/logs`；依赖顺序起栈 + 自动种 operator token + health/version 验证；`0588e5d`；
- [x] **D1 项目整理第一阶段**：docs 分类清单 + `deps/host/container/config + dual` 代码运行时规划（先清单后搬迁，暂不物理移动）；链接校验入 lint；`4501618`；
- [x] **S2 Phase 0 交互收敛**：原 ptl hub 的 PTH 命令全部迁入 pth CLI（program/request/respond/observe/debug/bench/job/console/lineage/trigger/kernel）；ptl hub 退役，ptl stack/program dev 落位；framework 不再依赖 pth-console；`a3c3c28`；
- [x] **S1 PTL/PTH 三仓拆分设计**：ptl/pth/deps + archive；`ptl hub` 退役、PTH 交互面收敛 pth-console；filter-repo 路径清单与命令迁移映射（未执行拆仓）；`c361c79`；
- [ ] **R4 Docker/OrbStack adapter 归一化**：当前 docker-api.js 改造为契约实现；
- [ ] **R5 Podman adapter 验证抽象**：作为第二实现跑同一 contract 测试；
- [ ] **R6 /health 与日志暴露**：runtime id/version/socket/采集能力；
- [ ] **R7 协议文档**：`docs/pth/container-runtime-adapter-protocol.md`；
- [ ] **R8 权威验收**：contract 测试、focused/full 不回退。

## v1.3.0 / N32 专业计算角色 + 可执行教程 + Web 运行视图

> 目标：四个专业计算 Role（Assembly / Computational Chemistry / Lean 4 / Symbolic Mathematics）
> 与一个 technical-educator Role 共用五类记忆和统一运行核心；以 Jupyter Notebook 交付可执行教程；
> 同版本完成 N30 O0–O4 只读运行观测面与 N33 五页 PTL Operator Console。设计：
> [N32 v1.3 专业计算设计](./docs/pth/n32-v13-professional-computing-design.md)。
>
> 实施拆为三份独立计划：
> [专业计算与 Notebook](./docs/superpowers/plans/2026-08-19-v13-professional-computing.md)；
> [N30 运行观测台](./docs/superpowers/plans/2026-08-19-n30-runtime-observatory.md)；
> [N33 PTL 五页操作台](./docs/superpowers/plans/2026-08-19-v13-ptl-operator-console.md)。
> N31 统一 Workflow DAG 留到 2.0，本版本只验证已有设施的真实可用性。

- [x] **M0 三种 Work Mode**：新增服务端盖章的 `intake/optimize/run` 与 `WorkEnvelope`；
  普通任务默认 run，IntakeRun 固定 intake，优化任务固定 optimize；委派继承，跨模式只能新建工作项；
  Trigger/lease/outbox/N30 保持正交。
- [x] **P0 五类记忆**：`MemoryType` 增加 `index`；建立稳定版本索引、现有记忆集合索引、
  精确 locator 与受同一授权/预算约束的惰性正文读取。
- [x] **P1 共享专业运行契约**：冻结 `ProfessionalRuntimeAdapter`、作业结果、版本锁、
  resource/artifact/trace 约束；新增五个默认 0 副本 Role Definition。
- [x] **P2 Assembly + Lean 4**：真实三 ISA 非平凡例程；真实 Lean 4/Lake/Mathlib 工程，
  无 `sorry/admit`、干净构建通过。
- [x] **P3 Wolfram + Computational Chemistry**：Wolfram 许可证与假设/数值复核；
  Psi4 分子任务；Quantum ESPRESSO 周期 SCF；资源、收敛和版本全部结构化。
- [x] **P4 Jupyter 教程**：technical-educator 把四类已验证作业转为 Notebook；
  干净 kernel Run All；相应专业 Role 复核；无隐藏状态/凭据/宿主路径。
- [x] **T10 权威门**：`scripts/v13-authority-gates.ts`（12 项 sabotage 单点翻转）+
  `scripts/eval-v13-professional-computing.ts`（双跑字节一致、精确分母）+
  `scripts/accept-v13.ts`（focused/full/lint/build/N29/N30/N33 绑定）+
  `test/pth-composition/v13-professional-computing.test.ts`（共享记忆/四 Replica/双 handoff）；
  与 P4 lane 合并后进入 P7。
- [x] **P5 N30 O0–O4 只读观测面**：完成本机管理员甘特图、CPU/RSS/Heap/Network 折线、
  PTH 时间线、WorkMode 筛选、SSE reconcile、freshness 和告警验收；保持独立只读，O5 后置。
- [x] **P6 N33 PTL Operator Console**：完成总览/运行/调试/记忆/配置五页；浏览器壳与
  Docker/PTH 权限分离；run/intake/optimize 只经登记原生动作；后三页只读；配置 secret 恒定打码；
  不引入统一 Workflow 或 PTH human-interface worker。
- [x] **P7 v1.3 权威验收**：真实工具链全部执行，N29 门禁不回退，N30/N33 envelope 均绿，
  浏览器安全/时效/可访问性验收通过，全量/lint/build 绿，
  skip manifest 无新增，acceptance envelope 绑定 clean commit。

执行顺序：**M0 → P0 → P1 → P2 → P3/P4**；P5 可并行；P6 先依赖 P5 的读面再接控制面；
最终 M0/P0–P6 一起进入 P7。

## N33 PTL 五页 Operator Console（2026-08-19 已确认）

> 目标：PTL 提供本机人类操作台，固定五页为总览、运行、调试、记忆、配置。N30 保持只读
> Observation Plane；只有运行页可经预览/确认调用登记的 PTH 原生动作。设计：
> [N33 v1.3 PTL 五页操作台](./docs/pth/n33-v13-ptl-operator-console-design.md)。
> 实施计划：[2026-08-19 v1.3 PTL Operator Console](./docs/superpowers/plans/2026-08-19-v13-ptl-operator-console.md)。

- [ ] **C0 安全壳**：loopback-only、单次 bootstrap、HttpOnly cookie、CSRF、五页导航、静态资源打包；
  浏览器不接触 PTH/N30 token、Docker Socket 或软件凭据。
- [ ] **C1 总览**：同源只读代理 N30 `embed=1`；N30 故障只降级总览，不影响其余页面。
- [ ] **C2 只读面**：新增有界 Worker/Memory/Config/Role 投影；调试、记忆、配置均无写路由；
  记忆饼图同时以条目数和 UTF-8 bytes 为分母，近期修改取十条 revision event。
- [ ] **C3 原生命令**：run/task.publish、intake/subscription.create+run.trigger、
  optimize/suggestion.apply 依次接入；每次 submit 必须匹配未过期单次 preview digest 和 idempotency key。
- [ ] **C4 权威验收**：五页、三 mode、freshness、跨租户、XSS、CSRF、stale/replay、secret/token leak、
  真浏览器可访问性与故障隔离全部进入 commit-bound envelope。

实施顺序：**C0 → C1 → C2 → C3 → C4**。C2 可按 Debug/Memory/Config 三页并行；
配置编辑、Worker 控制、浏览器私钥、远程多用户和 2.0 Workflow 编辑器均后置。

## N30 统一运行观测台（C 方案——分层待办，2026-08-19 已确认布局）

> 目标：用共享时间轴把“系统正在执行什么”与“消耗了多少资源”关联起来。主视图采用
> Job → Task → Intake / Optimize / Professional Stage 分层甘特图，CPU / RSS / Heap / Network 使用同步折线图；
> 点击阶段后联动展示 Worker、Role、Batch、Trace、事件与所选窗口资源统计。
> 设计稿：[N30 统一运行观测台设计](./docs/pth/n30-runtime-observatory-design.md)。
>
> 边界：先做本机管理员专用，不公开 Docker Socket 或 PTH 管理令牌；租户自助访问与
> 长期历史存储后置。现有 `deploy/docker-monitor` 是 UI/容器采样适配器，PTH Gateway
> 只新增 tenant-scoped、read-only 的观测端口，不把观测状态写回任务或摄入状态机。

- [ ] **O0 设计与安全契约**：冻结 `RuntimeInterval`、`ResourceSample`、`RuntimeDelta`、
  `RuntimeSnapshot` DTO；定义统一 ID、父子关系、时间语义、Freshness Contract、状态颜色、采样精度与降级行为；
  明确 loopback-only、server-side token、tenant 由认证上下文盖章、Docker Socket 不出服务端。
  - 完成条件：设计稿、威胁边界与 DTO 合同通过评审；旧 `/metrics`、kernel status/events
    行为保持兼容。
- [ ] **O1 本机服务观测 MVP**：扩展 `deploy/docker-monitor`，补容器启动/存活甘特图，
  以服务端 ring buffer 保留最近 1 小时 CPU、RSS、Heap/limit、Network 样本；修正根
  `monitor` 脚本的迁移后路径；前端实现时间范围切换、暂停实时流与断线重连。
  - 完成条件：无 PTH 数据也可独立运行；8 小时采样内存有硬上限；Docker 不可用时页面
    明确降级而非伪造零值；默认只监听 loopback。
- [ ] **O2 PTH 执行时间线**：新增只读 `RuntimeObservationFacade` 与
  `/api/v1/observe/timeline`；从 durable Task / Job / Intake Run / Attempt 数据投影
  Job → Task → Stage 区间，运行中记录以 `endAt=null` 表示；Worker、Role、Batch、Trace
  作为关联字段，不复制领域状态机。
  - 完成条件：completed / running / waiting / retry / failed 区间可复现；tenant/space
    越权查询为零；分页、时间窗和最大返回量 fail-closed；时间线不依赖 ActivityHub 内存历史。
- [ ] **O3 统一联动与实时增量**：Docker Monitor 作为本机观测聚合适配器，服务端合并
  Docker 样本与 PTH 只读快照/事件；浏览器只连接一个 `/events` SSE。点击甘特条时，
  资源图按同一时间窗高亮，并展示 Worker、重试、错误、usage 与相关事件。
  - 完成条件：push 降低延迟、5 秒 durable snapshot reconcile 修复丢失；初始 snapshot + 增量 upsert 不重不漏；SSE 重连后可恢复当前状态；时钟偏差、
    缺失资源样本、PTH 暂不可用均有显式 UI 状态；甘特与折线时间轴误差不超过一个采样周期。
- [ ] **O4 告警与运行验收**：加入 heartbeat stale/dead、队列积压、CPU/RSS 阈值、任务超时
  与摄入阶段停滞告警；告警仅为观测结果，不直接触发控制动作。补真实 Docker + PTH
  组合测试、长时间采样、资源上限、SSE 重放和浏览器可访问性验收。
  - 完成条件：资源/activity/timeline P95 分别 ≤5s/2s/10s 且分母非零；每类告警均有正/负探针；故障注入能定位到具体 Task/Worker/Batch；看板异常
    不影响 PTH 执行；feature 默认关闭且可独立回滚。
- [ ] **O5 租户访问与持久历史（后置）**：在本机管理员 MVP 稳定后，再增加稳定 principal、
  tenant/space 授权、审计和租户视图；资源历史接 Prometheus-compatible adapter 或等价
  时序后端，浏览器与 Docker Monitor 不作为长期事实源。
  - 完成条件：跨租户可见性矩阵全绿；token 不进入浏览器存储/日志；历史查询有 retention、
    downsampling 和成本上限；没有后端时仍保留 O1–O4 的本机模式。

实施顺序：**O0 → O1 → O2 → O3 → O4**；O5 单独立项。O1 可独立交付，O2 不依赖
前端，O3 只组合已经验收的两个读面。任何阶段完成都不得外推为 O5 已具备。

## N14 实施批次（2026-08-18 开工——设计 docs/pth/n14-sensor-controller-four-dims.md §6）
- [x] **P0 契约**：tool-reg 条目格式 + `__tool_spec__` 校验（`packages/pth-memory/src/tool-reg.ts`）
  + memory-policy PROMPT_KINDS 增补 tool-reg（prompt 层只读防伪造注册）
  + 存量登记器（`src/pth/tasking/tool-reg-builtin.ts`——33 件 builtin 条目生成 + 双写对账
  + `scripts/seed-tool-reg.ts` 幂等 seed/--check）+ 对账钉测试 20 例
  （数量订正：PTC_TOOL_DEFS 实为 33 条=AGENT_TOOLS 27 键含 done + ASP-only 6；设计文档 35 为 B6 退役前旧数）
- [x] **P1 观测**：sensor 三新点位（sensor:tool-face / sensor:tool-single / sensor:rule——builtin-roles + prompt）
  + guardrails 计数进 scorecard（N12 二期观测面随同落）
  （已落 `d230f96`：GOVERNANCE_ROLES +3；obs.guards——scorecard.guards 出 obs，按护栏分账 + killRatio + byRole）
- [x] **P2 通道执行缝**：注册表驱动动态工具面（快照版本化 + 预算守卫 24 件/角色）+ program 执行器（ts 核）
  + agent 态接穿透 runChild + `PTH_TOOL_WRITE_POLICY` 配置
  （已落 `008f85c`：`kernel/execution/tool-registry.ts` 快照/可见性/预算守卫 + agent-loop 三态分发
  + PTH_TOOL_FACE_BUDGET；P2 自决：注册面 ASP 空间无关 / 预算只裁注册面 / program 继承 worker caps）
- [x] **P3 调节与 SOP**：controller 三新点位（tool-face/tool-single/rule）+ manage.tool.* 调节面
  + 四条 SOP 固化（skill:opt-tool-face/tool-single/memory/rule）+ 晋升管线首跑（2 个真实 tool-function 晋升验证）
  （2026-08-18 收尾批：GOVERNANCE_ROLES 13→16；manage.tool.list/register/revise（预算守卫 + PTH_TOOL_WRITE_POLICY 双策略）
  + tool-proposal 治理流（propose → adversarial review → 监督批准 → 注册）+ tool-proposal-review trigger 事件驱动派发
  + SEED_OPT_SOPS ×4 注入 + gateway approve 同流 + 首跑脚本 `scripts/n14-p3-tool-promotion.ts`
  ——真实晋升 `fn-wx7wk7→tool:toolfn_anchor_stats`、`fn-v2u2if→tool:toolfn_anchors_of`，ts 核执行 + 快照可见验证通过）

## 批 A：差距 7——obs.container（cgroup 容器级观测源）✅
- [x] obs.ts 加 obs.container（cpu.max/memory.current/pids/usage——容器 cgroup 只读）
- [x] 测试（白名单模板 + 容错——非容器环境降级）
- [x] 容器验证（sandbox/pi-platform 容器内跑通）

## 批 B：差距 11——探索核候选列表（角色定义语言 A/B 并存）✅
- [x] WorkerRole 加 exploreKernels 字段（候选列表——如 ["python","bash"]）
- [x] 角色定义挂候选（reviewer 等）
- [x] agent-loop/task-loop 接线（按候选语言建探索核——A/B 并存 + 探索空间按语言划分）
- [x] 测试（候选解析/回退默认/维度生效）

## 批 C：差距 12——controller/sensor 任务源（trigger 生成观测/控制任务）✅
- [x] trigger-engine 定时生成机制（sensor 观测任务 / controller 控制任务）
- [x] 对接 optimizer 窗口/scorecard
- [x] 测试（定时触发/角色路由/防风暴）

## 批 D：待决点可实现部分 ✅
- [x] 振荡防护：死区（小偏差不动作）+ 增益上限 + 回滚记录
- [x] deopt 语义：记入 maxAttempts 后人工确认（自动回滚基线 + 记录）
- [x] 子 worker 创建入口：refiner 分化提案 → controller:worker-opt 批准通道（对接 lineage approve）

## 批 E：扩展库补充（toolstore/extensions 实用扩展）✅
- [x] git 助手扩展（repo status/diff/log——developer 高频）
- [x] web 检索扩展（http get 文档/页面检索）
- [x] sql 只读查询扩展（白名单表）
- [x] 测试 + 容器装载验证

## 多平台汇编 dev 核（2026-08-12 提议）✅ 已完成（2026-08-12 当日闭环）
> 本段此前未勾选——已按提交记录对齐：`597cb26`（生产核 + 探索核）、`e4f97a5`（Jupyter 适配器）。

- [x] 派发 planner：汇编核设计（生产核 qemu 工具链 + 探索核模拟器 + dev 空间接线——planner 任务 `e899a08b`，监督审阅批准）
- [x] 审设计 + 裁决
- [x] 派发 developer：实现（`597cb26`——asm-kernel 951 行 + rv32i-sim 704 行 + 21 测试 + 接线补丁）
- [x] 派发 tester：多平台验证 + acceptor 验收（x86_64 / riscv64 交叉 qemu + aarch64 原生直跑，全链路 exit=0）
- [x] 容器工具链安装（qemu-user + binutils-x86_64/riscv64——Dockerfile 构建期安装，运行时无外网实测）+ 验证
- [x] 追加：jupyter-asm 探索核适配器（`e4f97a5`——ipykernel Kernel 子类 + node bridge + kernelspec；jupyter_client 8.9 全协议验证）

## 8/14–8/15 概念账本落地批次（对照 docs/pth/backlog-priority.md）
- [x] A1 PTC 契约类型化 + Seam 解耦（Phase 1–3；遗留：能力索引生成器尚待切掉 prompt-docs 手写散文）
- [x] A2 双 storage 层归并（Phase 1–5）
- [x] B6 空间-角色绑定治理（Phase 1–3）
- [x] B2 复测一等化（独立复测任务 + 证据三通道）
- [x] N12 护栏统一抽象一期（五计数器 → guardrails 注册表 + `PTH_GUARD_*`）
- [x] 概念设计裁决收口：T1–T10（8/14）· W1–W7（8/15）全部裁决
- [x] 角色谱系定型（8/15）：origin + 13 叶子四族（executor/explorer/governor/researcher）；sensor/controller 升为真实类型
- [x] B4-2 已裁 A（8/15）：首批 3 条 seed（developer/scout/memory-keeper）；B4-3 已裁 C（两级检索）
- [x] D2 已裁并落地（8/15 custom）：不豁免治理族——negative-loop 阈值 5→15（`PTH_GUARD_NEGATIVE_LIMIT`）
- [x] B4 / N2 Phase 1（8/15）：四段式 skill 格式（`skill-format.ts`）+ 3 条角色 SOP 种子注入（developer/scout/memory-keeper）
- [x] 模块拆分（8/15）：`packages/pth-memory`（记忆域）· `packages/pth-sandbox`（沙箱域含内核契约/运行时）——见 docs/pth/split-design.md
- [x] B4 / N2 Phase 2–4 → **归位 packages/pth-memory/TODO.md**
- [x] 核心剩余账本：C1 ✅（N10 v3 28/28 完成）· D4 ✅ · N10 ✅ · N12 二期（D1 已落：护栏进 scorecard）
- [x] 记忆侧账本（B3/B5/N1b/N7）→ **归位 packages/pth-memory/TODO.md**
- [x] 沙箱侧账本（B7/N5 资源环等）→ **归位 packages/pth-sandbox/TODO.md**
- [x] 逐包评估（D 方案，8/15）：E2/N11 保留为**设计储备不排期**；B7/N5 → sandbox TODO；B3/B5/N1b/N7 + B4 Phase 2–4 → memory TODO；主 TODO 不再承载

## 调试用例 worker（2026-08-13 用户提议——自修正闭环的验证环节）✅（2026-08-15 P3.6 落）
- 角色：debug-case-writer（parent=tester 分化——测试族内特化；tags debug-case/regression-case/boundary-case）
- 职责：给定 bug 报告/复现步骤/修复 diff——产出 ① 最小复现用例（触发 bug 的条件序列）
  ② 回归测试（vitest——防复发）③ 边界用例（相关边界的探索）
- 在自修正闭环的位置：sensor 检测 → developer 定位/修复 → 【debug-case-writer 生成用例】
  → 全量验证 → 部署提案
- 触发：controller 裁决批准修复后（`manage.fix.approve` 治理面通道）；developer 修复完成自动派发
  （task-loop 完成点——`payload.debugCases="off"` 可关）
- 验收：生成的用例能复现修复前 bug（修复前 FAIL）+ 修复后 PASS（done.result 契约 repro/regression/boundary/verification）

## LLM→工具调用→执行核 链路筛查遗留（2026-08-15，报告见 docs/superpowers/explorations/2026-08-15-llm-call-chain-audit.md）
**核心侧（留主 TODO）**：
- [x] HIGH：ts-interpreter 尾表达式/autoExport 插入改为 noise-aware（`maskNonCode` 等长掩码——字符串/模板/注释中 return/; 不再切坏插入点与尾表达式）
- [x] MEDIUM：非 ASP 模式工具 schema 与执行面同源（剔除 ASP-only 声明）
- [x] MEDIUM：ASP 内联工具（asp_index/memory_index/cache_*）统一进 try/catch 错误回填
- [x] MEDIUM：surface 解构默认值/模板插值/as 断言漏检
- [x] MEDIUM：ext.syncIndex 失效 · manage.scheme.publish id 校验
- [x] LOW：别名门控提前 · toolsDescription done 去重 · 命名一致性

**记忆侧**（→ packages/pth-memory/TODO.md）：H3 谓词下推 · H5 统一入口 · H6 store 纵深 · H7 来源校验 · memoryScope own 读侧 · readSource/toolstore symlink（与沙箱协同）

**沙箱侧**（→ packages/pth-sandbox/TODO.md）：web.fetchText DNS rebinding/流式限量 · N5 资源环 L3 · 编译核/gdb 容量复核 · sandbox exec-api 健康观测
  → 执行入口（2026-08-16）：`docs/superpowers/plans/2026-08-16-pth-sandbox-hardening.md`（S0–S2）

## N15 车道批（B1/B2/A4——穿透经济化 + 护栏 JIT）✅（2026-08-18 三 lane 并行落）
> 设计契约 `docs/pth/n15-lane-b1-b2-a4-design.md`；合并顺序 B2 → B1 → A4，每步全量验证。
- [x] **B2 穿透执行预算经济化**（`4c166e5`+`cfe8632`）：单次 `PTH_PENETRATION_MAX_STEPS` +
  父任务累计 `PTH_PENETRATION_TASK_BUDGET_STEPS` 双预算线（耗尽报错父回退 delegate）；
  每次调用结算 `penetration-edge` 边级计量聚合（B1 数据地基）
- [x] **B1 穿透自动发现**（`d5a3019`）：`penetration-edge` 达标 → `penetration-proposal`（draft）
  → 监督批准 → `skill:penetrate:<child>` official 注册；`penetration-discovery` schedule trigger 巡检
- [x] **A4 护栏 JIT**（`0feeaff`）：guard-kill-spike 热点（软处置/负结果族白名单）→
  `guard-config` 审批热调 → 复测窗口 → 劣化 deopt 回滚；hard 契约护栏只人工调
- 全量：**256 文件 / 2082 用例绿** + lint（tsc/boundaries/config 117 键）绿

## N17 车道批（A5 + D1——生态转化两条腿）✅（2026-08-18 双 lane 并行落）
> 设计契约 `docs/pth/n17-lane-a5-d1-design.md`；合并顺序 A5 → D1，每步全量验证。
- [x] **A5 叶子角色 SOP 种子×8**（`b09ed8f`）：writer/coder/debug-case-writer/acceptor/planner/
  spider/solver/predictor 四段式 SOP（`SEED_LEAF_SOPS`）注入 prompt-docs——当前 actuator 叶子全种子化
- [x] **D1 MCP 拆解**（`3628d71`）：`mcp-tool-bundle-v1` → `mcp-decompose.ts`（parse/spec/importMcpTools）
  → tool-proposal draft 批量落库（永不直写 official）+ `manage.tool.importMcp` +
  `scripts/import-mcp-bundle.ts`；复用 `tool-proposal-review` 自动对抗审核
- N4 生态转化 pipeline 两分支全部闭环（skill ✅ + MCP ✅）
- 全量：**257 文件 / 2103 用例绿** + lint（tsc/boundaries/config 117 键）绿

## v1.2 路线切换 + N18 K0/K1a（Phase 0/1a）✅（2026-08-18 审稿后落）
> 审稿裁决：原 N16 V1–V5 静态物化 188 角色**冻结**；采纳「角色 × 学科域组合」。
> 文档：`n16-v1.2-role-expansion-review.md`（P0×5/P1×5/P2×3 实证）+
> `n16-v1.2-role-domain-composition-design.md`（Phase 0–6）。实施契约 `docs/pth/n18-v12-phase0-1a-design.md`。
- [x] **裁决入账**（`c126630`）：concepts 0.18 改为组合设计、词表四术语替换、N16 账本行改写、
  parallel-lanes v1.2 改为 K0–K5 车道
- [x] **K0 Phase 0 设计纠偏**（`f8afa78`）：`contracts/domains.ts` + `DisciplineCatalog`
  （DAG 无环/多父/缺父 fail-closed/稳定指纹）+ 生成器 `scripts/build-discipline-catalog.ts`
  ——manifest 复算钉死 **category=5 / discipline=32 / sub-discipline=147 / total=184**
  （手写 149/112 总数废止）
- [x] **K1a Phase 1a 知识正确性收口**（`f4c760d`）：PgMemoryStore 全方法 tenant 隔离
  （缺省 default、update fail-closed）；KnowledgeBroker retrieve 固定 official +
  tenant 取自 grant、get 命中接 consumption 计数；skills.list 排除 draft/archived
- [x] **K1b Phase 1b provenance + revision + refiner draft**（`aa2762e`）：
  `knowledge-provenance.ts`（official domain-fact/domain-method 六字段强制 + 内容哈希校验）+
  `memory_revisions` append-only 历史（write 事务化、revisionHistory/restoreRevision）+
  refiner 只写 scoped draft（tenantId + spaceScope private + provenance；缺 scope fail-closed）
- [x] **K2 Phase 2 双轴任务契约 + Discipline Resolver**（`853b426`）：`TaskWorkItem.domains/domainBinding` +
  `createDisciplineResolver`（显式 id fail-closed / 别名扫描 v1-explicit-alias）+
  发布路径盖章 + claim 映射 + gateway 顶层 `domains` 参数
- [x] **K3 Phase 3 KnowledgeContext + broker search/get**（`4ee2b40`）：
  `KnowledgeContextProvider`（有界/指纹可复现/relevance 排序 + runner 注入正文与 capability）+
  broker search（tenant 来自 grant/official/queryText 过滤/limit）+ get 非 official 404
- [x] **K4 Phase 4 候选验证与晋升闭环**（`5fe95b1`）：`knowledge-verdicts.ts`（canPromote
  fail-closed：draft + provenance + domain/adversarial 双 pass + 无 reject + 生产/审核分离）+
  `knowledge-promotion.ts`（verdict/promote/reject）+ capability 注入（adversarial review /
  memory-keeper promote）+ gateway verify/promote 路由
- [x] **K5 Phase 5 双域真实任务试点**（报告 `docs/pth/k5-pilot-report.md`）：重建镜像 +
  真实 deepseek 任务（programming-languages / materials-science 各 1 条 completed）→
  resolver 盖章 domains/domainBinding → refiner scoped draft → HTTP 双 verdict + promote →
  revision 历史验证；期间修复 K1b status/meta-only 不记历史（`a70ebfe`）
- [x] **K5-eval 双域冻结评测**（`75ea7e8`，报告 `docs/pth/k5-eval-report.md`）：source
  registry 12 + domain-fact 24 + 冻结查询 60 + `pilot-evaluator` + seed/eval 脚本；
  离线与 live（真实 PG 落库 36 条）指标：**domainRecallAt3=1.0 / knowledgeRecallAt5=1.0 /
  evidenceCoverage=1.0**（阈值 0.9/0.9/0.95）
- 全量：**K0 后 258/2122；K1a 后 259/2131；K1b 后 260/2156；K2 后 262/2175；K3 后 263/2189；K4 后 264/2215；K1b 修复后 264/2216；K5-eval 后 266/2225**（文件/用例）均绿 + lint 绿
- [x] **R1–R6 复验修复轮全部 done（2026-08-18 wave-1..4）**：R1 revision/promotion 统一物化判据
  + 单事务 CAS（`38128a1`+`1604d8d`）；R2 raw query 受限 AST 数据面 tenant/status/space（`076a627`+`e423a54`）；
  R4 同事务 outbox + 原子 claim（`c5db1a3`）；R3 持久 VerificationPlan + verdict 绑定 + 授权（`ececb2a`+`c660c36`）；
  R5 生产端口评测 + EvidenceRef 全链（`e8abe1a`）；R6 组合验收（`lane/r6-composition-acceptance`）
  ——`test/pth-composition/r6-acceptance.test.ts` 真实 PG 8/8 + 七类故障注入负向全过
- [x] **Gate A/B/C 改回 accepted**：最终复验报告 `docs/pth/v1.2-acceptance-fix-revalidation-final.md`
  结论 **ACCEPTED**（P0-1..P0-5、P1-1..P1-5 全 PASS）
- 本轮新鲜工程基线：**270 files passed / 1 skipped；2300 tests passed / 9 skipped；observer failed 0**；
  lint（tsc/boundaries 0/config 0）绿；K5 offline/live 138 题 24/24 覆盖 + mutation 1.0；
  R6 组合套件真实 PostgreSQL testcontainers 8/8。
