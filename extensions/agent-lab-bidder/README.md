# agent-lab-bidder

> **@deprecated-for-bidding** — 自 ADR-0001 后，Arena 竞价不再通过 place_bid 工具执行。

## 现状

`place_bid` 工具曾用于 Arena 竞价：subagent 调用该工具将出价写入 `BidBoard`，scheduler
从 `BidBoard` 收集出价并决出 winner。

**自 ADR-0001 起，竞价路径已改为框架原生的 `arena-bid-loop` WorkLoop：**

1. Arena 竞价经 `arena-bid-loop` WorkLoop 运行（`workloops/arena-bid-loop.ts`）
2. 候选模型通过 `createMultiModelPort` 的 `ModelPort` 并行出价（框架 `complete`，无 subagent）
3. 出价结果直接回传 WorkLoop runner，不再经 `BidBoard`
4. `agent-lab` 的 `scheduler` 运行时通过 `workLoopBidder` port 调用 runner 收集出价

因此本扩展的 `place_bid` 工具**不再参与 Arena 竞价流程**。

**保留原因：** 本扩展代码保留不删除，以避免移除后破坏已部署扩展加载。`place_bid` 工具
可供未来其他需要 subagent 出价的场景使用（非 Arena 竞价）。

## 文件

- `index.ts` — 扩展入口，注册 `place_bid` 工具
