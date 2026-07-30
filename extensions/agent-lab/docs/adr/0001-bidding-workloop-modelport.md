# 竞价运行在框架原生 WorkLoop 上，而非 subagent 工具

Phase 3b 最初让 arena agent 通过 spawn 一个 pi-subagents subagent、由其调用 `place_bid` 工具来出价（"方案 B"）。Live 验证暴露：这把竞价耦合到了 pi-subagents 委托运行时——内置 subagent 有严格工具白名单、不含扩展工具，因而需要自定义 agent + 工具接线 + 委托总线，且 LLM 究竟会不会调工具是非确定的。

**决策**：竞价是一个单一职责、调度器级的 WorkLoop（`arena-bid-loop`），经框架的 ModelPort 调用候选模型、从响应解析 stake——与其它 managed WorkLoop 同一抽象。弃用 `place_bid` 工具扩展。执行保留 `pi-default-loop`（真实 subagent），那里才需要工具调用的通用性。

**理由**：竞价是简单、良定义的任务（context → stake）。框架 WorkLoop 抽象内的确定性 ModelPort 调用更轻、框架原生（仪器化、可 checkpoint、可投影），并避开 pi-subagents 依赖及其非确定性。这契合领域模型（见 CONTEXT.md）：Agent（状态存储）在不同阶段被不同转移函数驱动——竞价用竞价 WorkLoop，执行用其配置的 WorkLoop。

## Considered Options

- **`place_bid` 工具 + pi-default-loop subagent（方案 B）**：通用但重、且非确定；live 验证后否决（委托总线时机、agent 字段缺失、内置 agent 工具白名单、LLM 是否调工具皆成阻塞）。
- **裸 ModelCaller（3b 之前的路径）**：可用，但绕过 WorkLoop/ModelPort 抽象（无仪器化/checkpoint/投影）。
- **框架 ModelPort 竞价 WorkLoop（选定）**：抽象化、确定、不依赖 pi-subagents。

## Consequences

- `agent-lab-bidder` 扩展与 `place_bid` 工具不再用于竞价（代码可保留作它用或移除）。
- 竞价 WorkLoop 需经 `createInstrumentedModelPort` 为每个候选模型建 ModelPort；由调度器级调用（不经过 agent 的 `run` 语义）。
- 执行路径仍需为 arena agent 的 `pi-default-loop` 提供合法的委托 agent 名（如 worker）——这是执行侧的独立事项。
