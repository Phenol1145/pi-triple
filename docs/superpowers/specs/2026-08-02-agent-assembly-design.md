# 装配层设计（子项目 C）

- **日期**：2026-08-02
- **状态**：设计（待评审）
- **范围**：agent 装配——`assembleAgent` 把声明（AgentDefinition + memory spec）变成可运行的经济主体（AgentRuntime）；记忆系统（子项目 B ✅）的接线契约落实；开户与注册持久。
- **定位**：市场经济体制（方案 A）三阶段之③——经济层（D：多货币/嵌套市场/elo/竞价 workflow）的前置。前序：pit-flow 运行时扩展（A ✅）+ 记忆系统（B ✅）。

---

## 1. 背景与目标

### 1.1 现状

- **AgentInstance 只是登记记录**：`AgentInstanceRecord`（core/contracts.ts:146）持有 id/definition/status，无执行能力
- **WorkLoopRuntime sidecar**（create-runtime.ts）：core/registry/runner/adapter/stateStore/checkpointStore/cloneService——运行时基座，未接记忆
- **记忆系统已就绪**（B ✅）：MemoryStore/RuleRegistry/MemoryPipeline/WatermarkManager/PublicDomainStore/AuditChain/CommsChannel/DspBuilder + `mountMemorySdk`（Task 12）
- **账本已有**：arena 的 SqliteLedger（账户/余额/交易）

### 1.2 差距

1. 无"装配"动作：定义 → 可执行主体的实例化路径不存在
2. 记忆系统是离散模块，无宿主挂载（mountMemorySdk 无调用方）
3. 记忆系统最终评审的 9 项接线契约（revive/idem prune/TTL sweeper/审核窗口/方言解析/pit-communicate 桥接/纸带注入/DSP restore/dir 显式）无落实方
4. 经济主体无账本账户（开户路径缺失）

### 1.3 目标

1. `createAgentAssembler(deps)` 工厂 + `assembleAgent(ref, opts) → AgentRuntime`
2. **AgentRuntime**：可运行经济主体（MachineRuntime 包装 + memory/comms/dsp 挂载 + run/resume/dispose）
3. 记忆域初始化语义：**fresh = 最小记忆合集**（公理引用 + 基础规则共享 + 空私域）；**fork = 最小合集 + 源私域整库拷贝**
4. LedgerPort 抽象 + SqliteLedger 默认实现（开户：endowment.K）
5. 9 项接线契约落实（本 spec §4）
6. 零破坏：既有 workloop/runtime 测试全绿；AgentInstanceRecord 扩展向后兼容

---

## 2. 装配器与装配流程

### 2.1 工厂与依赖

```typescript
export interface AgentAssemblerDeps {
  registry: DefinitionRegistry;              // workloop 解析
  agentStore: AgentInstanceStore;            // AgentInstanceRecord 持久（repository）
  ledger: LedgerPort;                        // 开户（续跑幂等语义，§2.4）
  ruleBootstrap: RuleBootstrap;              // 全局规则库只读视图（公理 + 基础规则 = 公域规则域）
  runner: WorkLoopRunner;                    // 共享实例（N-C3 裁决：runner 内按 agentInstanceId 分 FIFO 天然支持多 agent；八件构造输入由装配器调用方组装注入）
  workDir: string;                           // 装配产物目录（记忆域/快照/日志根）
  comms?: {                                  // 通讯桥接（可选——无则 agent 无 comms）
    transport: CommsTransport;               // pit-communicate 桥接注入
    identity: { agentId: string; tenantId: string; sessionId: string };
  };
  now?: () => number;
}

export function createAgentAssembler(deps: AgentAssemblerDeps): AgentAssembler;
export interface AgentAssembler {
  assembleAgent(ref: AgentRef, opts: AssembleOptions): AgentRuntime;
}
export interface AssembleOptions {
  cloneMode: "fresh" | "fork";
  sourceAgentId?: string;                    // fork 模式的源 agent
  schedulerInstanceId: string;               // 市场宿主实例（必传——D 提供；独立装配需宿主）
  endowment?: { K: number; initialFloor: number };  // 初始资本（默认 = DEFAULT_MARKET_CONFIG.endowment；floor 改名防与价格 floor 混淆）
  memory?: MemorySpec;                       // 覆盖/补充 AgentDefinition.memory
}
```

### 2.2 装配流程（顺序钉死）

```
assembleAgent(ref, opts):
  1. 解析注册表：workloop {id, version} 已注册（machine 契约）——未注册 → 装配失败（明确错误）
  2. 校验：
     a. workloop.config 过 parameterSchema（registry 既有校验）
     b. memory 声明（definition.memory ?? opts.memory）过 MemorySpecSchema（新增，§2.3）
  3. 实例化：
     a. initialContext/initialState（workloop 自带）
     b. 记忆域初始化（§2.5 规则链）：
        fresh = 最小合集（私域空 + 规则 fallback 链指向全局规则库）
        fork = 最小合集 + 源 agent 私域整库拷贝（目录级拷贝；
               拷贝后重建索引——源多文件跨文件不一致的修复路径）
  2b. 注册预检（N-C1 裁决）：agentStore.getAgent(agentId)（交付项）——已注册 → 装配失败（返回既有记录，幂等冲突）
  4. 开户（续跑幂等，§2.4）：ledger.open(agentId, endowment.K)
     ——账户已存在 ∧ 未注册 → 视为本装配续跑（崩溃恢复；幂等 oracle = 注册记录，非余额）
     ——账户已存在 ∧ 已注册 → 已被步骤 2b 拦截
     ——余额探测不参与幂等判定（余额是易变量，K=0 边界不可靠）
  5. 注册持久：AgentInstanceRecord { id, schedulerInstanceId(必传宿主), definition,
     memorySpec?, endowment?, status: "ready"（既有枚举）, createdAtRoundId? }
     —— **N-I9 交付项**：schema 迁移（created_round_id 改可空 + 新增 memory_spec/endowment 可空列）；装配语境无优化轮 → 哨兵 ""（迁移后合法）
  6. 组装 AgentRuntime（§3）并返回
```

### 2.3 MemorySpecSchema（新增）

```typescript
export interface MemorySpec {
  dialect?: "json" | "xml" | "markdown";     // 默认 "json"；markdown = draft-only 方言（写入恒草稿区，诚实标注）
  maxEntries?: number;                        // 私域条目上限（默认 1000）
}
```

校验规则：dialect ∈ 白名单；maxEntries 正整数；未知字段 → 校验错误。

### 2.4 开户语义（续跑幂等 + 回滚路径）

- `ledger.open(agentId, K)`：新账户 → 开户；已存在 → 续跑判定（**oracle = 注册记录预检**：未注册 → 续跑；已注册 → 步骤 2b 已拦截）。余额不参与判定
- **回滚交付项**：SqliteLedger 增加 `removeAccount(agentId)`；**attempt-local 语义（N-C1）**：仅当账户是本装配调用所创建（open 返回 created 标记）才可回滚删除——绝不删除既有账户
- 装配原子性声明：先校验后落盘；任一步失败 → 已创建的记忆域目录清理 + **本调用创建的**账户回滚

### 2.5 记忆域模型（公域 = 全部 kind 的检索作用域，修正）

- **公域记忆 = 全部 kind 的共享域**（fact/experience/preference/rule 等）——不是规则专属；公域**不拷贝进私域**，是**检索作用域**（N-C2 裁决：选 a 组合检索——本 spec 明确为对记忆系统 §5/§6 的模型变更，交付项全列）：
  - **联合检索交付项**：MemoryHost.retrieve = 私域（水位过滤）+ 可及公域（PublicDomainStore official 条目，无水位——公域不随 resume 回滚）**并集**（去重按 id；排序私域优先）
  - **DSP 公域区交付项**：记忆入口区 = 私域段（水位过滤）+ 公域段（直接可见）两段拼接
  - **公域库位置**：全局共享目录（workDir 同级 `<root>/public-domain/`，跨 agent 共享）；初始化 = PublicDomainBootstrap（幂等：空库时写入种子条目）
  - **权限一致性**：resolveRule fallback 与 retrieve 公域作用域同为"可及公域"——无反向不对称
- **私域**：agent 自己的沉淀（写）；fork = 源私域整库拷贝（拷贝后重建索引——多文件跨文件不一致的修复路径）
- **规则链（特殊子集）**：规则是**校验依赖**（content 校验需要 ruleRef 可解析——运行前提），故需要解析链：`RuleRegistry` 扩展只读 fallback——resolveRule 先查私域 → 未命中查全局规则库；**写永远落私域**（agent 自建规则）
  - 全局规则库 = 公域 kind=rule 条目（公理 + 基础规则）；装配层经 `RuleBootstrap`（新类型）注入；**位置/初始化（N-I3）**：全局共享目录 `<root>/rules/`；`RuleBootstrap.ensureInitialized()` 幂等 bootstrap（公理 + 基础规则模板；tmp+rename 先写者胜，无并发竞态）
  - 事实/经验/偏好**无此依赖**（只检索、不解析——retrieve 走公域作用域即可）
- **fresh = 最小合集**：规则链（公理 + 基础规则 fallback）+ 私域空 + 公域可检索
- **公域修改（任何 kind）= 公域提交**：fork 私域修改 → AuditChain 审核 → PublicDomainStore.submitWriteBack merge 回公域（复用 T8/T9，无新路径）；规则修改只是其一个实例——与 meta 审核循环裁决（operator 亲审）一致
- 公域更新（任何 kind merge 后）：检索作用域天然最新（不拷贝故无漂移）；规则 fallback 只读视图同样天然最新

---

## 3. AgentRuntime

### 3.1 结构与生命周期

```typescript
export class AgentRuntime {
  readonly agentId: string;
  constructor(deps: {
    runner: WorkLoopRunner;                   // 既有 runner（每次 run/resume 新建 MachineRuntime 由 runner 负责）
    memory: MemoryHost;                       // 记忆挂载（§3.2）
    comms?: CommsChannel;                     // 可选
    dsp: DspBuilder;                          // DSP（含 dir 显式）
    ledger: LedgerPort;
  });
  run(req: { task: string; config?: unknown; optimizationRoundId?: string; signal?: AbortSignal }): Promise<WorkLoopResult>;
  // 签名收窄（N-I1）：agentInstanceId/workLoopId/workLoopVersion/traceId/executionId/schedulerInstanceId 由本类自填（绑定 AgentDefinition，外部不可指定别的 workloop）
  resume(checkpointId?: string): Promise<WorkLoopResult>;      // 无参 = latest（CheckpointStore.latest 公开访问器，交付项）
  dispose(): void;                            // 清理 comms 监听/定时器
}
```

### 3.2 MemoryHost（记忆挂载点）

- `mountMemorySdk(sdk, deps)`（记忆系统 Task 12 已建）——AgentRuntime 把 sdk 桥接到 MachineRuntime 的 WorkLoopSDK（machine 的 δ 通过 sdk.memory/sdk.comms 访问）
- 记忆域目录布局（装配产物目录下）：`<workDir>/agents/<agentId>/memory/`（entries/index/counters/buffer/idem/dedup/dsp-snapshots/audit-events/not-write-back）
- 规则链：公理 + 基础规则为**共享引用**（全局规则库），agent 自建规则落私域

### 3.3 LedgerPort

```typescript
export interface LedgerPort {
  open(agentId: string, initialK: number): void;      // 开户（已存在且余额=K → 续跑；否则抛错）
  balance(agentId: string): number;
  credit(agentId: string, amount: number, reason: string): void;
  debit(agentId: string, amount: number, reason: string): void;  // 余额不足 → 抛错（adapter 检测 clamp）
  freeze(agentId: string, amount: number, reason: string): void; // 竞价质押（D 准备）；映射：reason → taskId 派生键（`freeze:<agentId>:<reason>`）；余额不足 → 抛错（adapter 检测 SqliteLedger 返回 false）
  unfreeze(agentId: string, reason: string): void;              // 整笔解冻（N-I5：SqliteLedger.unfreeze 按 taskId 整笔——不支持部分解冻，Port 签名对齐）；同 key 异 amount 静默幂等 → adapter 检测并抛错
}
export class SqliteLedgerAdapter implements LedgerPort {
  /* 包装 arena SqliteLedger；交付项：SqliteLedger 增加 removeAccount（装配回滚）；
     开户 flat-K 语义 = 直接 INSERT（绕过 ensureEndowed 的模型价格计算）*/
}
```

---

## 4. 接线契约落实（记忆系统最终 rulings 的 9 项）

| # | 契约 | 落实方式（本子项目） |
|---|---|---|
| ① | write 幂等命中 → revive | MemoryHost 在 write 幂等命中后查 `isPendingActivation` → `WatermarkManager.revive(entryId, nextCheckpointSeq)`；**seq 供给（N-I7 改动面）**：MachineRuntime 加只读当前 seq 面 + runner 透传 getter（穿透 in-flight 实例——交付项，加方法不改行为） |
| ② | idem 键表水位 prune | resume 时对 idem 表执行水位 prune（扩展记录格式 `{key, watermark}`；**旧行无 watermark = 视为 0**——保守保留永不误删；**prune seq 来源 = CheckpointStore.latest(agentId).seq ?? 0**，N-I6）；对齐 dedup.jsonl 先例 |
| ③ | TTL sweeper | AgentRuntime 生命周期内定时清扫（默认每小时，可配）：draft 且 ttlExpiresAt 过期 → archived；dispose 清理定时器；**draft→promote 竞态**：归档与 promote 之间目标消失 → 明确报错路径 |
| ④ | 审核窗口 | **配置透传 + onDecision 回调出口（砍定时器，YAGNI）**：AuditChain 加 onDecision 回调（v1 透传 decision）——D 的组合链驱动窗口与 merge，不回来改 C |
| ⑤ | 方言解析 | sdk.memory.write 包装内**预检**：parseDialect 只做错误检测与警告（不替换 content——ruleRef EBNF 校验是权威）；**markdown = draft-only 方言**（写入恒草稿 + 明确反馈，写进 MemorySpec 文档） |
| ⑥ | pit-communicate 真实桥接 + 纸带注入 | CommsTransport 适配器（mailbox 发送/接收/activePeers，**强制 delivery=auto**——agent↔agent 不可走 manual 人工门）；**收件缓冲（N-I4 交付项）**：comms-inbox.jsonl（workDir 下，持久化、容量上限默认 100 条）——消息先入队，run 开始时并入（委托式 = 任务文本；local-model = 任务种子；run 不活跃时消息累积不丢），并入时 WorkContext.messages 追加 user 消息（来源标记 `peer:<id>`） |
| ⑦ | DSP restore 顺序 | **snapshot 生产者 = runner onCheckpoint 钩子（N-I2 交付项：runner 加 onCheckpoint 注册 + checkpoint.created payload 加 seq 字段；时序 = save 后 emit）** → DspBuilder.snapshot(seq, "realtime")；DspBuilder 加 `loadSnapshot(seq)`；首次 run 无快照 → 回退新鲜检索（防御） |
| ⑧ | AuditChain/DspBuilder dir 显式 | 装配时传入 workDir 下子目录——杜绝 process.cwd() 兜底 |
| ⑨ | 身份映射 | IdentityMap 落 workDir；sessionId 刷新回调（pit-communicate session_start 时） |
| ⑩ | comms dedup prune（补漏项） | resume 时 `CommsChannel.pruneDedup(seq)`（与 ② 同钩子——comms.ts 自注"调用方：resume 时"） |

**未接线（明确留给 D）**：审核→merge 组合链端到端（AuditChain onDecision → PublicDomainStore.submitWriteBack 的驱动）；市场竞价接入；多货币账本语义。

### 4.1 类型定义出处（N-I10 补）

- `AgentRef` = `{ kind: "workloop"; id: string; version: string }`（DefinitionRef 形状）
- `AgentInstanceStore` = core/storage/repository 的 agent 查询/写入面（**交付项**：新增 `getAgent(agentId)` 单查）
- `MemoryHost` = 本子项目新类（记忆挂载：联合检索/规则 fallback 接入/sdk 桥接/TTL sweeper）
- `RuleBootstrap` = 本子项目新类（全局规则库只读视图 + ensureInitialized）
- `PublicDomainBootstrap` = 本子项目新类（公域库幂等初始化）

---

## 5. 测试策略

1. **装配成功路径**：mock deps → AgentRuntime 可 run 一轮（machine 驱动 + 记忆挂载 + 开户 + 注册断言）
2. **失败路径**：workloop 未注册 / config 违 parameterSchema / memory 违 MemorySpecSchema / 重复开户
3. **fresh vs fork 记忆域**：fresh = 最小合集（公理+基础规则+空私域）；fork = 整库拷贝断言（条目数/内容一致）+ fork 后独立演化互不影响
4. **接线契约逐项**（①②③⑤⑥⑦⑧ 各一测试；④ 定时器 mock）
5. **零破坏回归**：既有 workloop/runtime/arena 测试全绿（AgentInstanceRecord 扩展向后兼容）
6. **bench 演示**：真实最小装配（pi-default-loop + json 方言 + endowment）+ 一轮 run 冒烟

---

## 6. 范围与非目标（YAGNI）

- ✅ createAgentAssembler + AgentRuntime + MemoryHost + LedgerPort（SqliteLedger 默认）
- ✅ 记忆域初始化（fresh 最小合集 / fork 整库拷贝）+ 开户 + 注册
- ✅ 9 项接线契约（①-⑨）
- ✅ bench 演示脚本
- ⛔ CLI 装配命令（API 先行，CLI 后置）
- ⛔ 多货币账本语义（D）
- ⛔ 审核→merge 组合链端到端（D）
- ⛔ 市场竞价接入（D）
- ⛔ 修改既有 runtime 工厂签名（只新增，不改既有行为）

---

## 7. 关键不变量

1. **装配失败零副作用**：任一步失败 → 已开户账户回滚/已写文件清理（装配原子性：先校验后落盘）
2. **fresh ≠ 零记忆**：最小合集（公理 + 基础规则）是运行前提
3. **fork 拷贝是快照**：拷贝后源/目标私域独立演化（无同步）
4. **AgentInstanceRecord 向后兼容**：仅新增可选字段
5. **sdk 挂载零破坏**：既有 workloop 不感知 memory/comms（可选字段）
6. **接线契约 ①-⑩ 全部有测试**（无"留白契约"——记忆系统 rulings 在本子项目必须闭合）
7. **dir 显式传递**：杜绝 process.cwd() 兜底（⑧）

---

## 8. 隐藏依赖与风险

1. **arena SqliteLedger**：node:sqlite（DatabaseSync）——依赖 Node 22+；SqliteLedgerAdapter 包装的接口映射需核对（open/credit/debit 签名差异）
2. **MachineRuntime 的 nextCheckpointSeq 供给**：①⑦ 依赖引擎暴露下一 checkpoint seq（既有 checkpointEvery 机制——需确认暴露方式，必要时 runner 侧加 getter）
3. **pit-communicate bridge**：mailbox 按 (tenant, session) 寻址——transport 适配器需要 session 上下文（IdentityMap 已建）；delivery mode 强制 auto（agent↔agent）
4. **WorkContext.messages 追加的注入点**：runner 的执行循环内（委托式 = 任务文本注入点；本地式 = messages 直接追加）——两轨注入语义差异
5. **TTL sweeper 与 checkpoint 的交互**：清扫动作本身是否进 Trace（记忆系统 §9 观测）——v1 记录审计事件即可
6. **AgentInstanceStore**：AgentInstanceRecord 的存储位置（core repository？新 store？）——复用 core/storage/repository（getInstance 等既有接口，加装配写入路径）
