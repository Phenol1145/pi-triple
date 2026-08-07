# Prime Agent Panel 交叉评审裁决汇总

- 日期：2026-08-07
- 参与：deepseek-v4-flash / deepseek-v4-pro / qwen3.8-max（各自出方案 + 互相交叉评审）
- 产物：proposal-*.md（3）+ cross-*.md（3）+ alignment.md + context.md
- 状态：交叉评审完成，待用户裁决采纳

## 一、三方一致共识（交叉评审后收敛）

1. **拒绝 agent 自主 /refine**（Factorio 教训）——固化必须过治理闸门
2. **拒绝完整 IPython/PTC 代码执行面**（非 sandbox 安全红线 + 零新依赖）
3. **拒绝普适 rlm() 持久子会话 + daemon**——"持久性的单位是任务，不是会话"（qwen 最锋利表述）；任务池六状态机 = 持久身份
4. **拒绝独立 L4 记忆层**——替代方案收敛为"独立薄表"（pro/qwen 形态）+ 会话生命周期
5. **refine 是任务不是权限**——经验固化复用任务池六状态机，被认领/被验收/被计费

## 二、逐条采纳建议（三方交叉裁决并集）

### A. 工作记忆（WM）
- **采纳**：pro 独立 WM 表（`working_state(task_id, key, value, expires_at)` 或会话绑定）+ 会话生命周期 + pro 的 wmKeys 可选 DSP 注入 + qwen 的 submit working_refs 晋升钩子
- **否决**：flash 的 L3 草稿复用（语义混槽，被双方挑战成功）；qwen 的 TTL 绑任务（牺牲分析者综合阶段——子任务完成即升级/丢弃，综合时无 RAM）
- **补丁**：WM 容量配额（flash 盲区补抓——每会话条数上限 + 超限淘汰）

### B. 持久 agent 会话
- **采纳**：qwen context_ref（append-only 转录档案，冷读续跑，claim_id 分隔）+ flash session_ref 句柄（resumeTask，best-effort 不参与状态机正确性）
- **否决**：pro execution_context 跨 agent 注入（与其自身 WM 会话生命周期矛盾）；常驻 daemon 后门（无数据不常驻，冷启动后测量"跨任务状态量/任务频率"再定）

### C. 工具面统一
- **采纳**：flash 批量操作表（op 白名单 claim/peek/reject/submit/list，逐条判别式，失败不中断）+ qwen 动词族收口（单入口，后续只加动词不加面）
- **否决**：pro 的 SQL DSL 原子事务（违反六状态机——无 submitted→claimed 回滚转移；或滑向图灵完备）；persistent Python 评估门（红线钉死）
- **缓行**：qwen 的经济闸门（押金/计费）——货币系统未落地前只做动词族不做计费

### D. 自改进
- **采纳**：qwen refine 模板任务 + 六状态机复用 + 评价指标不可自改硬编码 + 报酬挂钩下游指标；flash harness 不可被模型 CRUD + 奖惩只认验收者成果契约 + 策略与事实分离；pro 固化不自动生效 + anti-pattern 回溯验证 + 提案噪声阈值/冷却期
- **否决**：pro 分析者当评价器（激励冲突——评价者本身也是经济驱动的 agent）；qwen 低风险自动验收边界模糊（分级保留，高低风险边界由 operator 在模板注册时定死）
- **补丁**：验收者激励本身需审计（事件 + operator 抽查）；A/B 指标采集落点 = taskpool 事件聚合（completed 按 template_id）

### E. 其他
- **E1 转录存储 = P0 前置**（qwen 独有洞察，pro/flash 双双自认盲区）：`<task_id>.jsonl` append-only，格式 `{ts, claim_id, role, kind, payload}`，kind ∈ {msg, tool, ptl, decision}；必须在 B/D 任何功能之前
- **E2 selfGoal**（pro）：agent 注册周期性目标走 scheduled_jobs——边界需划清（与"主会话=组织者"关系），缓行

## 三、实施顺序（三方顺序交集）

```
P0: C 收口（批量操作表+动词族，无依赖收益最早） ∥ E1 转录存储（B/D 共同前置）
P1: A 工作记忆（独立表+会话生命周期+晋升钩子）
P1: B 档一（context_ref 转录 + session_ref 句柄）
P2: D refine 任务化（依赖 E1 转录 + C 工具面 + A 晋升钩子；治理先于自动化）
P3: E2 selfGoal；常驻角色（冷启动后测量）；经济闸门（货币系统就位后）
```

## 四、协调者待裁决项（三方未收敛）

1. **A 的生命周期载体**：会话（pro/flash 倾向，保分析者综合阶段）vs 任务（qwen，保 B 自洽）——评审后多数倾向会话 + working_refs 晋升钩子
2. **C 的执行语义**：逐条判别式失败不中断（flash/qwen）vs 原子批（pro）——多数倾向逐条，孤儿认领由回流轮兜底
3. **D 的触发者**：agent 观察草稿（flash）vs 记忆维护者扫描（pro）vs refine 模板任务分析者认领（qwen）——倾向 qwen 模板任务 + pro 扫描双源，套 pro 阈值/冷却
4. **经济闸门时点**：qwen 前置 vs flash/pro 缓行——多数倾向缓行（货币未落地）
5. **验收者激励审计**：三方都没解决，flash 补抓——需新裁决

## 五、评审质量备注

- 三份 cross-review 均落代码/裁决级（引用既有裁决、六状态机、记忆 spec）
- 交叉命中的真缺陷：pro 的自相矛盾（DSL 原子性 vs 六状态机、execution_context vs WM 生命周期）、qwen 的 A 落点（绑任务牺牲分析者）、flash 的 A 让渡（L3 草稿混槽）——三方各自的方案都被至少一方以具体机制击穿
- 共同盲区由 flash 补抓：验收者激励审计、A/B 指标采集落点、WM 容量配额
