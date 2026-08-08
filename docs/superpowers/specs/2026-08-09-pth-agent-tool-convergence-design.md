# Agent 工具面收敛设计总结（元工具 + 能力函数双层）

> 日期：2026-08-09 · 类型：design（讨论结晶——用户确认的终态设计）
> 关联：[LLM agent 执行设计](./2026-08-08-pth-llm-agent-execution-design.md) · [kernel sandbox 设计](./2026-08-08-pth-kernel-sandbox-design.md) · [环境生命周期设计](./2026-08-08-pth-environment-lifecycle-design.md)

## 1. 终态结构：元工具 + 能力函数双层

```
动作工具（agent 直接输出的动作——白名单）：
  ts            程序模式（PTC 主形态）
  python.execute  单 kernel 快捷（保留——简单步骤省程序壳）
  bash.execute    单 kernel 快捷（保留）
  done          终止信号
  （未来：每加一种语言 kernel = 加一个元工具，如 sql.execute / ruby.execute……）

能力函数（ts 程序内注入——capability 白名单，非独立动作工具）：
  memory.query / memory.write         记忆（SQL 只读 + 封装写入）
  context.read / context.write        任务上下文工作台（KV）
  llm.complete                        子 LLM
  web.fetchText / fs.readText / fs.list
  python.execute / bash.execute       REPL 通道（程序内也可调）

用户裁决：
  - 元工具三件套保留（py/bash 快捷不收敛进 ts）
  - 多语言 kernel 扩展路径明确（元工具随语言增长，能力函数统一）
```

## 2. 六个设计点（本次讨论结晶）

### 2.1 环境感知（inspect）——LLM 看 kernel 状态
```
现状盲区：LLM 不知 python 命名空间/ts vm context 里现有什么
设计：
  ① 静态注入：任务开始时 system prompt 带环境预置清单（PY_RUNTIME/toolstore/召回函数）
  ② env.inspect { lang? } 工具：kernel.snapshot() 的 LLM 友好版（变量名+类型/函数名+签名）
  ③ （v2）变更摘要：每步执行后轻量 introspection diff（PTH_AGENT_ENV_DIFF 开关）
分层：inspect = 任务内 RAM 视图；state.recall = 持久层视图
```

### 2.2 输出模式可编程（mode）——LLM 控制感知带宽
```
现状：Observation 协议固定五件套 + 统一截断
设计：
  ① 工具 args mode 枚举：default / value-only / errors-only / quiet
  ② 程序内指令 __output__ = { mode?, preview?, extract? }（PyKernel/vm 执行后读取）
  ③ （v2）动态 schema 提取
收益：大数据集 value-only 省 token 50-80%；errors-only 快速试错；quiet 状态准备不污染轨迹
```

### 2.3 context 可编程——LLM 管理上下文数据
```
现状：即时 context（toolTrail）append-only——LLM 只能看不能管
设计：context.write {key,value} / context.read {key} / context.mark {id,note} / （v2）context.summarize
分层：context（任务内工作台，即失）→ 任务尾可选升级 memory（跨任务持久）
```

### 2.4 记忆收敛——memory.sql
```
已落地（commit 7e38f38）：查询工具 3→1（recallFunctions/recallInsights/memory.retrieve 移除）
memory.sql { sql }：只读 SELECT/单条语句/强制 LIMIT（50，上限 200）/错误回填修正
memory.write 保留封装（防 LLM 写坏数据）
表范围：全表只读（tasks/transcripts/audit 可见——LLM 可查任务状态）
待办：禁止 pg_catalog/pg_* 系统表探测；batch 侧执行器接线
```

### 2.5 工具联动——程序内一体化（无需跨工具传值）
```
场景：memory.sql 结果 → context.write → 后续使用
终态答案：程序内直接完成（能力函数同上下文）：
  const rows = await memory.query(...)
  await context.write({ key: "funcs", value: rows })   ← 对象直传，零文本往返
补充（跨程序/引用场景）：结果注册表（result_N 自动存，ref 引用）为 v2
```

### 2.6 ts kernel 位置与能力桥
```
现状裁决：ts vm 在 PTH 侧（能力本地注入——零延迟）
矛盾澄清：若 ts 也迁 sandbox → 需能力桥（上行协议：sandbox→PTH 能力调用，
          共享密钥认证 + 白名单端点；PLATFORM_URL 已注入 sandbox）
安全等价性：能力滥用面等价（白名单是真实边界）；架构 2 物理隔离更强
结论：位置保持架构 1（PTH 侧）；能力桥协议预留（不实现）
```

## 3. 数据世界访问金字塔（确认）

```
agent（LLM）      memory.sql（只读 SQL，全表可见）
任务代码（vm）    memory.write/retrieve 封装（无裸 SQL）
REPL kernel       ❌ 完全隔离（sandbox 无网络无凭据——py/bash）
                  ts vm 无 process/net（PTH 侧语言沙箱）
裁决：kernel 不开 pg 通道（sandbox 零凭据边界保持）；
      任务代码要数据走封装 API
```

## 4. 待落地清单（按序）

```
① 能力函数进 vm（终态核心）：
   - memory.query（与 memory.sql 同源受限执行器）+ context.read/write 注入 capability
   - ts 程序 API 文档进 system prompt（参数/返回/示例）
   - AGENT_TOOLS 收缩：移除 llm.complete/web.fetchText/fs.readText/fs.list/memory.sql/memory.write
     （保留 ts/python.execute/bash.execute/done）
② env.inspect 工具 + 静态环境注入（2.1）
③ 输出模式 mode 枚举 + __output__ 协议（2.2）
④ context 工具组（2.3）——能力函数形态（程序内 await context.read）
⑤ memory.sql 执行器接线（batch 注入 ctx.sql）+ pg_catalog 禁令 + 集成测试
⑥ 白名单/解析/测试更新（旧工具用例移除）
```

## 5. 与多语言 kernel 扩展的关系

```
元工具表 = 已装 kernel 语言的直接操作面：
  ts / python.execute / bash.execute / （未来）sql.execute / ruby.execute ...
能力函数 = 语言无关的统一能力面（memory/context/llm/web/fs）
→ 新语言 kernel 只需：实现 Interpreter 接口 + 注册元工具 + 描述
  （sandbox 化由 kernel-host 池统一承载——见 kernel sandbox SPEC）
```
