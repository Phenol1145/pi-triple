# ts REPL 标准扩展包（memory/context/perf 统一封装）SPEC v1.0

> 日期：2026-08-09 · 状态：已批准（用户裁决）· 关联：[工具面收敛设计](./2026-08-09-pth-agent-tool-convergence-design.md) · [调试协议设计](./2026-08-09-pth-debug-protocol-design.md) · [编译核设计](./2026-08-09-pth-compiled-kernel-design.md)

## 1. 定位：ts REPL 标准扩展包（用户裁决）

```
ts 核已吸收的能力（memory/context/results）+ 新增 perf/model/obs —— 统一封装为一个标准扩展包：
  src/pth/kernel/extensions/
    index.ts         扩展注册机制 + 统一注入 + 文档聚合
    memory.ts        memory.query/write（受限 SQL + 封装写入——已实现，迁入整理）
    context.ts       context/results 对象（ts 核内工作台/结果注册表——已实现，迁入整理）
    model.ts         model 会话内模型切换（新增——用户补充）
    perf.ts          perf 性能调优（新增）
    perf-params.ts   配置中心（env 加载 + 运行时 set）
    perf-store.ts    策略存储（toolstore 文件）
    obs.ts           obs 可监控数据调查（新增——用户补充）
```

## 2. 扩展注册机制（新扩展 = 一个模块 + 注册）

```ts
interface TsReplExtension {
  id: string;                              // "memory" | "context" | "perf"
  provide(ctx: ExtCtx): Record<string, unknown>;   // 注入 vm 的能力对象
  doc: string;                             // API 文档片段——自动聚合进能力文档
}
// buildCapabilities 遍历注册表：能力注入 + AGENT_CAPABILITY_DOC 自动生成
// （文档不再手写维护——扩展自声明）
```

## 2.5 model 扩展（会话内模型切换——用户补充）

```
ts 核内 model 对象（会话级状态——"ts 核 = agent 状态"裁决延伸）：
  { current: { provider, model }, history: [{model, at, reason}], usage: {input, output} }

能力函数：
  model.set({ provider?, model? })  → 切换会话当前模型（写 ts 核对象）
  model.get()                       → 当前模型
  model.usage()                     → 本会话 token 消耗（模型维度）

agent-loop complete() 选择链（每轮读 ts 核 model 对象——readObject 已有）：
  显式 llm.complete model > model 对象 current > env PTH_AGENT_MODEL（降级）

场景：简单步 flash / 复杂推理切 pro / 验证切 verify 模型 / 失败重试换模型 / usage 控制成本
边界：v1 仅 agent 循环 LLM 调用；refine/verify 独立模型不跟随（v2 可配）
```

## 2.6 obs 扩展（可监控数据调查——用户补充）

```
能力面（ts 程序内）：
  obs.tasks { status?, role?, since?, limit? } → 任务池调查（状态分布/耗时/拒绝原因/claims）
  obs.metrics { pattern?, since? }             → 指标查询（pth_* 系列——kernel-metrics 60+）
  obs.batches { }                              → 批次调查（存活/worker/tasks/空闲比）
  obs.kernels { }                              → 内核池调查（inFlight/idle/缓存命中）
  obs.search { query }                         → 事件/审计检索（pg audit/transcripts）

与 perf 分工（读写分离）：obs=读（发生了什么）/ perf=写（怎么改）
闭环：obs 发现问题 → perf 出策略 → obs 验证效果

数据源（batch 子进程视角）：
  obs.tasks/search → pg（queryReadOnly 同源执行器封装）
  obs.metrics/batches → 主进程 registry/BatchManager（IPC 请求-响应通道——新增）
  obs.kernels → sandbox kernel-host /status（batch 已知 sandbox URL 直查）
```

## 3. perf 扩展（性能调优能力面）

### 3.1 能力面
```
perf.status { }           → 性能快照（批次/队列/内核池/缓存/LLM in-flight——指标聚合摘要）
perf.params { }           → 当前生效参数全表（PTH_* 快照——配置中心读取）
perf.set { key, value }   → 运行时调整参数（配置中心改写——立即生效）
perf.analyze { }          → 瓶颈诊断（pending 积压/LLM 并发超限/缓存命中率低/内核池饱和）
perf.publish { strategy } → 发布优化策略（toolstore 文件落盘）
perf.apply { id }         → 应用策略（参数 set + actions 投递维护任务）
perf.list { }             → 已发布策略清单
```

### 3.2 配置中心改造（env 静态 → 运行时可调——仿 PG）
```
现状：PTH_* 参数 = process.env 直读——运行时不改
改造：参数表（启动时从 env 加载）→ 组件读参数改走配置中心
  perf.set = SET 语义（内存级——重启失效）
  （v2）ALTER SYSTEM = 持久化（配置文件——重启保留）
  v1 生效范围：auto-scaler / claim-reaper / kernel-config（读参数点收敛）
```

### 3.3 策略发布闭环
```
策略结构：
  { id, name,
    params: { PTH_BATCH_SCALE_UP_THRESHOLD: 3, ... },
    actions: [ { type: "task", template: "vacuum", ... } ],   ← 维护任务计划
    condition?: "pending>50" }

存储：toolstore 文件（文件即状态原则——与 fs 能力一致）
应用：perf.apply → 参数 set + actions 经任务池投递（VACUUM/索引维护）
衔接：任务池实验的"optimizer 角色"设想——perf 是能力底座
```

## 4. 数据源与安全

```
perf.status/analyze 数据源：kernel-metrics（60+ 指标）/ batch status / 池 status / 缓存状态
  ——指标聚合的 LLM 友好视图（与 env.inspect 同哲学：摘要非 dump）
perf.set 白名单（用户裁决点）：
  · agent（LLM 循环）：全量参数可调
  · 任务代码（vm）：受限 key 白名单（防任务代码乱改全局参数）
```

## 5. 落地阶段

```
Phase 1：标准扩展包重构（纯整理——零行为变化）
  - extensions/ 目录 + 注册机制（id/provide/doc）
  - memory/context 迁入（capability 注入点统一走扩展注册表）
  - AGENT_CAPABILITY_DOC 自动聚合（快照对比——文档内容不变则测试过）
Phase 2：配置中心
  - 参数表（env 加载）+ 读参数 API + perf.set（内存级）
  - auto-scaler/claim-reaper/kernel-config 读参数收敛
  - 测试：set 后组件行为立即变化（如阈值调整生效）
Phase 3：perf 能力面
  - perf.status/params/analyze（指标聚合摘要）
  - perf.publish/apply/list（toolstore 策略文件 + 应用闭环）
  - 端到端：LLM 调 perf.analyze → 发布策略 → apply → 验证参数生效
Phase 4：（v2）参数持久化（ALTER SYSTEM 语义）+ 更多组件参数收敛
```

## 6. 裁决记录

| # | 裁决 |
|---|------|
| 1 | perf + memory/context/results 统一封装为 ts REPL 标准扩展包（一个包演进） |
| 2 | 扩展注册机制：id/provide/doc——能力注入 + 文档自动聚合（新扩展=模块+注册） |
| 3 | perf 能力面：status/params/set/analyze/publish/apply/list |
| 4 | 配置中心：env 启动加载 + 运行时 set（SET 语义）；v2 持久化 |
| 5 | 策略存储 toolstore 文件；应用 = 参数 set + actions 投递任务池 |
| 6 | perf.set 权限：agent 全量 / 任务代码白名单受限 |
| 7 | model 扩展：会话内模型切换（ts 核内对象 + 选择链动态层）——能力函数先行 |
| 8 | obs 扩展：可监控数据调查（obs.tasks/metrics/batches/kernels/search）——与 perf 读写分离 |
| 9 | obs 数据源：tasks/search 走 pg；metrics/batches 走 IPC 请求通道；kernels 直查宿主 |
| 7 | model 扩展：会话内模型切换（ts 核内对象 + 选择链动态层）——能力函数先行 |
