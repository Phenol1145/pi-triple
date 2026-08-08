# 调试工具对 Coding Agent 效率研究参考会话记录（ChatGPT 分享）

> 日期：2026-08-09 · 类型：exploration（仅记录——设计输入已并入调试协议设计）
> 来源：https://chatgpt.com/share/6a77a77e-6df8-83e8-8333-dccee4540d53（gpt-5-5-mini，2026-08-08）
> 定位：调试工具扩展（协议层 Debug 能力）的价值论证 + 设计修正参考。

## 1. 会话核心结论

### 1.1 调试工具对 agent 的价值（研究共识）
```
调试工具的价值可能比单纯提高模型参数量更大——提供运行时状态反馈，降低错误定位熵：
  无调试：黑盒试错 O(N)（试一个→失败→再试）
  有调试：错误定位 O(logN)（运行一次→错误在模块 B→变量 x 异常）
```

### 1.2 Debug2Fix（实证）
```
agent + debugger → 部分 benchmark 提升 >20%
弱模型 + debugger 可达强模型水平——"tool design 可以抵消 model capability 差距"
（注：传统逐行 debugger 直接给 LLM 用 token 消耗巨大）
```

### 1.3 Agent-centric Debugging Interface（关键设计修正）
```
传统 debugger（面向人）：step line → inspect variable——逐行
面向 LLM 的高层接口：函数级执行轨迹——
  foo()
    input:  x=10
    output: y=20
    called: bar() → z became invalid
研究发现高层 debug interface 可提升 SWE-bench 类任务表现
```

### 1.4 Benchmark 视角
```
HumanEval 类简单任务：debugger 帮助有限（写函数→跑测试→通过/失败）
现实软件（百万行/复杂状态/隐藏 bug）：价值巨大
新 benchmark 方向：SWE-bench / Debug-gym（交互式 debugging 学习）
```

### 1.5 架构启示
```
agent runtime 不应只提供 execute(code)——应提供：
  compile() / run() / inspect_state() / trace() / breakpoint() / profile() / rollback()
= 把编程语言 runtime 暴露给 agent（下一代 coding agent 与 ChatGPT+terminal 的区别）

能力重要性排序：debugging ⭐⭐⭐⭐⭐ / runtime reasoning ⭐⭐⭐⭐⭐
（软件开发 70% 时间在理解已有系统 + 修改错误，非写新代码）
```

## 2. 对 PTH 调试协议设计的修正（用户裁决 2026-08-09）

```
① 两层结构：
   Layer 1（底层传输）：DAP（debugpy/dlv 现成适配器——逐行能力）
   Layer 2（agent-centric 高层）：函数级 trace / 状态摘要 / 错误定位——LLM 默认消费
   → 默认给高层；LLM 按需深挖才用逐行（token 保护）
② 工具面扩展（不止 breakpoint/step）：
   debug.trace（函数级轨迹——默认工具）/ debug.inspect（状态摘要）
   debug.breakpoint / step / stack / evaluate（逐行深挖——按需）
   v2：profile / rollback
③ 与 env.inspect 的关系：
   env.inspect = 执行前/后静态快照；debug 工具 = 执行时动态轨迹——同一"agent 感知解释器状态"方向
```

## 3. 结论（用户裁决 2026-08-09）

- 调试协议设计方向定稿：**DAP 底层传输 + agent-centric 高层接口两层**
- 工具面默认 trace/inspect（token 高效），逐行按需
- 落盘本 exploration 存档；详细设计见调试协议 SPEC（待写）
