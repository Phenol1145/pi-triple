# pit-flow 运行时扩展：code 节点 + 指标声明（子项目 A）

- **日期**：2026-08-02
- **状态**：设计（待评审）
- **范围**：pit-flow 运行时（`src/ptl/flow/`）扩展两个能力——**code 节点**（确定性计算节点）与 **node 级 metrics 字段**（经济语义声明点）。并行扇出已有（v2 引擎 `findReadyNodes` + `maxParallel` + `needs` AND-join），本设计仅确认与竞价场景的适配。
- **定位**：市场经济体制（子项目 D）与团队社会结构（子项目 E）的**运行时地基**——竞价流程（出价并行 → 评分选主 → 结算）将表达为 flow，评分/选主/结算等确定性计算需要 code 节点；credit/elo/记忆的经济语义需要 metrics 声明点。

---

## 1. 背景与目标

### 1.1 现状（pit-flow v2）

- 图驱动执行：`findReadyNodes` 找就绪节点 → `maxParallel` 分批执行 → 结果经 edges 传播（`consumed`/`firedEpoch` 记账）→ hunger 检测兜底
- 节点类型仅 `agent`（spawn pi 进程执行）与 `human`（人工门）
- `NodeDef`：`{ id, type, model?, template?, prompt?, message?, tools?, cwd?, timeoutSec?, needs?, writes? }`
- 状态：`state` 变量 + `writes` 写入 + `{{state.x}}` 模板 + reducers（`{{increment:...}}`）
- 检查点/resume：节点级 checkpoint，`waiting_human`/`failed`/`running-but-dead` 可恢复
- v1 单步引擎保留兼容（`runFlow`），v2 为新引擎（`runFlowV2`）

### 1.2 差距

1. **无确定性计算节点**：评分（stake×w+elo×w）、选主、结算（stake×odds−tax）、汇率折算、任务分解映射——都是确定性计算，当前只能用 agent 节点（LLM，非确定、有成本）或外部脚本，无法在 flow 内表达
2. **无经济语义声明点**：flow 节点执行的经济后果（credit 转移/elo 更新/记忆沉淀）无处声明——团队 workflow 与竞价 workflow 的指标规则没有落点
3. **并行语义需竞价适配确认**：竞价 = N 个出价节点并行 + 评分节点 AND-join——机制已具备，需验证/补测试

### 1.3 目标

1. `code` 节点：flow 内确定性计算（注册函数名引用 → 同进程执行 → 读写 state）
2. `metrics` 字段：node 级经济语义声明（声明 + 校验 + 执行后事件记录；实际结算由后续子项目消费）
3. 竞价 workflow 场景可用性：并行出价 → AND-join 评分 → 确定性选主/结算的 flow 可表达、可运行、可测试
4. 零破坏：既有 flow（v1/v2）行为不变，既有测试全绿

---

## 2. code 节点设计

### 2.1 Schema

```typescript
// NodeDef 扩展
type: "agent" | "human" | "code";

// code 节点专属字段
fn: string;            // 必填：已注册函数名（白名单注册表）
args?: string[];       // 可选：入参 = state 字段名列表（默认全部 state 传入）
writes?: Record<string, string>;  // 输出映射：{ stateField: "{{result.path}}" }（复用现有模板语义）
timeoutSec?: number;   // 可选：执行超时（同步调用，通常不需要）
```

```json
{
  "id": "score",
  "type": "code",
  "fn": "market.score",
  "args": ["bids", "params"],
  "writes": { "winner": "{{result.winner}}", "round": "{{increment:state.round}}" }
}
```

### 2.2 函数注册表（FlowCodeRegistry）

- 注册：`registerCodeFn(name, fn)`——`fn: (args: Record<string, unknown>, ctx: CodeCtx) => unknown | Promise<unknown>`
  - `CodeCtx = { state, runId, nodeId, log }`（只读 state + 日志钩子）
- 解析：`resolveCodeFn(name)`——未注册 → 校验错误（flow 启动前 validateFlow 可查）
- **白名单安全**：flow 定义只能引用已注册函数名，**不支持内联代码/动态 require**——函数实现由宿主代码（pit 侧/扩展侧）注册
- 命名空间：`"market.score"` 点分命名，宿主按域注册（`market.*` / `metrics.*` / `util.*`）

### 2.3 执行语义

- **同进程同步调用**（不 spawn 子进程——确定性计算应轻量快速；agent 节点才 spawn）
- 纯函数约束（v1 强制）：**只读 state/args、只写返回值**；不碰文件系统/网络/随机数（`CodeCtx` 只暴露只读 state + 日志钩子，无 I/O 能力）——确定性、可重放；注册时声明函数性质，运行时按约束执行
- 结果写入：`writes` 映射走现有 state 写入管线（模板 + reducers 复用）
- 失败语义：抛错/超时 → 节点失败（与 agent 节点一致：`failed` 状态，可 resume；重跑时重放同输入——确定性保证重放结果一致）
- 并行：code 节点与其他就绪节点**同一批次执行**（findReadyNodes 不区分类型）；依赖关系由 edges/needs 表达（竞价：出价节点们 → 评分节点 `needs: ["bid1","bid2"]`）

### 2.4 确定性约束与审计

- 执行记录：节点结果入 checkpoint（复用现有机制）——恢复后重放同输入同输出
- 审计：code 节点执行记入 flow 事件流（与 agent 节点同级的事件类型，`node.code`）

---

## 3. metrics 字段设计（经济语义声明点）

### 3.1 Schema

```typescript
// NodeDef 扩展（可选，agent/human/code 三类节点均可声明）
metrics?: {
  credit?: Record<string, string>;   // credit 转移声明（模板可引用 state/result）
  elo?: Record<string, string>;      // elo 更新声明
  memory?: Record<string, string>;   // 记忆沉淀声明（指向规则条目/锚点）
  [domain: string]: unknown;         // 开放扩展（未来领域指标）
}
```

```json
{
  "id": "settle",
  "type": "code",
  "fn": "market.settle",
  "metrics": {
    "credit": { "from": "{{state.agentId}}", "amount": "{{result.delta}}", "reason": "settle" },
    "elo": { "agentId": "{{state.agentId}}", "delta": "{{result.eloDelta}}" }
  }
}
```

### 3.2 语义（v1 声明与记录，结算后置）

- **声明**：metrics 描述"节点执行后应发生的经济变化"——语义由消费者（子项目 D 的结算器 / E 的指标规则引擎）解释
- **校验**：validateFlow 校验 metrics 结构（字段为模板字符串、已知域）
- **事件记录**：节点完成时，运行时把 metrics 求值（模板替换 state/result）后作为**指标事件**写入 flow 事件流（`flow.node.metrics`，payload = 节点 id + 求值后的指标对象 + 关联 checkpointId）
- **不执行结算**：v1 运行时只声明 + 记录，不触碰 credit/elo/记忆（那些是 D/E 的域）——子项目 A 保持纯运行时扩展，无经济依赖
- **消费契约**：D/E 订阅 `flow.node.metrics` 事件执行真实结算（事件带 traceId/nodeId 溯源）

### 3.3 与记忆体系的关系（预留）

memory 域声明指向未来规则条目（子项目 B）——A 只做结构声明与传递，规则校验在 B 落地后由消费者执行。

---

## 4. 竞价 workflow 场景适配（验证用例）

```
竞价 workflow（表达力验证）：
  [task-arrive] (code: market.preprocess 任务规范化)
      │
      ▼
  [bid-1] [bid-2] [bid-3]  (agent: 角色 agent 出价，并行)
      └───────┴───────┘
              │ needs: [bid-1, bid-2, bid-3]（AND-join）
              ▼
  [score]  (code: market.score —— score = stake×w_stake + elo×w_elo)
      │
      ▼
  [select] (code: market.select —— 选主 + 冻结 credit 声明 metrics.credit)
      │
      ▼
  [execute] (agent: 中标 agent 执行)
      │
      ▼
  [settle] (code: market.settle —— stake×odds−tax + metrics.credit/elo/memory)
```

验证标准：
1. 并行出价正确执行（maxParallel 分批、结果不串扰）
2. AND-join 就绪语义（所有出价完成才评分）
3. code 节点确定性（同输入重放同输出）
4. metrics 事件正确记录（求值 + 溯源）
5. 失败恢复（某出价节点失败 → flow failed → resume 重跑该节点）

---

## 5. 兼容性

- NodeDef 扩展为可选项：`type` 新增 `"code"` 不破坏既有 agent/human 校验；`metrics` 可选字段旧 flow 无感
- v1 单步引擎（`runFlow`）不改——code 节点仅 v2 引擎支持；v1 遇到 code 节点 → 明确校验错误（"code nodes require v2 engine"）
- 既有测试全绿；新增测试独立文件

---

## 6. 测试策略

1. **schema/校验**：code 节点缺 fn / fn 未注册 / metrics 结构非法 → validateFlow 报错；合法定义通过
2. **注册表**：register/resolve/冲突（同名重注册）/命名空间
3. **执行语义**：code 节点同输入重放同输出（确定性）；writes 写入 state；args 子集传递；抛错 → failed 可 resume
4. **并行 + join**：竞价场景（3 出价并行 → 评分 join）——顺序正确、结果聚合
5. **metrics**：求值正确（模板替换）、事件记录（payload/溯源/checkpointId 关联）、旧 flow 无 metrics 无事件
6. **回归**：既有 flow 测试全绿（v1/v2 兼容）

---

## 7. 范围与非目标（YAGNI）

- ✅ code 节点（v2 引擎）+ FlowCodeRegistry + 确定性约束
- ✅ metrics 字段（声明/校验/求值/事件记录）
- ✅ 竞价 workflow 表达力验证（含测试）
- ⛔ 不实现真实结算/credit/elo（子项目 D）
- ⛔ 不实现记忆体系/规则条目（子项目 B）
- ⛔ 不做 code 节点的 I/O 能力（纯函数，后续按需扩展）
- ⛔ 不改 v1 引擎、不改既有节点语义、不改 flow CLI

---

## 8. 关键不变量

1. **code 节点确定性**：同输入同输出（纯函数 + 只读 state + 无 I/O）——重放/恢复结果一致
2. **白名单**：flow 只能引用已注册函数，无内联代码
3. **并行语义不回归**：code 节点融入既有就绪/分批机制，不引入新的调度路径
4. **metrics 只声明不执行**：运行时零经济依赖（不 import 结算/记忆模块）
5. **向后兼容**：旧 flow 行为不变、v1 引擎不动

---

## 9. 总结

pit-flow 运行时扩展为市场与社会结构铺路：code 节点把确定性经济计算（评分/选主/结算/汇率）纳入 flow 表达力；metrics 字段提供经济语义的声明点与事件化输出（消费方后置）；竞价 workflow 场景（并行出价 → AND-join 评分 → 确定性结算）作为验证用例证明表达力。纯运行时扩展，零经济依赖，向后兼容。
