# PTH Kernel 目标形态实施计划（agent/PTC → sandbox → environment）

> 日期：2026-08-09 · 依据：[agent 执行 SPEC](./2026-08-08-pth-llm-agent-execution-design.md)、[kernel sandbox SPEC](./2026-08-08-pth-kernel-sandbox-design.md)、[environment 生命周期 SPEC](./2026-08-08-pth-environment-lifecycle-design.md)、[synthesis 总览](./2026-08-09-pth-kernel-design-synthesis.md)
> 原则：TDD（先测试后实现）、每个任务独立 commit、端到端验证收尾、不回退已绿测试

## 0. 目标形态（三个 SPEC 的落地全景）

```
LLM agent 执行（PTH 侧受信层）
  ├─ PTC 程序模式：LLM 在 ts vm 写程序组合多 kernel（主执行形态）
  ├─ 完整 kind 分化：intent/code/chain/ops + PTH_TASK_DEFAULT_KIND 迁移
  ├─ 多模型四级覆盖：payload.model / PTH_AGENT_MODEL_<ROLE> / _VERIFY / 全局
  ├─ verify 环节
  └─ LLM 递归：done.next 重投递（fresh）→ route.env 延续（fork，P4 后）

Kernel sandbox（执行层隔离）
  ├─ sandbox 镜像 +python3/numpy + kernel host 服务（池：acquire/execute/reset/release/status）
  ├─ PTH 侧 SandboxKernel 适配器（实现 Interpreter 接口，零上层改动）
  ├─ 敏感信息边界（协议拒绝 env 注入 / sandbox 零敏感 / 验证手段）
  └─ 生产接线（compose 模式切换 + 容器内端到端）

Environment 生命周期（会话与状态统一）
  ├─ env 注册表 + route.env 路由（fork=fresh 统一环境分配）
  ├─ GC 流程（refine 抽取 → 内存释放 → 快照文件）
  ├─ workspace GC（TTL/大小/引用计数）
  └─ 快照重建（PTH_ENV_UNREACHABLE=rebuild）
```

## 1. 任务分解与依赖

```
P1  PTC 程序模式（agent-loop act 升级）          [独立，先做——省 LLM 调用打时间瓶颈]
P2  kind 分化完整化 + 多模型四级覆盖             [依赖 P1 的 agent-loop 稳定]
P3  LLM 递归 fresh（done.next 重投递）           [依赖 P2（kind 路由）]
P4  Environment Phase 1（env 注册表 + fork 路由）[依赖 P3（next 带 route）]
P5  Sandbox Phase A+B（kernel host + 适配器）    [独立并行可行；适配器不依赖 P1-P4]
P6  Environment Phase 2+3（GC + 重建 + sandbox 集成）[依赖 P4 + P5]
P7  生产接线 + 容器内端到端 + 压测对比           [依赖 P5 + P6]
```

### P1: PTC 程序模式（agent-loop act 升级）
```
范围（agent SPEC §5）：
  - agent-loop prompt 增加"程序模式"指导（写完整 ts 程序组合多 kernel，而非单动作）
  - act 执行 ts 程序走 vm（capability 白名单已注入——零新能力）
  - 结果回填增强：程序 return 值 + stdout（含中间输出）
  - 单轮消息模式适配：程序代码 + 结果并入 user 轨迹
文件：src/pth/kernel/execution/agent-loop.ts、agent-tools.ts
验证：
  - 单测：runAgentTask 输出 ts 程序（组合 python.execute+bash.execute）→ 一次执行完成多步
  - 端到端：5 任务（fib+验证 / 求和 / 质数 / 双 kernel 组合 / 失败修正）
  - 压测对比：LLM 调用次数 3→1-2、token ~1200→~700（记录到 SPEC §9.5）
风险：大程序正确率——错误回填修正轮兜底
```

### P2: kind 分化完整化 + 多模型四级覆盖
```
范围（agent SPEC §3/§4）：
  - PTH_TASK_DEFAULT_KIND 迁移（兼容默认 code → 目标默认 intent，env 切换）
  - kind 路由完整化：intent（agent 循环）/ code（直通执行）/ chain（resolver）/ ops（运维）
  - 多模型解析链落地：payload.model → PTH_AGENT_MODEL_<ROLE> → PTH_AGENT_MODEL_VERIFY → PTH_AGENT_MODEL → 全局
  - verify 环节：done 后可选 verify 模型复核（PTH_AGENT_VERIFY=on 时）
文件：src/pth/kernel/execution/role-router.ts、task-loop.ts、agent-loop.ts、model-router.ts
验证：
  - 单测：默认 kind 迁移开关/四级模型解析优先级/verify 开关
  - 端到端：intent 走 agent、code 直通、verify 开启复核通过
风险：默认 kind 切换影响存量任务——env 开关渐进
```

### P3: LLM 递归 fresh（done.next 重投递）
```
范围（用户裁决：递归 = 任务自我重投递）：
  - done 支持 next: {title, text, kind?, role?} | next: [...]（fan-out）
  - TaskLoop submit 后：有 next → publish 子任务（payload.parentId=当前）→ 池再处理
  - 终止：无 next；深度上限 PTH_TASK_MAX_DEPTH（默认 5，按 parentId 链深）
  - fresh 语义：子任务常规路由（新建环境——P4 前无 route.env 概念）
文件：src/pth/kernel/execution/agent-loop.ts、task-loop.ts、task-store-pg.ts（publish parentId）
验证：
  - 单测：next 单链/多 next 并行/无 next 终止/深度超限拒绝
  - 端到端：任务 A → LLM 判定投递 B → B 完成 → A 链结束（池内全生命周期）
风险：递归失控——深度上限 + 既有治理（terminal reject）
```

### P4: Environment Phase 1（env 注册表 + fork 路由）
```
范围（environment SPEC §2/§3）：
  - 环境注册表：env-id → worker/kernel 句柄（内存表，env 活跃期）
  - 路由扩展：payload.route.env（指定编号=fork / new=fresh）；不可达降级（PTH_ENV_UNREACHABLE）
  - TaskLoop：延续任务跳过 kernel.reset（fork 语义）；fresh 正常 reset
  - done.next 携带 route.env（fork：next.route.env=当前 env-id）
  - 引用计数：父任务完成且无 next 引用 → 环境空闲（进 GC 等待）
文件：src/pth/kernel/execution/environment-registry.ts（新）、role-router.ts、task-loop.ts、task-store-pg.ts
验证：
  - 单测：注册表（创建/定位/释放）、路由解析（指定/new/不可达降级）、fork 不 reset
  - 端到端：fork 链（子任务继承父 kernel 变量——python ns 延续）/ fresh 链（不继承）
风险：fork 绑定 worker 实例（进程死状态死）——P6 快照重建兜底
```

### P5: Sandbox Phase A+B（kernel host + SandboxKernel 适配器）
```
范围（sandbox SPEC §3）：
  A. sandbox 侧：
     - Dockerfile.sandbox + python3/numpy
     - src/sandbox/kernel-host.ts：acquire/execute/reset/release/status + 池管理（空闲优先/FIFO）
     - 复用 PyKernel/BashKernel 实现为宿主 kernel 核心（抽公共模块）
     - 敏感信息：协议无 env 字段；容器 env 白名单断言
  B. PTH 侧：
     - SandboxKernel 适配器（实现 Interpreter：execute/reset/snapshot/dispose → HTTP）
     - PTH_PYTHON_MODE/PTH_BASH_MODE="sandbox-kernel" 切换
文件：src/sandbox/kernel-host.ts（新）、src/sandbox/exec-api.ts、Dockerfile.sandbox、
      src/pth/kernel/interpreter/sandbox-kernel.ts（新）、kernel-manager.ts、kernel-config.ts
验证：
  - 单测：宿主池（acquire 空闲优先/FIFO/release 回收）、协议拒绝 env 字段、敏感 key 过滤
  - 集成：本地起 kernel-host（testcontainers 或进程级）→ SandboxKernel 全链路任务
  - 端到端：sandbox 模式 python os.environ 无敏感项（SPEC §4.5 验证④）
风险：网络往返开销——池化复用 + 内网单次往返；实测对比
```

### P6: Environment Phase 2+3（GC + 重建 + sandbox 集成）
```
范围（environment SPEC §4/§5）：
  - GC 三步：空闲超时/引用归零 → refine 抽取（复用）→ 内存释放 → 快照文件 workspace/envs/env-<id>.json
  - workspace GC 循环：PTH_ENV_SNAPSHOT_TTL / MAX_MB / 引用计数清理
  - 快照重建：PTH_ENV_UNREACHABLE=rebuild（eval 重放/按 spec 重建）
  - sandbox 集成：env 编号 ↔ sandbox 池内 kernel（GC=池回收）
文件：src/pth/kernel/execution/environment-gc.ts（新）、workspace-gc.ts（新）、environment-registry.ts
验证：
  - 单测：GC 触发条件/三步顺序/快照格式/workspace GC（TTL/大小/引用）
  - 端到端：env 空闲 → GC → 快照文件存在 → 重建恢复（变量可继续用）
风险：GC 与执行竞态——引用计数保护 + 回收前二次确认
```

### P7: 生产接线 + 容器内端到端 + 压测对比
```
范围：
  - compose：sandbox 暴露 kernel 端口（internal 网络）+ pi-platform 注入 sandbox-kernel 模式
  - 容器内端到端：agent 任务（python/bash 走 sandbox kernel）/ fork 链 / GC
  - 压测对比：sandbox vs 本地（耗时/内存/token）→ 更新 SPEC 实测章节
  - 敏感信息验证：镜像扫描（门禁脚本）+ 运行期 env 断言
验证：compose up 全链路 / 门禁通过 / 压测数据落档
```

## 2. 并行与顺序策略

```
独立轨道（可并行）：
  轨道 A（agent）：P1 → P2 → P3 → P4
  轨道 B（sandbox）：P5（不依赖 A）
  汇合：P6（依赖 P4+P5）→ P7
执行：SDD——每任务 fresh subagent + reviewer gate + TDD + 独立 commit
```

## 3. 验收总标准

```
- 全量测试绿（现 1291 + 新增）且 tsc 干净
- 三 SPEC 的"未落地"项全部转"已落地"（synthesis §6 表更新）
- 端到端闭环：fresh/fork 任务、GC、sandbox 模式、递归链各跑通
- 压测对比数据落档（LLM 调用/token/耗时 before-after）
- 安全验证通过：sandbox 零敏感（os.environ 检查）/ 协议无 env 注入
```

## 4. 风险总表

| 风险 | 对策 |
|------|------|
| PTC 大程序正确率 | 错误回填修正轮 + 单 kernel 工具兜底 |
| 默认 kind 迁移影响存量 | env 开关渐进（PTH_TASK_DEFAULT_KIND） |
| 递归失控 | PTH_TASK_MAX_DEPTH + 既有治理 |
| fork 绑定 worker 实例 | 快照重建降级（P6） |
| sandbox 网络往返开销 | 池化复用 + 实测对比 |
| 环境/GC 竞态 | 引用计数 + 二次确认 |
