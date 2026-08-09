# PTH 兼容性扩展接口设计（v0.7）——声明式 manifest + 可引用代码库

> 2026-08-09 · v0.7 核心之一 · 用户思路：扩展生态用 memory/执行核可引用代码库形式实现
> （不建新机制——复用 toolstore/memory 现有通道）。事件面粒度细化（域×动作两维）。
> 参考：pi extension（ExtensionAPI/事件钩子）+ OpenClaw plugin（manifest contracts 声明式）。

## 0. 定位与原则

**PTH kernel 能力面的兼容性扩展接口**——第三方扩展接入 PTH 执行核（工具/能力/事件钩子）。
聚焦 kernel 层（执行核可引用——任务可用），不含 pi 会话扩展（TUI/命令——那是 PTL/pi 侧）。

**三原则**：
1. **不建新机制**：代码沉淀 toolstore（文件通道已有）+ 数据沉淀 memory（已有）——扩展 = 可引用代码库
2. **声明式 manifest**（借鉴 OpenClaw）：contracts 声明能力面——装载器自动装配
3. **事件面细化**（域×动作两维）：task/kernel/agent/worker/refine/resolver 六域，动作级粒度

## 1. 扩展包结构（toolstore 内）

```
toolstore/extensions/<id>/
  plugin.json       # manifest（声明式——借鉴 OpenClaw openclaw.plugin.json）
  index.ts          # 扩展工厂（导出 factory——返回 tools/capabilities/event handlers）
  lib/              # 辅助模块（可选——工厂 import 用——toolstore 内相对路径）
```

### manifest（plugin.json）

```json
{
  "id": "my-ext",
  "name": "My Extension",
  "version": "1.0.0",
  "description": "…",
  "contracts": {
    "tools": ["my_tool"],                          // LLM 可调工具（能力函数注入 ts 程序）
    "capabilities": ["my_capability"],             // ts 程序内能力函数（memory/c 同面）
    "events": ["task.execute.start", "kernel.acquire"]   // 事件订阅（域×动作）
  },
  "activation": { "onStartup": true, "lazy": false },
  "configSchema": { "type": "object", "additionalProperties": false },
  "compat": { "pluginApi": ">=0.7.0" }
}
```

## 2. 扩展工厂（index.ts——复用 eval 重放机制）

```ts
// toolstore/extensions/my-ext/index.ts
export default function factory(ctx: ExtContext) {
  return {
    tools: {
      my_tool: async (args, ctx) => ({ ok: true, result: "…" }),
    },
    capabilities: {
      my_capability: async (args) => "…",   // ts 程序内直接 await my_capability(...)
    },
    events: {
      "task.execute.start": async (event) => { /* 观察/副作用 */ },
      "kernel.acquire": async (event) => { /* … */ },
    },
  };
}
```

- **eval 重放**：toolstore 文件 → strip 类型 → vm 求值（复用 recall-functions 通道）
- **ExtContext**：受限上下文（能力白名单——memory/c/fs/llm——与任务代码同面）——**禁止**直接访问 pg/sandbox/进程

## 3. 事件面（细化——六域×动作）

### 事件命名规范：`<域>.<动作>`（域表 + 动作表正交）

| 域 | 事件动作 | 载荷 |
|----|---------|------|
| **task** | publish / route / claim / execute.start / execute.end / nl.translate / agent.step / result.register / submit / reject / escalate / claim.reap | taskId, role, status, durationMs, payload 摘要 |
| **kernel** | acquire / release / execute.start / execute.end / truncated / timeout / restart / snapshot / reset | kernelId, language, durationMs, ok |
| **compiled** | cache.hit / compile / evict / run | hash, cc, durationMs, cold |
| **agent** | llm.before / llm.after / action.parse / tool.before / tool.after / retry | taskId, step, model, tokens, durationMs |
| **worker** | pause / resume / remove / add | batchId, role, copies |
| **batch** | spawn / kill / scale.up / scale.down | batchId, workers, reason |
| **refine** | start / end / failed | taskId, durationMs, functionsCount |
| **memory** | write / recall | kind, anchors, hits |
| **resolver** | stage.advance / stage.fail | taskId, stage, flow |
| **debug** | attach / breakpoint.set / breakpoint.hit / detach | sessionId, line, frame |

### 事件语义
- **fire-and-forget**（异步 emit——不阻塞主链路；handler 失败仅记日志不影响主流程）
- **只读观察**（v1）：handler 接收事件载荷——返回忽略（不修改主流程）；副作用（写 memory/调能力）允许
- **白名单能力**：handler 内可用 memory/fs/llm（task/kernel 同源受限）——禁止递归触发同事件（防循环——emit 深度限 1）

## 4. PTH 独有的正交扩展面（角色谱系 / 新执行核 / 新调试核）

PTH 在工具/能力/事件之外，还有三个**独有扩展维度**（pi/OpenClaw 无对应概念）——
manifest contracts 分别覆盖：

### 4.1 角色谱系扩展（WorkerRole 注册）

**正交角色谱系的语义（用户补充——PTH 独有设计哲学）**：
1. **任务类型不重叠**：每个角色能接取的任务类型互斥——assigned_role 确定性路由已实现
   （candidates 只查自己队列——零竞速抢票——任务类型唯一归属）。
   **扩展新角色时 labelPatterns 必须与现有角色不重叠**——装载器校验（重叠拒绝）。
2. **memory 区域不重叠（尽可能）**：角色的记忆域隔离——per-role memory 命名空间
   （anchor 约定 `role:<role>` 前缀 + memory.query 自动按角色过滤——worker 默认只查自己的区域）。
   **跨区访问需显式权限**（如 memory-keeper 特许读全部——manifest capabilities 声明）。
3. **权限不重叠（尽可能）**：能力白名单按角色最小化——worker-cluster 角色定义加
   `capabilities` 白名单字段（如 scout 无 memory.write / developer 无任务路由权）——
   缺省全量（兼容）；扩展角色 manifest 声明（`roles[].capabilities`）。

### 4.1 角色谱系扩展（WorkerRole 注册）

PTH 的任务路由是**角色正交**（assigned_role → worker 队列）——谱系默认 7 角色（DEFAULT_ROLES）。
扩展可注册**新角色**（id/labelPatterns/prompt）——加入正交路由：

```json
"contracts": {
  "roles": [
    { "id": "data-scientist",
      "labelPatterns": ["data", "ml", "model"],
      "prompt": "你是数据科学家——负责数据分析、模型训练、统计推断。",
      "capabilities": ["memory.query", "c.execute", "fs"],       // 权限最小化（缺省全量）
      "memoryScope": "own" }                                     // own=仅自己区域 / all=跨区特许
  ]
}
```

- 装载：角色注册表合并（DEFAULT_ROLES + 扩展角色）→ routeTaskRole 的 roles 注入（已参数化）
- 构成：`PTH_WORKER_ROLES="data-scientist:2"` 可用扩展角色（权重体系天然兼容）
- 冲突：同 id 已存在 → 拒绝（防覆盖内置角色）
- **labelPatterns 重叠校验**：与现有角色模式重叠 → 拒绝（任务类型正交保证）
- **capabilities 白名单**：声明的能力子集注入该角色 worker（缺省全量——兼容）
- **memoryScope**：own=query 自动过滤 `role:<id>` 命名空间 / all=跨区（特许角色——memory-keeper 等）

### 4.2 新执行核扩展（kernel 类型注册）

PTH 的执行核是 Interpreter 接口（execute/reset/snapshot/dispose）——python/bash/ts/c 四类。
扩展可注册**新执行核**（新语言/自定义实现）——加入 kernel-manager 路由：

```json
"contracts": {
  "kernels": [
    { "language": "rust",
      "impl": "index.ts#RustKernel",
      "mode": "compiled" }
  ]
}
```

- 装载：eval 代码 → 实例化实现类（须实现 Interpreter 接口）→ kernel-manager.execute("rust") 路由扩展
- 沙箱语义：实现类内部决定（本地进程/sandbox 转发——扩展自证安全边界；默认要求 sandbox-kernel 模式——隔离与内置核一致）
- 能力面：`rust.execute(...)`（ts 程序内调用——与 python/bash/c 同面）

### 4.3 新调试核扩展（DebugSession 适配器注册）

PTH 的调试核是 DebugSession 接口（attach/breakpoint/continue/step/stack/variables/evaluate/detach）。
扩展可注册**新调试适配器**（新语言调试协议——Rust lldb 等）——加入 debug 路由：

```json
"contracts": {
  "debugAdapters": [
    { "language": "rust",
      "impl": "index.ts#RustDebugSession" }
  ]
}
```

- 装载：eval 代码 → 实现类注册 → /kernel/debug/attach 的 language 路由扩展（新语言调试）
- 协议面：须实现 DebugSession 接口（attach/breakpoint/continue/step/stack/variables/evaluate/detach）
- 事件：复用 debug.* 域（attach/breakpoint.set/hit/detach——新语言同语义）

### 4.4 三维扩展的统一原则
```
角色/kernel/debug 三个扩展面 = PTH 独有的正交维度（独立于工具/能力/事件）
装载统一：eval 重放 + contracts 注册 + 冲突拒绝（同 id/language 覆盖内置拒绝）
安全统一：sandbox 语义（执行/调试扩展默认要求隔离形态——与内置核一致）
```

## 5. 装载器（PTH 侧——ExtRegistry）

```
ExtRegistry（assembly 层——与 extensions/ 包并存）
  loadExtensions(toolstore):
    scan toolstore/extensions/*/plugin.json
    → 校验 manifest（compat/configSchema）
    → onStartup ? 装载（eval index.ts → factory(ExtContext)）
       : 懒装载（首次 contracts.tools 调用时）
    → 注册：
       tools        → capability 白名单扩展（ts 程序可调用 my_tool(...)）
       capabilities → 同上（合并进 capability 面）
       events       → 事件总线订阅（PTH emit 时分发）
```

### 权限分层
| 面 | 说明 |
|----|------|
| 扩展代码 | toolstore 白名单目录内（assertInside 已有） |
| 能力调用 | 白名单（memory/fs/llm/c——与任务代码同源） |
| 事件 handler | 只读载荷 + 白名单副作用（禁止递归同事件） |
| manifest 校验 | compat 版本 / configSchema / contracts 合法性 |

## 6. 与现有机制的关系

| 现有 | 扩展接口复用 |
|------|------------|
| toolstore（fs.readText + eval 重放） | 扩展代码装载（复用） |
| memory（tool-function 双通道 + state.recall） | 扩展数据/状态（复用） |
| 命名编译单元（c.saveUnit——toolstore） | 扩展的编译资产（复用） |
| capability 白名单（ts 程序注入） | 扩展 tools/capabilities 注入（复用） |
| kernel-metrics / obs | 事件载荷数据源（复用——obs.kernels/tasks 可查） |

## 7. 实施阶段

| Phase | 内容 | 验收 |
|-------|------|------|
| **P1** | 事件总线（PTH emit 六域事件——fire-and-forget + 白名单副作用） | 事件可订阅；handler 失败不影响主流程 |
| **P2** | manifest 规范 + ExtRegistry 装载器（toolstore 扫描 + contracts 注册） | 扩展包装载；tools/capabilities 可用 |
| **P3** | 权限分层 + compat 校验 + 递归防护 | 越权拒绝；递归触发阻断 |
| **P4** | 测试 + 示例扩展包（toolstore/extensions/hello-world） | 端到端：扩展工具 ts 程序可用 + 事件订阅触发 |

## 8. 待裁决点

| # | 点 | 建议 |
|---|----|------|
| 1 | 扩展代码形态：toolstore 文件（vs memory tool-function） | toolstore（manifest 伴生文件自然；memory 作状态） |
| 2 | 事件 handler 副作用范围 | 白名单（memory/fs/llm——禁止递归同事件） |
| 3 | 装载时机 | onStartup（batch 启动）+ lazy（首次引用）双模式 |
| 4 | compat 版本语义 | semver 比较（pluginApi 字段——低版本拒绝） |
| 5 | OpenClaw/pi 生态"兼容"程度 | 参考设计（不承诺二进制兼容——PTH 自面为主） |
