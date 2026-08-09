# PTL 代码审计：复用率/模块化 + 会话服务抽象准备（tmux → 终端复用器）

> 2026-08-09 · 前置：用户计划将会话服务从 tmux 抽象为可切换后端（zellij/screen 等）。
> 本文 = 现状审计（复用率/模块化/迁移面）+ 会话服务抽象设计提案。

## 1. 规模与依赖

| 项 | 值 |
|----|----|
| packages/framework（PTL 交互层） | 62 文件 ≈ 9.9k 行 |
| packages/shared（基础件） | 12 文件 |
| framework → shared 依赖 | 23 文件引用（健康） |
| shared → framework 反向依赖 | **0**（依赖方向干净 ✓） |

**依赖方向健康**：shared 是纯基础件（config/tmux/registry/paths），framework 消费。无反向、无循环。

## 2. tmux 抽象现状（会话服务迁移面）

### 已有抽象层：`packages/shared/src/tmux.ts`（14 个 API）

```
hasTmux / configureTmuxServer / tmuxSessionName / validateSessionName /
formatAge / listPtlSessions / listPtlPanes / listPtlPanesDetailed /
sessionsForTenant / hasPtlSession / killPtlSession / getPanePid /
buildTmuxSessionArgs / startPtlSession
```

被 4 文件复用：`cli/sessions.ts` / `commands.ts` / `cli/agent.ts` / `session/pi-scan.ts`。

### 抽象缺口：14 处直接 `spawnSync("tmux", …)` 泄漏

| 文件 | 处数 | 泄漏的原语 |
|------|------|-----------|
| `cli/sessions.ts` | **12** | has-session（×4）/ attach（×3）/ switch-client（×2）/ detach-client / buildTmuxSessionArgs 使用 |
| `cli/agent.ts` | 1 | send-keys（向会话注入按键） |

**缺失封装的 tmux 原语**：`attach` / `switch-client` / `detach-client` / `has-session` / `send-keys`——核心交互操作全部散在命令层，`tmux.ts` 只封装了列表/启动/停止。

### 前缀与终端概念硬编码

- `ptl-` 前缀：`tmux.ts`（命名函数）+ `session/pi-scan.ts`（扫描匹配 `n === ptl-${id}`）**双处硬编码**
- 终端特定提示：`Ctrl+B s` / `Ctrl+B d`（sessions.ts 文案——zellij 是 `Ctrl+o` 体系）
- `switch-client` / `detach-client` 语义本身是 tmux 方言（zellij：`zellij action switch-session`）

### 迁移面结论

当前从 tmux → 其他复用器需改动：**14 处 spawnSync + 2 处前缀 + 提示文案**——风险点在命令层（sessions.ts 直接调 tmux），不在抽象层。

## 3. 模块化审计：会话命令三套并行实现

| 层 | 文件 | 形态 | 服务对象 |
|----|------|------|---------|
| CLI 命令 | `cli/sessions.ts`（cmd* 8 个） | 直接 console + spawnSync | 终端 CLI |
| exec 命令 | `commands.ts`（execLs/execStop/execStartBg） | CommandResult 形态 | TUI/API |
| dispatch | `commands/session.ts` + `dispatch.ts` | attach/stop **handoff 回 `ptl attach`** | 命令路由 |

**问题**：同一会话操作（start/attach/stop）存在 CLI 实现 + exec 实现双份——`cmdStartBg` 与 `execStartBg` 各自 spawnSync tmux。操作层（会话原语）未从命令层（打印/参数）分离。

**复用率评估**：tmux.ts 的 14 API 复用良好（4 文件）——但**原语不全**导致命令层各自补 spawnSync——**不是复用率低，是抽象边界不全**。

## 4. 会话服务抽象设计提案（SessionBackend）

与容器抽象（`containers/backend.ts`——getBackend(kind) 模式）**同构**——架构一致性：

```
packages/shared/src/session-backend.ts（新——基础件层）
interface SessionBackend {
  readonly kind: "tmux" | "zellij" | "screen";
  available(): boolean;                 // 终端复用器可达
  create(opts: { name; cmd; detached }): void;
  has(name: string): boolean;
  attach(name: string): void;           // 前台接入
  switchTo(name: string): void;         // 瞬移（复用器内）
  detach(): void;                       // 当前会话脱离
  kill(name: string): boolean;
  list(): PtlSession[];                 // 复用器会话（前缀收敛进实现）
  panePid(name: string): number | null; // 会话内进程 pid（状态机判定）
  sendKeys(name: string, keys: string): void;  // agent.ts 注入
  hintText(): string;                   // 终端特定提示（Ctrl+B / Ctrl+o）
  sessionName(name: string): string;    // 前缀规则（ptl- 是 tmux 实现细节）
}

tmux 实现（收敛 tmux.ts 全部 + sessions.ts/agent.ts 的 14 处 spawnSync）
zellij / screen 实现（扩展点——后续新增）
getSessionBackend(kind): SessionBackend   // 工厂（对齐 getBackend）
```

**迁移步骤**（后续实现时）：
1. `session-backend.ts` 接口 + `tmux-backend.ts`（从 tmux.ts + sessions.ts/agent.ts 收敛全部原语——行为不变）
2. sessions.ts/commands.ts/agent.ts/pi-scan.ts 改走 backend（删 14 处直接 spawnSync + 前缀硬编码）
3. `ptl config set session.backend zellij` → 切换后端（命令层零改动——经 backend 接口）
4. pi-scan 的 tmux 匹配改走 `backend.list()`（前缀收敛进实现）
5. 测试：现有 14 个会话相关测试文件（tmux.test/session-state/pi-scan/session-cmd…）作为回归基线——tmux 实现行为不变即绿

## 5. 审计结论

| 维度 | 评分 | 说明 |
|------|------|------|
| 依赖方向 | ✅ 健康 | shared ← framework 单向；无循环 |
| 复用率 | ⚠️ 中 | tmux.ts 14 API 复用良好，但原语不全（attach/switch/detach/send-keys 泄漏） |
| 模块化 | ⚠️ 中 | 会话命令三套并行（cmd/exec/dispatch）——操作层未提炼 |
| 测试基线 | ✅ 良好 | 14 个会话相关测试文件——抽象重构有兜底 |
| 迁移面 | ⚠️ 可控 | 14 处 spawnSync + 2 处前缀 + 提示文案——SessionBackend 收敛后归零 |

**核心建议**：会话服务抽象（SessionBackend）复用容器抽象的 getBackend 模式——同构、低风险（测试基线在）、迁移面收敛。
