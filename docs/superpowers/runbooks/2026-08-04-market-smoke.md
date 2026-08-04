# Runbook: 真实 LLM 市场冒烟（1 任务闭环）

> 经济层 D4 收敛计划 Task 3 交付。冒烟脚本：`extensions/agent-lab/examples/market-smoke.ts`。
> 验证对象：**1 任务市场闭环**（announce → 2 bidder → select → execute → 3 reviewer → consensus → settle → apply_settlement）+ 真实 LLM 执行（DeepSeek）。

## 目标

- **默认 mock 模式**：零额度验证装配与闭环正确性（资金守恒 + 任务 settled + 事件链齐全 + 无残留冻结）。
- **SMOKE_LLM=1**：execute 相位走**真实 DeepSeek 1 次调用**（最小额度）——验证真实 LLM 交付物进入市场闭环；bid/review 仍为确定性规则桩（零调用）。

## 前置

| 项 | 要求 |
|---|---|
| Node | ≥ 22.6（`node --experimental-strip-types`；本仓库实测 v24.14.1） |
| 依赖 | 零新增（node:sqlite 内存库 + 内建 fetch） |
| 凭据（仅 SMOKE_LLM=1 需要） | 任一即可：<br>① env `DEEPSEEK_API_KEY` 或 `PI_DEEPSEEK_API_KEY`（doctor.ts 契约 src/ptl/doctor.ts:239）<br>② `~/.pi/agent/auth.json` 的 `deepseek.key`（pi registry 实际凭据存储——脚本自动读取兜底） |
| 网络 | 可达 `https://api.deepseek.com`（需出网） |

## 运行

```bash
cd extensions/agent-lab

# ① mock 模式（零额度——默认，推荐 CI/本地自检）
node --experimental-strip-types examples/market-smoke.ts

# ② 真实 LLM 模式（1 次 DeepSeek 调用，最小额度）
SMOKE_LLM=1 node --experimental-strip-types examples/market-smoke.ts
# 或显式指定 key：SMOKE_LLM=1 DEEPSEEK_API_KEY=sk-... node ...
```

退出码：**0 = 全部断言 PASS**；1 = 任一断言 FAIL 或真实调用异常。

## 冒烟内容（确定性钉死）

| 相位 | 参与方 | 桩/真实 | 值 |
|---|---|---|---|
| announce | pub（balance 1000） | — | maxStake=20 odds=3 brief=“写一个两数之和函数（JavaScript）” |
| bid | w1 / w2（各 balance 200） | 规则桩 | stake 15 / 8（其余候选 0 → 不入场） |
| select | — | stake-elo-power | 最高 stake 15 → **w1 中标** |
| execute | w1 | **SMOKE_LLM=1：真实 DeepSeek**（deepseek-chat，temperature 0，max_tokens 300）<br>mock：确定性交付 | 交付物 = LLM 生成的两数之和函数代码 |
| review | r1 / r2 / r3（候选池内 w2 返回 NaN 不激活） | 规则桩 | score 0.8 / 0.85 / 0.9 |
| consensus | — | 中位数 | R = 0.85（3 评审） |
| settle / apply | 全量 | 真实 effect | 税 5%；elo 双写落库；escrow 划付 |

断言（8 项）：任务 settled / 中标者 w1 / execute 恰 1 次 / **资金守恒（Σ余额 Δ=0）** / 事件链 7 类齐全 / bid_freeze ×2 + bid_release ×1 / settle 事件 4 条（executor + 3 reviewer）/ 无残留冻结。

## 预期输出（mock 模式实测 2026-08-04）

```
market-smoke: 1 任务市场闭环（mode=mock（零额度））
── 闭环结果 ──
  taskId=2c7d8039-…  status=settled  winner=w1  winnerStake=15
  execute 调用次数=1（预期 1）
  LLM 交付物摘要（前 200 字符）：mock-deliverable;task=…;winner=w1;brief=…
── 余额（before → after）──
  w1           219.9        w2           200.0
  r1           208.6        r2           209.5
  r3           208.6        pub          951.0
  central-pool 2.5          operator     0.0
  Σ= 2000.000000  Δ=0.000000
── 事件流（18 条）──
  currency.tax ×4  economy.bid_freeze ×2  economy.bid_release ×1  economy.elo_update ×4
  economy.escrow_adjust ×1  economy.escrow_freeze ×1  economy.review_consensus ×1  economy.settle ×4
── 投影报表（事件重放重建）──
  poolBalance=2.4500  minted=0  burned=0  voucherStock={"llm":0,"time":0,"compute":0}
  reviewerAccuracy=[r2:1, r1:0.95, r3:0.95]
── 断言 ──
  [PASS] ×8（settled / w1 / execute 1 次 / 资金守恒 / 事件链 / bid 冻结解冻 / settle 4 条 / 无残留冻结）
```

SMOKE_LLM=1 成功时差异：`mode=REAL-LLM (SMOKE_LLM=1)`、交付物摘要 = DeepSeek 实际生成代码（前 200 字符）。

## 真实调用说明

- **每次运行仅 1 次 DeepSeek 调用**（execute 相位；temperature 0、max_tokens 300——token 消耗约 1K 内）。
- bid/review 为规则桩——**零 LLM 调用**，额度最小化且闭环数值可复现。
- 脚本不进 `test/*.test.ts` 套件（package.json `npm test` 只扫 test/——CI 不会误触真实调用）。

## 故障排查

| 症状 | 原因 | 处理 |
|---|---|---|
| `SMOKE_LLM=1 但未找到 DeepSeek 凭据` | env + auth.json 均无 key | `export DEEPSEEK_API_KEY=sk-...`（或写入 `~/.pi/agent/auth.json` 的 `deepseek.key`） |
| `DeepSeek API 401/403: …authentication_error` | key 无效/过期 | 换 key；`pi doctor` 检查凭据 |
| `DeepSeek API 429: …rate_limit / insufficient_quota` | 限流或额度耗尽 | 稍后重试；检查 DeepSeek 控制台余额；降级为 mock 模式验证闭环 |
| `DeepSeek API 5xx / 网络错误（ECONNREFUSED/ENOTFOUND/TIMEOUT）` | 服务端故障/断网/代理 | 检查网络与代理；重试；`curl https://api.deepseek.com/chat/completions` 直测 |
| 调用 >90s 无响应 | 超时（AbortSignal.timeout 90s） | 重试；确认出网稳定 |
| 断言 FAIL（非 401/429） | 装配/数值问题 | 保存完整输出，按事件流核对金额；报告协调者 |

## 相关

- 脚本：`extensions/agent-lab/examples/market-smoke.ts`
- 装配模式：`extensions/agent-lab/test/market-integration.test.ts`（mkEnv 同构）
- 运行器：`extensions/agent-lab/src/economy/market-runner.ts`（spawn* 注入点）
- 计划：`docs/superpowers/plans/2026-08-04-economy-convergence.md`（Task 3）
