# PTH 系统自持（v0.8）：PerfAutopilot 性能自愈闭环

> 2026-08-09 · 路线图 v0.8 第一块——监视 → 诊断 → 自动调节 → 复测验证（无需人工/agent 介入）

## 目标

现有：perf.set（运行时调参）+ descheduler（角色级扩缩）+ 四层指标（L0-L3 prom-client）。
缺口：**没有自动闭环**——指标异常需人工 perf.set/扩缩。

PerfAutopilot = 常驻自治循环：定期采样指标 → 规则诊断 → 自动调节（调参/扩缩）→ 复测验证（改善保持/恶化回滚）。

## 架构

```
┌─ PerfAutopilot（assembly 常驻循环）─────────────────────┐
│  interval 采样 → 窗口聚合（L1/L2/L3 指标）               │
│  → 规则表匹配（异常模式 → 动作建议）                     │
│  → 动作执行（perf.set / scaler.spawnReinforced）         │
│  → 复测（下窗口指标对比——改善保持 / 恶化回滚原值）       │
└──────────────────────────────────────────────────────────┘
  读：prom-client registry（与 /metrics 同源）
  写：ConfigCenter（perf.set 同源）· BatchScaler（扩缩）
  事件：订阅 task.* / kernel.*（batch 内就近 emit——可选增强）
```

## 规则表（v1——保守可回滚）

| # | 指标模式（窗口） | 诊断 | 自动动作 | 回滚 |
|---|-----------------|------|---------|------|
| R1 | pending 持续增长（taskPending 窗口对比 +30%）| 积压角色（countPendingByRole）| scaler.spawnReinforced（≤ cap）| 无（扩缩幂等）|
| R2 | LLM 延迟均值 > 30s（llm 直方图）| 模型慢 | perf.set PTH_AGENT_LLM_TIMEOUT_MS 60s→45s（快速失败防挂起）| 恢复原值 |
| R3 | kernel exec 失败率 > 20%（L1）| sandbox/编译问题 | 记录 + 事件 emit（不自动改参）| — |
| R4 | reject 率 > 30%（L2 taskStatus）| 执行失败集中 | 记录 reject-reason 分布（不自动改参——需人工）| — |

**保守原则**：可回滚动作（调参）才有自动执行；结构性诊断（R3/R4）只记录。
**防抖**：同规则窗口内不重复动作（调节后冷却窗口）；回滚后同窗口不重复调节。

## 参数

```
PTH_AUTOPILOT_MODE=on|off（默认 off——自愈是主动行为，显式开启）
PTH_AUTOPILOT_INTERVAL_MS=30000   # 循环周期
PTH_AUTOPILOT_WINDOW_MS=60000    # 诊断窗口
PTH_AUTOPILOT_REJECT_RATE=0.3    # R4 阈值
PTH_AUTOPILOT_EXEC_FAIL_RATE=0.2 # R3 阈值
PTH_AUTOPILOT_LLM_SLOW_MS=30000  # R2 阈值
PTH_AUTOPILOT_PENDING_GROWTH=1.3 # R1 增长比
PTH_AUTOPILOT_MAX_COPIES=4       # R1 单轮扩缩上限
```

## 复测验证

动作执行后：记录当前窗口基线 → 下窗口对比：
- 指标改善（pending 降/reject 降/llm 延迟降）→ 保持（日志 success）
- 恶化或无变化 → 回滚（perf.set 恢复原值；扩缩不回滚——幂等）

## 集成

- assembly 启动（PTH_AUTOPILOT_MODE=on）→ 创建 PerfAutopilot（注入 registry/config/scaler）→ start()（unref 定时器）
- 状态暴露：`/kernel/status` 加 autopilot（mode/窗口/lastAction/actions 历史）
- 日志：autopilot 动作（调节/回滚）记 kernel logger

## 测试

- 规则匹配（mock 指标窗口 → 期望动作）
- 回滚（动作后指标恶化 → 恢复原值）
- 防抖（同窗口不重复）
- 边界（off 模式不启动/指标缺失容错）
