# pi-triple framework 拆分设计（spec）

- **日期**：2026-08-07
- **状态**：设计（brainstorming 全裁决定稿，待用户审阅后进入分层 spec/plan）
- **定位**：PTL 单体拆分为"多项目 + 插件生态"的目标架构蓝图——framework 为承载一切的基础平台。
- **前序**：UX 审计（18 问题）+ pi 生态调研（无 ptl 同类）+ framework 草案（12+6 项裁决）。
- **草案**：`docs/superpowers/explorations/2026-08-07-framework-split-draft.md`（裁决全记录）
- **UX 审计**：`docs/superpowers/explorations/2026-08-07-framework-ux-audit.md`
- **生态调研**：`docs/superpowers/explorations/2026-08-07-pi-ecosystem-research.md`

---

## 1. 背景与动机

### 1.1 拆分动机

PTL（当前单体 CLI）承载了过多能力：会话管理/环境模板/工作流/PTH 桥接/追踪/TUI。用户裁决拆分为三个项目 + 插件生态：

```
PTL（当前单体）拆解
├─ ① pi-triple framework      承载一切的基础平台（会话/环境核心 + 扩展注入 + AI 接口）
├─ ② mail-box                 通讯工具（pit-communicate 独立化）
└─ ③ 容器开发扩展             在容器中开发扩展后端（通用 skill + extensions-in-container）
```

### 1.2 生态定位（调研结论）

pi 生态**无 ptl 同类**——多环境 framework 是空位。邻接项目：
- pi-dashboard（48★）= 会话 Web UI（不同层次）
- monopi（145★）= 配置包管理（方向相反）
- roach-pi（273★）= 多 agent 编排
- gastown（17,494★ Go）= 通用领域多 agent 编排（概念映射重合，技术栈不同）

**ptl 差异化** = pi 之上的"多环境 framework"（环境配方 + 统一会话 + AI 可编程 + 插件生态）。

### 1.3 设计动机

用户提出三个 AI 自主环境操作需求（环境分割/跨环境加载/provider 作用域），揭示 framework 需要"AI 可编程 + 环境语义"能力——不只是人用工具，而是**AI 能自主操作环境**的基础平台。

## 2. 概念层（template / session / agent 三分）

```
template（静态环境配方）──► session（运行时实例）
   │  model/skills/extensions/   │   tmux + pi 进程 + 纸带
   │  workLoop/instantiation     │   按 template 分组但各自独立
   │                             ▼
   └─► agent run（单发任务执行，无状态）
```

| 概念 | 定义 | 关键事实 |
|---|---|---|
| **template** | 环境的静态配方（TemplateConfig：alias/model/provider/skills/extensions/workLoop/instantiation） | 配方字段已存在但创建路径只用 alias——**需让配方真正生效** |
| **session** | 运行时实例（tmux + pi + 纸带 JSONL） | 会话文件按 template 分组（`sessions/<templateId>/`），每次启动唯一会话目录 → **多会话并存不冲突** |
| **agent** | 单发任务执行（`ptl agent run <template> <task>`） | 介于环境与会话之间，无状态 |

**会话发现语义（/resume 实测）**：
- `current folder`：当前 template + cwd 匹配的会话
- `all`：当前 session 目录全部会话——**环境内**，不跨 template

## 3. 拆分结构（Monorepo npm workspace）

```
pi-platform/（monorepo）
├─ packages/
│   ├─ @pi-triple/framework      ← framework 主包（ptl CLI + 会话/环境核心 + 插件宿主）
│   ├─ @pi-triple/shared         ← 共享代码（tmux/launcher/config/路径/日志）
│   ├─ mail-box                  ← 通讯插件（pit-communicate 独立化）
│   └─ extensions-in-container   ← 容器开发插件
├─ extensions/                   ← 现有扩展开（agent-lab 等，归 framework 扩展注入面）
└─ src/                          ← 现有 PTL/PTH 代码（渐进迁移）
```

**已裁决**：
| # | 决策 | 内容 |
|---|---|---|
| 1 | 仓库形态 | Monorepo npm workspace |
| 2 | framework 边界 | 承载一切的基础平台 |
| 3 | hub 归属 | 拆出归 PTH/独立 |
| 4 | 共享代码 | 提取 @pi-triple/shared |
| 5 | 扩展开归属 | 跟 framework（扩展注入面） |
| 6 | 容器开发 | 通用 skill + extensions-in-container 扩展 |
| 7 | CLI 命名 | 统一入口 ptl + 插件 |
| 8 | 插件形态 | 沿用 pi 扩展开机制（shared-layer 注入） |
| 9 | 体验优先级 | 全部按序（首次上手→日常效率→扩展管理） |
| 10 | provider 作用域 | 全局（面向个人开发者） |
| 11 | skill 加载 | 跟扩展机制 |
| 12 | 环境分割语义 | fresh + fork 双模式；fresh 无预设模板 |
| 13 | 跨环境扩展加载 | 基于 pi /reload 机制 |
| 14 | env 命令集 | 六命令（create/fork/list/show/set/rm） |
| 15 | fork 复制深度 | 复制配方引用（轻）；修改流程变化（§6.1） |
| 16 | extension copy | 默认共享层 + 可选专属；区分引用 vs 源码模式（§6.2） |
| 17 | /reload 触发 | 会话内 /reload（原生） |
| 18 | 插件注册 API | pi 扩展 + 命令注册 |
| 19 | UX 与能力顺序 | 能力先行，UX 穿插 |

## 4. 环境分割能力（env 命令族）

```
ptl env create <alias>               # fresh：全新空配方（无预设模板）
ptl env fork <alias> --from <src>    # fork：复制现有 template 配方
ptl env list                         # 列出环境
ptl env show <alias>                 # 查看环境配方详情
ptl env set <alias> --key value      # 修改配方（model/skills/extensions 等）
ptl env rm <alias>                   # 删除环境
```

**fresh 语义**：创建空模板（只建目录 + 共享层链接 + AGENTS.md）——不继承任何配方。AI 创建后通过 `env set` 逐步配置。

**fork 语义**：复制源 template 的完整配方（model/provider/skills/extensions/workLoop/instantiation）+ 独立 session 目录。继承但独立。

**AI 可编程**：全部命令支持 `--json` 输出（机器可读），主会话可解析并继续操作。

## 5. 跨环境扩展加载（基于 pi /reload）

**关键确认（SDK 源码核实）**：
- `AgentSession.reload()` 存在（agent-session.d.ts:522）
- `ResourceLoader.reload()` 重载 extensions/skills/prompts/themes（resource-loader.d.ts:52）
- `/reload` 命令：reload keybindings/extensions/skills/prompts/themes/context files

**机制**：
```
AI 在主会话中：
1. ptl extension copy <name> --from <env> [--mode 引用|源码]
2. /reload（会话内原生命令）
3. 新扩展立即生效（无需重启会话）
```

## 6. 环境隔离工具链（fork + extension copy 的细化）

### 6.1 现状结构（实测）

```
shared/extensions/<name>       ← 共享扩展实体
shared/skills/<name>           ← 共享 skill 实体
pi-config/<templateId>/extensions/<name> → symlink → shared/extensions/<name>
```

**关键机制（已验证）**：`shared-layer.ts:63` symlink 创建**跳过已存在的**——环境目录放实体文件（非 symlink）即**天然遮蔽共享 symlink**。环境专属源码复制的物理机制已存在，只需命令层接入。

### 6.2 extension copy 双模式

```
ptl extension copy <name> --from <env> [--mode 引用|源码]
  ├─ 引用模式（默认）：只改 symlink/引用——环境挂载同一个扩展（改共享实体）
  └─ 源码模式（--mode source）：复制扩展源码到环境专属目录（pi-config/<id>/extensions/<name>）
       → 遮蔽共享 symlink → 独立开发/修改，不影响源
```

**skill 同机制**：`ptl skill copy <name> --from <env> [--mode 引用|源码]`。

### 6.3 fork 引用复制 → 修改流程

**修改语义**：fork 后新环境与源环境共享扩展/skill 实体。修改某 skill/extension 时：
1. `ptl extension copy <name> --from <env> --mode source`（复制实体到环境专属）
2. 修改环境专属副本（不影响共享/源环境）
3. 如需回共享 → 手动合回 shared/（或未来 sync 命令）

**完整工具链**：fork（配方引用）+ 源码复制（实体隔离）= 环境隔离闭环。

## 7. provider / skill 作用域

- **provider**：全局（providers.json 全局定义 + auth.json per-template 凭据）——个人开发者场景确认合理，不做 per-template 覆盖
- **skill**：跟扩展机制（shared-layer 全局 + 可复制）

## 8. 插件注册 API（pi 扩展 + 命令注册）

```
插件 = pi 扩展（沿用扩展开机制，shared-layer 注入）
  + 注册命令到 ptl（插件声明其命令集 → 挂到 ptl <cmd>）
```

- mail-box / 容器开发 / hub 作为插件包
- framework 是插件宿主（加载扩展 + 命令注册 + 生命周期）
- 与现有扩展开机制一致（`extensions/` 目录 + shared-layer symlink）

## 9. 演进路线（v1 → v2）

| 阶段 | 内容 |
|---|---|
| **v1（本设计）** | monorepo 拆分 + framework 核心（env 命令族/fork/extension copy/reload 接入）+ mail-box 独立化 + 容器开发 skill+扩展 |
| v2 | 插件注册 API 完善 + sync 命令（环境专属→共享回写）+ 环境类型预设（若需）+ AI 自主环境编排深化 |
| 远期 | 与 pi-dashboard 集成（ptl 管环境，dashboard 管 UI）+ 多机环境同步 |

## 10. 非目标（YAGNI）

- ⛔ 环境类型预设（fresh 无预设模板，用户裁决）
- ⛔ provider per-template 覆盖（个人开发者全局够用）
- ⛔ 自动环境同步（v1 手动 copy；sync 命令 v2）
- ⛔ 运行时动态加载扩展（用 /reload 而非热加载——pi 原生机制）
- ⛔ 多机环境管理（单机本地优先）
- ⛔ 扩展自动回写共享（手动合回，sync v2）

## 11. 关键不变量

1. template = 静态配方；session = 运行时实例；agent = 单发任务——三者概念清晰
2. 会话按 template 分组但各自独立（多会话并存不冲突）
3. fork 复制配方引用（轻），扩展/skill 实体不复制
4. 环境专属实体（非 symlink）遮蔽共享 symlink（已有机制）
5. extension copy 双模式：引用（共享）vs 源码（隔离）
6. 跨环境扩展加载 = extension copy + 会话内 /reload（无需重启）
7. provider 全局；skill 跟扩展机制
8. 统一入口 ptl + 插件（沿用 pi 扩展机制）
9. env 命令族全部支持 --json（AI 可编程）
10. 能力先行，UX 穿插（18 个 UX 问题在实现中修复）

## 12. 相关参考

- 草案（裁决全记录）：`docs/superpowers/explorations/2026-08-07-framework-split-draft.md`
- UX 审计：`docs/superpowers/explorations/2026-08-07-framework-ux-audit.md`
- 生态调研：`docs/superpowers/explorations/2026-08-07-pi-ecosystem-research.md`
- 现状代码：`src/ptl/`（launcher.ts/tmux.ts/config.ts/shared-layer.ts/cli/）
- pi SDK：`node_modules/@earendil-works/pi-coding-agent/dist/core/`
