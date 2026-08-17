# TODO（2026-08-15 对齐真实进度）

> 未执行方案的统一入口与执行顺序见 [剩余工作总控计划](./docs/superpowers/plans/2026-08-15-remaining-work-program.md)。

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
- v1.2：评测资产完成；production acceptance blocked——Gate A/B/C 修复中（见验收报告）
