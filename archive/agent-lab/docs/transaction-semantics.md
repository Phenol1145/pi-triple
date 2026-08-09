# 事务语义职责边界（agent-lab）

> **结论（2026-08-05 裁决）**：agent-lab 有**两套有意的、不同的事务机制**，不是债务、**不统一**。
> 新代码按本文档选择用哪一套。

## 两套机制

| | `repository.transaction` | `withSharedTransaction` |
|---|---|---|
| 位置 | `src/core/storage/repository.ts` | `src/core/tx-utils.ts` |
| 语义 | **拒绝嵌套**（单层防御） | **嵌套复用**（组合原子性） |
| 嵌套行为 | 主动抛 `nested core transaction is not supported` | 检测到已在事务 → 直接 `fn()` 复用同一事务 |
| 状态追踪 | 实例字段 `_inTransaction` | `WeakMap<DatabaseSync, boolean>`（按 db 实例） |
| 适用层 | core 服务层（control-plane/service 等） | 经济层 effect（apply_settlement 等跨存储组合） |

## 为什么有两套（不是债）

**SQLite 不支持嵌套事务**：第二个 `BEGIN IMMEDIATE` 抛 `cannot start a transaction within a transaction`。两套机制是对这一底层限制的**两种合理应对**，服务不同抽象层：

- **core `repository.transaction` = 单层防御**
  假设"一个 service 方法 = 一个事务"，无跨方法组合需求。拒绝嵌套是**有意防御**——防的是下面这个真实风险（见下节）。测试 `test/core-optimizer-storage.test.ts`（`transaction() still throws on nested transaction` / `unchanged`）证明这是设计选择而非疏忽。

- **经济层 `withSharedTransaction` = 组合原子性**（D2 Task 4 裁决）
  市场结算 effect（`apply_settlement`）要在一个整体事务里调用多个**各自带事务**的方法（`ledger.freeze` + `voucher.burn` + `ledger.debit` + …）。必须嵌套复用才能整体原子。协调器以 db 实例为键追踪事务状态，内层检测到已开启则复用。

## 嵌套的真实后果（为什么 core 选择拒绝）

允许嵌套复用有个**真实代价：内层吞异常 → 静默部分提交**：

```ts
withSharedTransaction(db, () => {
  insertA();                          // 成功
  withSharedTransaction(db, () => {   // 复用（不重复 BEGIN）
    insertB();                        // 抛错
  });                                 // ⚠️ 若调用方 catch 后不重抛 → B 静默丢失，A/C 仍提交
  insertC();
});
// 结果：A、C 提交，B 丢失 —— 破坏原子性但不报任何错
```

`withSharedTransaction` 的安全前提是**所有调用方都让异常传播**（经济层 effect 是这样写的）。core 的几十处 `repository.transaction` 调用点（control-plane/service.ts 等）未逐一审计异常传播——这正是**不强行统一**的原因：统一会把"内层吞异常"的风险面引入 core。

## 新代码指引

| 场景 | 用哪个 |
|---|---|
| **组合多个各自带事务的存储操作**为一个原子整体（如经济层 effect 跨 ledger/voucher/store） | `withSharedTransaction(db, fn)` |
| **单一高层 service 操作**，自含一个事务，不与外界组合 | `repository.transaction(fn)` |
| **一次性 schema 迁移**（构造期，无活跃事务） | 任一（等价）；agent-lab 内统一 `withSharedTransaction`（如 `ledger.ts` 迁移） |

**判断口诀**：需要"**套**"（组合多个事务性调用）→ 协调器；只需要"**一个**"（自含单层）→ repository。

## 不变量

- 同一 `DatabaseSync` 实例上，**不要混用两套机制嵌套**（repository 的 `_inTransaction` 与 tx-utils 的 WeakMap 互不知晓——混用嵌套会触发底层 `cannot start a transaction within a transaction`）。
- 经济层 effect 的统一入口 = `ledger.transaction()`（其内部就是 `withSharedTransaction`）——effect 代码经 ledger 进协调器，不直接调 tx-utils。

## 相关

- 协调器实现：`src/core/tx-utils.ts`（D2 Task 4 协调者裁决，原 `economy/tx-utils.ts`，Task 1 下沉 core）
- core 单层事务：`src/core/storage/repository.ts` `transaction()`
- ledger 复用版入口：`src/arena/ledger.ts` `transaction()`
