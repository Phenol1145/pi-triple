# PTL→PTH 任务提交指南

> 交互层（PTL 会话）如何把任务交给 PTH 任务内核执行——四种提交形态、生命周期、结果取回。

## 1. 总览

```
PTL 会话（本地）                      PTH（远端服务器）
──────────────────                   ──────────────────────────────
ptl hub kernel tasks add "描述"  ──→  tasks 表（pg）→ batch worker claim 执行
ptl hub kernel tasks add --template ─→  模板展开（templates 库）→ 同上
/pthtask publish（会话内命令）      ─→  同上
ptl hub submit <agent-dir>        ─→  ProgramStore → AgentEngine 一次性会话
ptl hub kernel tasks ls/status    ←──  任务状态/运行全景
curl GET /tasks/:id               ←──  任务详情（含 outputRef 结果）
```

**两条通道语义不同**：

| 通道 | 提交物 | 执行方式 | 结果 |
|------|--------|----------|------|
| **任务池**（`hub kernel tasks`） | 任务描述（文本/代码/模板参数） | batch 池化 worker（7 角色）认领执行，无人值守 | tasks 表持久（completed/rejected） |
| **程序桥**（`hub submit`） | agent 程序目录（manifest + skills + systemPrompt） | AgentEngine 一次性 session（流式） | SSE 流直推，session 即销毁 |

## 2. 前置配置

```bash
ptl config set pth.url  http://<pth-host>:3000
ptl config set pth.token <token>      # 与 PTH 服务端 auth:token 对应
ptl config show                        # 确认
```

未配置时命令会提示 `❌ 未配置 PTH 连接`。

## 3. 提交任务（任务池通道）

### 3.1 文本任务（自然语言描述——推荐入门）

batch worker 只能看到 `title` + `text`（+tags），**没有你的会话上下文**——描述必须自包含：

```bash
ptl hub kernel tasks add "背景：调查当前 PTH 生产任务池的健康状况
任务：用 obs.tasks 查看任务状态分布，用 obs.metrics 查看 pth_task 指标
验收：返回状态分布统计与异常发现
约束：只读调查，不修改任何数据" --tags research
```

关键要素（缺一不可）：
- **背景**：为什么做（worker 无上下文）
- **任务**：做什么（明确具体）
- **验收**：什么算完成（batch 据此判定 completed/rejected）
- **约束**：已知限制/可用工具

### 3.2 代码任务（直接给可执行代码）

`text` 直接放代码（PTH 按代码形态直执行，跳过 NL 翻译）：

```bash
ptl hub kernel tasks add "$(cat <<'EOF'
// ts 程序——PTC 模式：组合多 kernel 完成
const r = await python.execute("sum(range(101))");
registerResult("sum5050", r);
return { sum5050: r };
EOF
)" --tags code
```

- 代码任务用 `--tags code` 标记（NL 任务用 `--tags nl` 约定）
- ts 程序内可用能力：`python.execute`/`bash.execute`/`memory`/`context`/`model`/`perf`/`obs`/`fs`/`llm`/`web` + `registerResult`/`readObject`
- 返回值即任务结果（`outputRef.ref.value`）

### 3.3 模板任务（复用模板库）

```bash
ptl hub kernel templates ls                       # 看可用模板
ptl hub kernel tasks add --template recon-doc \
  --url https://example.com --anchors a,b --tags research
```

模板参数经 `--key value` 传入（`--template/--tags/--limit/--dry-run` 为保留 flag）。

### 3.4 会话内命令（等价）

pi 会话里用扩展命令（推荐 agent 使用）：

```
/pthtask publish 背景：… 任务：… 验收：…
/pthtask ls              # 任务列表
/pthtask status          # 运行状态全景
/pthtask batch add 2     # 扩容
```

## 4. 提交 agent 程序（程序桥通道）

把本地开发的 agent 程序（`agent.json` manifest + skills/ + systemPrompt）打包提交到 PTH 运行：

```bash
ptl hub submit ./my-agent [--dry-run]     # 打包上传
ptl hub run my-agent key=val              # 运行（SSE 流式直推）
```

- `--dry-run` 只打包不提交（检查 manifest/结构）
- 适合：需要完整 agent 程序（工具/技能/提示词）而非单任务描述的场景

## 5. 生命周期与状态

```
发布 → pending（待认领）→ claimed（执行中）→ submitted（已提交待验收）
                                                ↓
                                     completed（验收通过 ✅）
                                     rejected（验收失败——描述不清晰/验收不可达常见）
                                     escalated（升级待人工）
```

| status | 含义 | 处理 |
|--------|------|------|
| pending | 待认领 | 无 batch 时 `hub kernel batch add 1` |
| claimed | 执行中 | 等待；长任务看 claims_count |
| completed | 完成 ✅ | `GET /tasks/:id` 取 `payload.outputRef.ref.value` |
| rejected | 失败 | 查原因修正描述重发 |
| escalated | 升级 | 人工介入 |

## 6. 结果取回

```bash
ptl hub kernel tasks ls --limit 20      # 列表（id/status/title）
ptl hub kernel status                   # 运行全景（batches/tasks 分布/watchdog）

# 任务详情（含结果——outputRef.ref.value 为返回值）
curl -H "Authorization: Bearer <token>" http://<pth-host>:3000/api/v1/kernel/tasks/<id>
```

结果位于响应的 `payload.outputRef.ref.value`（JSONB）。示例：

```json
{ "id": "7039f7f8-…", "status": "completed",
  "payload": { "outputRef": { "ref": { "value": { "sum5050": 5050 } } } } }
```

## 7. 批控（吞吐管理）

```bash
ptl hub kernel batch add 2        # 扩容（任务积压时——14 worker/2 batch 等）
ptl hub kernel batch remove 1     # 缩容
```

- 池容量：sandbox kernel 池 `PTH_KERNEL_POOL_SIZE`（compose 默认 16 ≥ 并发 worker 数）
- 任务长期 pending 无 batch → `batch add 1`

## 8. 最佳实践

1. **小任务直接做**：立即要结果/依赖会话上下文/需用户澄清——不要发任务池
2. **描述自包含**：batch 无人值守——验收标准是 completed/rejected 的唯一依据
3. **标签分类**：`research`/`code`/`nl`/`memory`——便于筛选与路由
4. **代码任务优先**：可程序化的任务用 ts 程序（确定性 + 快——3.3s/任务），NL 描述留给模糊需求
5. **轮询节奏**：任务完成典型 ~13s（含 agent 循环）——`tasks ls` 隔几秒查一次即可，无需高频
6. **结果持久**：completed 任务的 outputRef 长期保留——可作记忆/审计

## 9. 排障

| 现象 | 原因 | 处理 |
|------|------|------|
| `未配置 PTH 连接` | pth.url/token 未配 | `ptl config set pth.url/token` |
| HTTP 503 | kernel 未装配（pg 不可达） | 查 PTH 侧日志（DATABASE_URL） |
| 任务长期 pending | 无 batch / 池满 | `hub kernel batch add 1`；查 `status` 的 watchdog |
| 任务 rejected | 描述不清/验收不可达 | `GET /tasks/:id` 看 payload 原因，修正重发 |
| `PTH_TOKEN 未配置`（会话内） | 会话 env 缺 token | 配置后重开会话 |

## 10. 相关

- Skill：`pth-tasks`（pi 会话内 `/pthtask` 全套 + 任务描述写法）
- PTH 侧：`docs/pth/kernel.md`（任务池/REPL/记忆闭环）· `docs/superpowers/specs/2026-08-08-pth-task-resolver-design.md`（任务链 payload.flow）
- 桥实现：`packages/framework/src/bridge/{kernel,submit,client}.ts`
