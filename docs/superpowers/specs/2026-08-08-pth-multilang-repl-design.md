# PTH 多语言持久 REPL 层设计草案（LLM↔计算机交互最终形态）

> 状态：SPEC v1.0 —— 已裁决（2026-08-08：多语言持久 REPL + Observation 协议 + per-worker kernel + 纯 stdlib runtime）
> 日期：2026-08-08
> 愿景（用户）：REPL 是 LLM 与计算机交互的最终形态；不同语言在不同领域有长处；方案需在保证性能的同时兼容不同工具链。
> 关联：docs/superpowers/specs/2026-08-08-pth-interpreter-persistence-design.md（持久化层——本草案的执行器底座）

## 1. 问题

### 1.1 现状：三解释器 = 三种交互模型

| 解释器 | 交互模型 | 状态 | 性能 | 工具链 |
|---|---|---|---|---|
| TS | node:vm 持久 context（类 kernel ✅） | 进程内持久 | 快（内存） | Node 生态 |
| Python | **每次 spawn 新进程** | 无状态 | **慢（实测 12ms/次）** | Python 生态（numpy/pandas...）|
| Bash | 每次 exec 新会话 | 无状态（cwd 不保留） | 中 | 系统命令 |

**矛盾**：LLM 要跟"计算机"交互——但当前 python/bash 是无状态瞬执行（每次重来），无法承载"多轮、有状态、跨步骤"的 REPL 式交互。

### 1.2 目标

1. **多语言持久 REPL**：每个语言一个**常驻运行时**，LLM 以 cell 方式交互（执行→结果→再执行），状态保留
2. **性能**：持久进程零启动开销（实测 230x）
3. **工具链兼容**：TS（Node 生态）/ Python（科学计算）/ Bash（系统）各取所长，统一抽象
4. **与持久化层协同**：REPL 状态可快照（snapshot）→ refine 持久化（记忆表/文件）→ 跨任务召回
5. **Observation 协议（ReAct 关键环）**：输出统一结构化（value/stdout/stderr/error/truncated）、可定制（ExecuteOptions/@output）、有界（截断防 token 爆炸）、可回流（多步执行注入 _obs）——LLM 决策依据质量可控

## 1.3 Observation 现状缺口（本轮补充）

| 缺口 | 现状 | 方案 |
|---|---|---|
| Python 无返回值通道 | 只有 stdout（print 文本） | `_result` 约定 → Observation.value（§2.4.2） |
| 输出不可定制 | ExecuteOptions 无输出控制 | maxStdout/structured/maxValueChars（§2.4.3） |
| 无截断策略 | stdout 可能几 MB（token 爆炸） | 硬上限 + truncated 标记（§2.4.4） |
| Observation 不回流 | 只进 transcripts 归档 | 多步注入 _obs（§2.4.5） |

## 2. 核心设计：Kernel Manager（多语言 REPL 路由层）

```
LLM（任务代码 / 交互会话）
  │  统一接口：execute(program, {language?, cwd?, timeoutMs?})
  ▼
KernelManager（路由层）
  ├── tsKernel     —— node:vm 持久 context（已有，保持）
  ├── pyKernel     —— Python 常驻进程 + 管道 JSON-RPC（新增，替换每次 spawn）
  ├── bashKernel   —— Bash 常驻会话 + 管道协议（新增，替换每次 exec）
  │
  ▼
各语言工具链（生态各取所长）
```

### 2.1 Python Kernel（管道 JSON-RPC，零新依赖）

```
持久进程：spawn python3 -u（stdin/stdout 管道）
协议：每行 JSON {code, cwd?} → {ok, result, stdout?, error?}
状态：exec(code, globals())——共享命名空间，变量/函数跨 cell 保留
实测：0.1ms/cell vs 12ms/spawn（230x）；x=10 → x*2=20 状态保留 ✅
```

```ts
// py-kernel.ts
class PyKernel {
  private child: ChildProcess;
  private queue: Array<(msg) => void>;
  constructor() { this.child = spawn("python3", ["-u", "-c", RUNTIME]); ... }
  async execute(code: string, opts?): Promise<InterpreterResult> {
    // 单行 JSON 请求/响应；超时守卫（对齐 TS 异步守卫）
  }
  reset() { /* 重启进程（清命名空间） */ }
  snapshot() { /* 见 §3 */ }
}
```

### 2.2 Bash Kernel（持久会话）

```
持久进程：spawn bash -i（交互模式）
状态：cwd/环境变量跨命令保留（cd /tmp 后 pwd 记住）
协议：stdin 写命令 + 结束标记（echo __DONE__$?）+ stdout 捕获
```

### 2.3 TS Kernel（已有，保持）

node:vm 持久 context 已是 REPL 形态——`state.export` 注册机制（持久化层 P4）补上"LLM 显式导出"能力。

### 2.4 Observation 协议（ReAct 的 Observation 通道）★核心

REPL 输出 = ReAct 模式的 Observation——LLM 下一轮决策的唯一依据。输出形态必须：结构化、有界、可定制。

#### 2.4.1 统一 Observation 结构

```ts
// kernel/types.ts（三 kernel 统一输出契约）
interface Observation {
  ok: boolean;
  // 结构化结果（主通道——LLM 决策依据）
  value?: unknown;            // TS: 表达式返回值；Python: _result 约定（§2.4.2）；Bash: 无
  // 文本输出（辅助通道）
  stdout?: string;            // 截断策略控制
  stderr?: string;
  error?: { message: string; stack?: string; code?: string };
  // 元信息（LLM 感知信息完整度）
  durationMs: number;
  language: string;
  truncated?: { field: "stdout" | "stderr" | "value"; originalLen: number; keptLen: number };
}
```

#### 2.4.2 Python 返回值通道（_result 约定）

当前 Python 只有 stdout（print），无结构化返回值——LLM 只能解析文本。
对齐 TS 的 return 语义：

```python
# 任务 cell：
_result = {"sum": 3, "meta": "computed"}   # → Observation.value = {sum:3, meta:computed}
# 未设 _result → value = undefined（与 TS 对齐）
```

```ts
// py-kernel runtime：执行后检查 globals()["_result"]，序列化进 value
const obs = await pyKernel.execute(code);
obs.value;  // { sum: 3, meta: "computed" }
```

#### 2.4.3 输出可定制（LLM/任务覆盖默认策略）

```ts
interface ExecuteOptions {  // 扩展（现有 timeoutMs/cwd/env）
  maxStdout?: number;        // stdout 截断上限（默认 2KB）
  maxStderr?: number;        // stderr 上限（默认 2KB）
  structured?: boolean;      // value 序列化（默认 true——JSON）
  maxValueChars?: number;    // value 序列化上限（默认 8KB）
  captureResult?: boolean;   // 捕获 _result/return（默认 true）
}
// 任务代码：
const obs = await python.execute(code, { maxStdout: 500, structured: true });
// 或任务 text 顶部声明全局策略（@output 指令）：
//   @output maxStdout=500 structured=true
```

#### 2.4.4 截断策略（Observation 有界性）

| 字段 | 默认上限 | 超限行为 |
|---|---|---|
| stdout | 2KB | 截断 + `truncated` 标记（LLM 知道信息不完整） |
| stderr | 2KB | 同左 |
| value | 8KB（JSON 化后） | 截断 + 标记；超 64KB 改为仅摘要 `{type:"too-large", size}` |

**截断必须带标记**——LLM 看到 `truncated` 才知道输出不完整，可决定重新执行（更小输出）而非误判。

#### 2.4.5 Observation 回流（ReAct 循环）

任务内多步执行时，每步 Observation 注入下一步上下文：

```ts
// 会话内累积（v1 任务内）：
// 执行器把上一步 obs 挂到 context（_obs 变量）：
const obs1 = await pyKernel.execute("x = 1");
const obs2 = await pyKernel.execute("_result = x + 1", { prevObs: obs1 });  // _obs 注入
// v2 会话间：REPL 会话的 Observation 历史作为 LLM 下一轮 prompt 的一部分（完整 ReAct）
```

#### 2.4.6 与转录/记忆的关系

```
Observation → ① 转录归档（transcripts.body——现状保留）
           → ② refine 提炼（快照 + LLM 筛选——持久化层）
           → ③ 作为下一轮 prompt 上下文（ReAct 循环——v2）
```

## 3. 状态快照（与持久化层协同）

Kernel 状态 → snapshot（复用持久化层草案）：
```
pyKernel.snapshot()  —— 遍历 globals()：可 JSON → variables；函数/类 → source（inspect.getsource）
bashKernel.snapshot() —— {cwd, env}（会话配置）
tsKernel.snapshot()  —— 已有设计（var/function 枚举 + 能力白名单排除）
```

→ refine 管线（LLM 筛选 → 持久化：记忆表/文件双通道）→ 跨任务召回。

## 4. 多语言 REPL 的 LLM 交互面

### 4.1 任务代码内的多语言调用（现有能力，强化）

```ts
// 任务 text（TS）——三种语言同池协作，Observation 统一消费：
const a = await python.execute("import numpy as np; _result = np.linalg.det([[1,2],[3,4]])");
// a.value = -2.0000000000000004（_result 通道，非 print 文本）
const b = await bash.execute("ls -la | head -5");
// b.stdout = 文件列表（截断 2KB 内）
const c = await ts.execute("1+1");
// c.value = 2

// Observation 作为下游输入（ReAct 语义）：
const det = a.value;                       // 结构化取用
if (!a.ok) { const fix = await python.execute("import numpy; _result = numpy.linalg.det([[1,2],[3,4]])"); }
```

### 4.2 交互会话（v2：人类/agent 可连的 REPL）

```
可选暴露：每个 kernel 一个端口/通道（如 sandbox 容器的 jupyter 基础）
→ 人类/agent 可观察、续跑 worker 的 REPL 状态（调试面，非生产持久化）
```

## 5. 性能与资源

| 项 | 现状 | 目标 |
|---|---|---|
| Python 执行 | 12ms/次（spawn） | 0.1ms/次（持久） |
| Bash 执行 | 每次新 shell | 持久会话（cwd/env 保留） |
| 内存 | 每次 spawn 峰值 | 常驻 1 进程/语言（可控） |
| 进程数 | batch × 7 worker × 语言 | batch × 7 worker × 1 kernel/语言（共享或 per-worker） |

**Kernel 归属**：per-batch 共享（7 worker 共用 1 个 pyKernel？）vs per-worker（隔离好但进程多）。v1：per-worker（隔离=任务安全），v2 优化共享。

## 6. 与现有体系的关系

| 组件 | 变更 |
|---|---|
| PythonInterpreter | **替换为 PyKernel**（持久管道）——接口不变（execute/reset/snapshot 新） |
| BashInterpreter | **替换为 BashKernel**（持久会话）——接口不变 |
| TsInterpreter | 保持 + state.export（P4） |
| Interpreter 抽象 | `snapshot()` 加入（持久化层已定） |
| TaskLoop | 不变（reset 语义 = 各 kernel 清状态） |
| 持久化层 | 直接消费 snapshot（不重复实现） |

## 7. 安全边界

1. **管道协议隔离**：JSON-RPC 只执行代码字符串（与现 spawn -c 同信任级）；不传任意对象（JSON 序列化）
2. **超时守卫**：py/bash kernel 均需异步超时（对齐 TS 的 Finding #1 守卫）——超时 kill 进程重启
3. **reset 语义**：任务间 `kernel.reset()` = pyKernel 重启 + bashKernel 重启 + tsKernel 重建 context——保持任务隔离
4. **snapshot 白名单**：不导出能力对象（同持久化层 §7）
5. **进程泄漏防护**：batch 退出 → 级联 kill kernels（unref + exit handler）
6. **Observation 有界性（防 DoS）**：截断是硬上限（stdout/stderr 2KB、value 8KB 默认）——巨量输出不会进 LLM context 或转录；截断带标记（LLM 感知不完整）
7. **_result 约定防误用**：`_result` 序列化失败（循环引用/不可 JSON）→ value=undefined + stderr 提示（不 crash kernel）

## 8. 测试策略

| 层 | 覆盖 |
|---|---|
| PyKernel 单元 | 状态保留（x=10→x*2=20）、超时 kill、错误回传（traceback→error）、reset 清态、**_result 通道（结构化 value）**、**截断（2KB 上限 + truncated 标记）** |
| BashKernel 单元 | cwd 保留（cd→pwd）、env 保留、错误码、reset |
| 性能回归 | 持久管道 < 1ms（vs spawn 阈值） |
| Observation 协议 | 三语言统一结构；截断边界（恰好上限/超限/超大 64KB→摘要）；结构化序列化失败降级 |
| 集成 | 任务内三语言协作（numpy 计算 + bash 查文件 + ts 逻辑）+ Observation 作为下游输入 |
| 持久化协同 | snapshot（py globals / bash cwd / ts context）→ refine → 召回 |

## 9. 实施路线

- **T1**：PyKernel（管道 JSON-RPC + 超时 + reset + **_result 返回值通道**）——替换 PythonInterpreter 实现，接口不变
- **T1b**：Observation 协议（统一结构 + 截断策略 + truncated 标记 + ExecuteOptions 扩展）——types.ts + 三 kernel 输出规范化
- **T2**：BashKernel（持久会话 + cwd/env 保留 + reset）
- **T3**：KernelManager 路由（language 参数 + 统一 execute + @output 全局策略解析）——TaskLoop/任务代码透明
- **T4**：三 kernel snapshot 实现（py globals 遍历 + bash session + ts 已有）——接持久化层
- **T5**：端到端实测——任务用三语言协作 + Observation 回流（_obs 注入）+ refine 沉淀 + 召回闭环
- **T6**（v2）：REPL 调试面（kernel 端口暴露/人类可连）、kernel 共享优化、toolstore 文件通道接入、会话级 ReAct 循环（Observation 历史入 prompt）

## 10. 开放问题

1. **Kernel 归属**：per-worker（隔离）vs per-batch 共享（资源省）？v1 建议 per-worker
2. **Python runtime 代码**：管道 RUNTIME 用纯 stdlib（exec 共享 globals）够吗？需要 IPython 增强（magic/%timeit）吗？（v1 纯 stdlib）
3. **Bash 协议**：结束标记法（echo __DONE__$?）vs 行式 JSON（bash 无法原生 JSON）？v1 结束标记
4. **python 包依赖**：工具链（numpy 等）按需 pip install 进 kernel 环境——谁来装？（v1 宿主环境已有；v2 任务代码可要求）
5. **与 xeus 的关系**：本方案 = 轻量自研（零 C++/ZMQ，管道协议）；xeus 作为 v2 可替换 py 内核的选项（如果需标准 Jupyter 协议）——是否保留这个升级路径？
6. **Observation 默认策略**：默认 maxStdout=2KB 是否合适？（小任务够；大数据任务需要显式调大——@output 指令）
7. **_obs 注入语义**：上一步 Observation 注入下一步 context——注入完整对象还是摘要？（v1 完整，v2 摘要+引用）
