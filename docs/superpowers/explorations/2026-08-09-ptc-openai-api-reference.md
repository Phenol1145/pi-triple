# PTC 与 OpenAI API 参考会话记录（ChatGPT 分享）

> 日期：2026-08-09 · 类型：exploration（仅记录，非设计来源）
> 来源：https://chatgpt.com/share/6a778e93-86d0-83e8-859e-fa6e67058a99（gpt-5-5-mini，2026-08-08）
> 定位：外部参考会话——PTH 的 PTC 设计已独立落地（2026-08-09 P1），本文仅存档对照结论，
> 不作为新的设计输入（会话中多数点与 PTH 现状冗余，见 §3）。

## 1. 会话核心观点

### 1.1 PTC 定义
```
传统 Tool Calling：LLM → JSON tool call → 工具 → JSON → LLM（每步过模型）
PTC：LLM → 程序 → 程序调用工具 → 汇总结果 → LLM（一次编程控制多工具）
```

### 1.2 OpenAI API 兼容最小实现（会话方案）
```
① 保留 OpenAI function schema——不改 tool schema
② 增加一个 execute_code 工具（code execution tool）
③ 给 sandbox 注入 tool registry（tools.get_weather / tools.search_restaurant 等）
④ LLM 输出程序而非 JSON call
⑤ sandbox 执行程序
⑥ 只返回最终结果（减少 context 污染）
```

### 1.3 MCP 与 PTC 分层（不竞争）
```
MCP 解决：工具怎么描述和连接（Tool Protocol）
PTC 解决：工具怎么组合和执行
```

### 1.4 Agent OS 类比
```
LLM(用户空间) → Task Plan(系统调用) → PTC Runtime(kernel) → Tools(硬件)
交互会话（理解/规划/长期记忆）与执行会话（执行/工具/中间状态）分离
```

## 2. 会话中的 PTH 对照（原始记录）

| 会话设计点 | PTH 现状（2026-08-09） |
|-----------|------------------------|
| execute_code 单工具 + tool registry 注入 sandbox | P1 已落地——ts 工具 = code executor；capability 白名单 = tool registry（注入 vm） |
| 只返回最终结果 | 已对齐——回填 value+stdout（500 字符/步截断） |
| 交互/执行会话分离 | 已对齐——gateway（意图层）+ batch worker（执行层） |
| Task IR 中间层（Intent Agent 生成 Task IR） | 部分——任务 text + kind + payload（无显式 IR 结构） |
| MCP 接入（工具描述/连接标准化） | 未做——capability 内部注册（无 MCP client） |
| Agent OS 演进方向 | 分层架构天然对齐（意图层/执行层/kernel 池/tools） |

## 3. 结论（用户裁决 2026-08-09）

- 会话内容与 PTH 已落地方案**高度冗余**——仅作记录存档，不作为新的设计输入
- 不补进 PTH spec（§5 工具协议已覆盖 execute_code/tool registry/回填语义）
- 设计精力聚焦：**agent 操作解释器的具体行为**（LLM agent 循环对 REPL kernel 的实际操作细节）
