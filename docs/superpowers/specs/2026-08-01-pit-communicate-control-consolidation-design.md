# pit-communicate / pit-control 整合设计

> 日期：2026-08-01
> 状态：已确认（用户逐节审阅通过）
> 范围：extensions/pit-communicate · extensions/pit-control · extensions/_shared（新增）

## 背景

两个内置扩展存在三类问题：

1. **tmux 会话管理职责重复且行为不一致**：`/pit start/stop/sessions`（pit-communicate 内）用 shell 字符串拼接 tmux 命令（违反平台"tmux 传参用 `-e` flag、禁 shell 拼接"硬约束），且不传模板环境变量；`/control start/stop/ls`（pit-control）用 `spawnSync` + `-e` flag 正确实现。两套命令看到的"会话宇宙"不同。
2. **会话身份隔离**：pit-communicate 有 registry/presence（在线/名称/模型），pit-control 完全不感知，`/pit ps` 与 `/control ls` 互相不知道对方。
3. **pit-control 无状态持久化**：`/control name` 只改内存，重启即丢。

前置任务（已完成）修复了平台机制：`resolveBundledDir`（bundled 扩展定位，发布/开发双布局）、`pit update --all` 真实可用、`pit-communicate` 补 `"type": "module"`、共享层与仓库零差异。

## 架构

```
extensions/_shared/                    ← 新增共享模块目录（"_"前缀 = 平台内部共享约定）
├── tmux-session.ts                   ← tmux 操作封装（runner 注入式，可测）
├── registry.ts                       ← 从 pit-communicate 迁入（会话注册表）
└── presence.ts                       ← 从 pit-communicate 迁入（心跳/在线状态）

extensions/pit-control/
└── index.ts                          ← import 共享模块；/control 命令面增强
extensions/pit-communicate/
└── index.ts                          ← 删除 registry/presence 副本与 tmux 三命令
```

**为什么 `_shared`**：`extensions/` 目录语义上不放非扩展代码，但：
- `promoteToShared` 已跳过 `_` 开头条目（`_` = 内部共享的既有平台约定，有旧 `_shared` symlink 先例）
- `syncBundledExtensions`（`pit update --all`）照常同步，零平台机制改动
- pi 扩展自动发现只匹配顶层 `*.ts` 与 `*/index.ts`；约束 `_shared/` 内**不放 index.ts** → 不会被误加载

**依赖方向**：`pit-control → _shared`，`pit-communicate → _shared`；`_shared` 零依赖（纯文件逻辑，无 pi API）。

**迁移方式**：registry.ts / presence.ts 原样移动（文件格式与路径不变，纯代码迁移），communicate 的 index.ts 改 import 路径。

## 身份与命名约定

| 名字 | 来源 | 可变性 |
|---|---|---|
| tmux 会话名 `pit-<x>` | `/control start [name]` 时定 | 不可变（tmux 引用依赖） |
| registry name | communicate 启动时定 | 可变（`/pit name`、`/control name`） |
| sessionId | pi 启动时生成 | 永不变 |

### tmux 会话名 `<x>` 的确定

- `/control start my-agent` → 固定名：tmux 会话 = `pit-my-agent`，`PI_SESSION_NAME=my-agent`
- `/control start`（无参数）→ 自动名：生成 `auto-<6位 base36 随机>`（如 `auto-x8k2p1`），tmux 会话 = `pit-auto-x8k2p1`；唯一性：`tmux has-session` 检查，冲突重试（最多 3 次，仍冲突则报错提示手输名字）
- 两道校验：唯一性（已有 `sessionExists`）+ 消毒（tmux 会话名禁 `.` 开头、禁 `:`；复用平台别名消毒正则 `[^a-zA-Z0-9_\-中文] → -`）

### sessionId 关联（启动后回写，零新文件）

sessionId 由 pi 启动时才生成，无法启动前传入，因此：

```
正向：新会话 pit-control 扩展加载时
  → 读 process.env.PI_SESSION_ID
  → tmux display-message -p '#{session_name}'   拿当前 tmux 会话名
  → tmux set-environment -t <会话名> PI_SESSION_ID <sessionId>   ← tmux session 级环境，随会话持久

反向：/control ls 时
  → tmux show-environment -t pit-<x> PI_SESSION_ID   拿 sessionId
  → 读 data/mailbox/{tenant}/{sessionId}/state.json   显示在线/模型/模式/名字
  → 查不到映射（新会话启动数秒窗口内）→ 降级为仅 tmux 基本信息，不报错
```

选型对比：映射文件方案（mailbox/{tenant}/tmux-map.json）引入并发写问题；registry 按 name 匹配会在 `/pit name` 改名后失配。tmux env 方案对改名免疫、零文件、无并发。

### name 持久化

- `/control name <y>`：更新共享 registry 条目（key=sessionId）+ presence state 的 name 字段 + 内存
- **presence 更新方式**：`_shared/presence.ts` 增加静态方法 `Presence.updateName(statePath, name)`（读-改-写原子，tmp+rename）——control 不实例化 Presence（避免第二个心跳循环双写 state.json），只做一次性静态写入；心跳仍由 communicate 的实例独占
- communicate 启动时 name 初始化顺序：`PI_SESSION_NAME env > registry 已有条目（同名 sessionId） > session-<id6>`——重启后从 registry 恢复旧名，向后兼容（无 env 无旧条目时行为同现状）

> **已知限制（updateName 与心跳竞态）**：`/control name` 通过静态 `updateName` 写 state.json 的 name 字段，但 communicate 的进程内心跳（10s）会用其内存中的 sessionName 快照重写该字段——若两者不一致，state.json 的 name 会在 10s 内被心跳覆盖回旧值。**权威源是 registry**（/control name 原子写 registry 条目，control 的 ls/status 显示也读 registry），state.json 的 name 仅作展示快照；重启会话后 communicate 从 registry 恢复名字而收敛。已知限制，接受。

## 命令面变化

### pit-communicate（删减）

- 删除 `/pit start`、`/pit stop`、`/pit sessions`（tmux 职责移交 control；顺带移除其 shell 拼接隐患）
- 保留 `/pit ps`（registry 视角）及 send/ask/share/broadcast/inbox/accept/reject/mode/name/status
- 帮助文本与 `getArgumentCompletions` 同步更新；帮助中提示"会话管理请用 /control"

### pit-control（增强）

| 命令 | 变化 |
|---|---|
| `start [name]` | name 可选 + 自动命名 + 消毒 + 传 `PI_SESSION_NAME`（连同既有 PI_CODING_AGENT_DIR/PI_TEMPLATE/AGENT_LAB_* 等 `-e` 变量） |
| `stop <name>` | 不变（共享模块实现） |
| `ls` | tmux 信息 + 在线状态/模型/模式/名字（tmux env 映射 + presence） |
| `switch` / `detach` | 不变（共享模块实现） |
| `attach` | 不变 |
| `name <y>` | 持久化（registry + presence + 内存） |
| `status` | 增强：registry 名字、tmux 会话名、在线状态 |
| `ui` | 不变 |

## 测试计划

| 测试 | 内容 |
|---|---|
| `test/unit/ext-shared-tmux.test.ts`（新） | tmux-session.ts 全逻辑，fake runner 注入（零真实 tmux）：`pit-` 过滤；startSession 参数组装与 `-e`/`-- pi`；消毒；自动命名与唯一性重试；stopSession `=` 精确匹配；switchTo/detach；tmux env 回写/读取封装 |
| `test/unit/intercom.test.ts`（改） | Registry/Presence 断言不变，import 路径改 `extensions/_shared/` |
| `test/unit/shared-layer.test.ts` | 不变 |

control 的 handler（TUI 交互层）不单测：tmux 逻辑已在共享模块层被 fake runner 覆盖，handler 只做参数转发。

## 兼容与风险

- **数据兼容**：registry.json / state.json / mailbox 格式与路径完全不变
- **向后兼容**：communicate name 初始化新顺序，无 env/旧条目时同现状
- **同步路径**：改仓库 → `pit update --all` → 模板 symlink 自动可见 → `/reload` 生效
- **跨扩展 import 依赖**：`pit-control → _shared` 依赖共享层 symlink 布局；若模板用同名真实目录覆盖 pit-control 而缺 `_shared`，扩展加载失败——bundled 同步保证 `_shared` 存在，文档化此依赖
- **pi 版本**：磁盘 0.83.0 / 当前会话 0.82.1；`/reload` 只重载扩展不换 pi 本体；所用 API 两版本均有
- **降级路径**：`/control ls` 无映射时降级为仅 tmux 信息

## 部署步骤

1. 仓库新增 `extensions/_shared/`（tmux-session.ts + 迁入 registry.ts/presence.ts）
2. 重构 `extensions/pit-control/index.ts`（import 共享模块 + 命令面增强）
3. 重构 `extensions/pit-communicate/index.ts`（删 registry/presence 副本与 tmux 三命令）
4. 新增/修改测试；`npm run build`（类型检查）；vitest 全绿
5. `pit update --all` 同步共享层；验证仓库=共享层零差异
6. `/reload`（或新会话）验证：/pit start 提示去 /control、/control start 自动命名、/control ls 在线状态、/control name 持久化
