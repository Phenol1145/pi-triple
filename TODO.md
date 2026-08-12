# backlog 全部完成 + 扩展库补充（2026-08-12，v0.10.0 后）

## 批 A：差距 7——obs.container（cgroup 容器级观测源）
- [ ] obs.ts 加 obs.container（cpu.max/memory.current/pids/usage——容器 cgroup 只读）
- [ ] 测试（白名单模板 + 容错——非容器环境降级）
- [ ] 容器验证（sandbox/pi-platform 容器内跑通）

## 批 B：差距 11——探索核候选列表（角色定义语言 A/B 并存）
- [ ] WorkerRole 加 exploreKernels 字段（候选列表——如 ["python","bash"]）
- [ ] 角色定义挂候选（reviewer 等）
- [ ] agent-loop/task-loop 接线（按候选语言建探索核——A/B 并存 + 探索空间按语言划分）
- [ ] 测试（候选解析/回退默认/维度生效）

## 批 C：差距 12——controller/sensor 任务源（trigger 生成观测/控制任务）
- [ ] trigger-engine 定时生成机制（sensor 观测任务 / controller 控制任务）
- [ ] 对接 optimizer 窗口/scorecard
- [ ] 测试（定时触发/角色路由/防风暴）

## 批 D：待决点可实现部分
- [ ] 振荡防护：死区（小偏差不动作）+ 增益上限 + 回滚记录
- [ ] deopt 语义：记入 maxAttempts 后人工确认（自动回滚基线 + 记录）
- [ ] 子 worker 创建入口：refiner 分化提案 → controller:worker-opt 批准通道（对接 lineage approve）

## 批 E：扩展库补充（toolstore/extensions 实用扩展）
- [ ] git 助手扩展（repo status/diff/log——developer 高频）
- [ ] web 检索扩展（http get 文档/页面检索）
- [ ] sql 只读查询扩展（白名单表）
- [ ] 测试 + 容器装载验证
