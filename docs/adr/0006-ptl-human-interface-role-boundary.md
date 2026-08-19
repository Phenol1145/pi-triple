---
status: accepted
date: 2026-08-19
amends: 0005-pth-human-interaction-boundary
---

# human-interface 语义角色归 PTL，PTH 继续拥有规范协议与持久状态

背景：ADR-0005 正确地把 Human Interaction 的规范协议、约束校验、等待/恢复与持久状态留在 PTH，
并禁止 `human-interface` 进入 batch worker 池；但它仍把这个高交互语义角色定义在 PTH 内。后续对
真实权限面的复核表明，该角色需要连续读取用户界面语境、调整面向用户的表达、形成可展示稿件并触发
人类确认。把这些职责放进 PTH 内部角色会扩大系统内部的交互权限，也会让具体渠道与权威状态边界再次混淆。

决定：**`human-interface` 语义角色及其展示/成稿职责归 PTL。PTH 继续拥有 Human Interaction
规范协议、确定性约束、Review Policy、HumanRequest/Response、等待/恢复、审计和持久状态。**

PTL `human-interface` 可以产生 IntentProposal、TaskDraftProposal 与 PresentationProposal，并通过
PTH CLI 或公开协议提交；PTH 必须把这些内容当作不可信 proposal，重新绑定 tenant、stable principal、
目标 revision、effect 与 safety floor。PTL Operator Console、CLI、mailbox 和其他页面仍是 channel
adapters，不成为 PTH 状态源。人类签名的 Trust Policy 与 Approval Decision 仍按各自协议验证，不能由
`human-interface` 的普通文本或一次按钮点击替代。

不采用以下替代方案：不把 Human Interaction 数据库和恢复状态迁到 PTL；不让 PTL 直写 PTH 表；
不把 `human-interface` 恢复成 PTH batch worker；不向它授予 Task Lease、Execution Grant、Memory
official 晋升或任意系统控制能力；不把 PTL 重新定义成 PTH 前端。

**Consequences**：

- ADR-0005 关于 PTH 协议/状态所有权、稳定主体、CAS、事务 outbox 与 adapter 平权的决定继续有效；
- ADR-0005 关于“`human-interface` 是 PTH 内角色”的一句被本 ADR 取代；
- N25 的服务端状态机与协议继续作为 PTH 设计，但 role invocation 改为 PTL proposal adapter；
- PTH Runtime Catalog 不注册 `human-interface`，batch expansion 永远为零；
- PTL 需要独立限制该角色的页面、会话、签名和命令权限；浏览器仍不能持有 PTH 服务凭据；
- N33 PTL Operator Console 是首个具体 channel adapter，不等于完整 N25 协议已实施。
