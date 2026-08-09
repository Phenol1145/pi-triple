# Subagent 模型使用策略（用户约定 2026-07-26）

**分级原则**：Qwen3.8 与 Kimi K3 智力可靠但价格高昂；DeepSeek V4 系列性价比高、速度快，适合绝大多数任务。

## 高阶模型（设计 / 复杂审查）

- `qwen-token-plan-cn/qwen3.8-max-preview`
- `moonshotai/kimi-k3`（或 kimi-coding provider 的 Kimi K3）

用于：
- 规划简报的对抗性复核（plan review）
- 整分支终审（whole-branch final review）
- 架构设计类任务

## 常规模型（实现 / 任务级审查 / 修复）

- `deepseek/deepseek-v4-pro:high` — Worker 实现、任务级代码审查
- `deepseek/deepseek-v4-flash:high` — 机械性修复波

## 调度注意

- 一律通过 `tasks[]` 数组路径派发（顶层单任务 model 字段会被用户 live Market 拦截器覆盖）。
- 不修改用户的 Market 配置（`~/.pi/agent/agent-lab/config.json`）。
