---
status: amended
date: 2026-08-18
amended_by: 0006-ptl-human-interface-role-boundary
---

# PTH 拥有 Human Interaction 协议，交互角色不进入 batch

> 2026-08-19 修订：协议与持久状态仍归 PTH；`human-interface` 语义角色及展示/成稿职责改归 PTL。
> 见 [ADR-0006](./0006-ptl-human-interface-role-boundary.md)。

背景：ADR-0001 已将 PTL 与 PTH 定义为独立产品，并取消“PTL 是 PTH 前端”的关系；此后
`human-interface` 被从 PTH worker 谱系移除，交互职责被笼统归给 PTL。这个处理混淆了
“哪个产品拥有自然语言交互语义”与“哪个界面承载用户输入”，也使 PTH 缺少可靠的提问、
确认、等待和恢复协议。

决定：**PTH 拥有 Human Interaction bounded context、规范协议和持久状态。**
`human-interface` 是 PTH 内按需调用的语义交互角色，负责提出意图候选、撰写 TaskDraft 和
调整面向用户的表达；它不是 batch worker，不认领普通任务，也不拥有持久状态或最终授权。
Human Interaction Service 负责校验、策略、状态迁移和审计；Task Control 继续独占任务状态。
PTH CLI 是规范交互通道，HTTP/SSE、未来 PTH Web、PTL bridge 和 mailbox 都只是平等的
channel adapters，不得成为身份、决定或恢复状态的真相源。

不采用以下替代方案：不把交互协议归给 PTL；不复活旧 WorkflowOrchestrator 作为权威状态机；
不把 `fallback_requests` 泛化为人类问答；不把 AgentEngine Session 当作 InteractionSession；
不把等待人类编码为 retryable reject 或普通 `pending` 任务。

**Consequences**：

- PTH 需要独立的 InteractionSession/Turn、Intent、TaskDraft、Review、HumanRequest/Response
  contract 与持久化模块。
- Runtime Catalog 必须区分 task worker、interaction agent 和 governance role；
  `human-interface` 为 on-demand、不可进入 batch pool。
- 人类决定必须绑定稳定 principal、租户、目标 revision 和策略快照，并通过 CAS 与事务 outbox
  驱动任务恢复。
- PTL/PTH 独立性保持不变：PTL 可调用 PTH，但不享有私有协议或特殊授权。
- 详细协议以 [N25 Human Interaction 设计](../pth/n25-human-interaction-protocol-design.md) 为准。
