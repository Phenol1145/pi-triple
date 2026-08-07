# pi-triple framework 拆分设计草案（进行中，未定稿）

- 日期：2026-08-07
- 状态：**草案**（brainstorming 收敛中——概念层已澄清，能力设计待定稿）
- 触发：PTL 单体拆分为多项目（framework/mail-box/容器开发）+ 用户提出 AI 自主环境操作能力需求

---

## 1. 拆分方向（用户裁决）

```
PTL（当前单体）拆解
├─ ① pi-triple framework      承载一切的基础平台
│    会话/环境核心 + 扩展注入机制 + AI 可编程环境操作
├─ ② mail-box                 通讯工具（pit-communicate 独立化）
└─ ③ 容器开发扩展             在容器中开发扩展后端
      ├─ 开发容器通用 skill（可复用方法论）
      └─ extensions-in-container（承载 dev 容器配置/启动/挂载）
```

**已裁决**：
| # | 决策 | 内容 |
|---|---|---|
| 1 | 仓库形态 | Monorepo npm workspace（共享包提取） |
| 2 | framework 边界 | 承载一切的基础平台（会话/环境核心 + 扩展注入 + AI 接口） |
| 3 | hub 归属 | 拆出归 PTH/独立（PTL↔PTH 桥，非 framework 核心） |
| 4 | 共享代码 | 提取 @pi-triple/shared（tmux/launcher/config/路径/日志） |
| 5 | 扩展开归属 | 跟 framework 有关（扩展注入面） |
| 6 | 容器开发 | 通用 skill + extensions-in-container 扩展 |
| 7 | CLI 命名 | 统一入口 ptl + 插件（子项目作为 ptl 子命令插件） |
| 8 | 插件形态 | 沿用 pi 扩展开机制（shared-layer 注入） |
| 9 | 体验优先级 | 全部按序（首次上手→日常效率→扩展管理） |
| 10 | provider 作用域 | 全局（面向个人开发者，无隔离必要） |
| 11 | skill 加载 | 跟扩展机制（shared-layer 全局 + 可复制） |
| 12 | 环境分割语义 | fresh + fork 双模式；**fresh 无预设模板** |
| 13 | 跨环境扩展加载 | **基于 pi /reload 机制**（动态重载，无需重启） |

## 2. 概念层（template / session / agent 三分，用户要求澄清后已确认）

```
template（静态环境配方）──► session（运行时实例）
   │  model/skills/extensions/   │   tmux + pi 进程 + 纸带
   │  workLoop/instantiation     │   按 template 分组但各自独立
   │                             ▼
   └─► agent run（单发任务执行，无状态）
```

| 概念 | 定义 | 关键事实 |
|---|---|---|
| **template** | 环境的静态配方（TemplateConfig：alias/model/provider/skills/extensions/workLoop/instantiation） | 配方字段已存在但创建路径（template new）只用 alias——**需让配方真正生效** |
| **session** | 运行时实例（tmux + pi + 纸带 JSONL） | 会话文件按 template 分组（`sessions/<templateId>/`），但每次启动唯一会话目录 → **多会话并存不冲突** |
| **agent** | 单发任务执行（`ptl agent run <template> <task>`） | 介于环境与会话之间，无状态 |

**会话发现语义（/resume 实测确认）**：
- `current folder`：当前 template + cwd 匹配的会话
- `all`：当前 session 目录（`sessions/<templateId>/`）全部会话——**环境内**，不跨 template
- 只有裸 pi（无 --session-dir）时 `all` 才扫全局默认目录

## 3. 环境分割能力（fresh + fork 双模式）

```
ptl env create <alias>               # fresh：全新空配方（无预设模板，用户裁决）
ptl env fork <alias> --from <src>    # fork：复制现有 template 配方
ptl env list                         # 列出环境
ptl env show <alias>                 # 查看环境配方详情
```

**fresh 语义**：创建空模板（只建目录 + 共享层链接 + AGENTS.md）——不继承任何配方。AI 创建后通过 `env set` 逐步配置。

**fork 语义**：复制源 template 的完整配方（model/provider/skills/extensions/workLoop/instantiation）+ 独立 session 目录。继承但独立（后续修改不影响源）。

## 4. AI 可编程接口

**概念**：主会话（AI）能自主完成"新建知识工作分支环境"等操作。

```
ptl env create/fork/list/show --json   # 机器可读输出
```

- AI 调用 `env fork knowledge-work --from knowledge` → 得到 {id, alias, 配方快照}
- AI 调用 `env set <alias> --skill X --extension Y` → 调整配方
- AI 调用 `env start <alias>` → 启动会话

**与 template 命令的关系**：`env` 命令族是 AI 首选（语义化 + --json）；`template` 命令保留给人用（向后兼容）。

## 5. 跨环境扩展加载（基于 pi /reload）

**关键确认（SDK 源码核实）**：
- `AgentSession.reload()` 存在（agent-session.d.ts:522）
- `ResourceLoader.reload()` 重载 extensions/skills/prompts/themes（resource-loader.d.ts:52）
- `/reload` 命令：reload keybindings/extensions/skills/prompts/themes/context files（slash-commands.js:23）

**机制**：
```
AI 在主会话中：
1. ptl extension copy <name> --from <env>   ← 跨环境复制扩展（改 symlink）
2. /reload                                   ← 会话内重载扩展集，新扩展生效（无需重启）
```

**这意味着**：跨环境扩展加载**可行且无缝**——不需要重启会话。AI 可以：从 dev 环境复制一个扩展到 knowledge 环境 → reload → 立即使用。

## 6. provider / skill 作用域

- **provider**：全局（providers.json 全局定义 + auth.json per-template 凭据）——个人开发者场景确认合理，**不做 per-template 覆盖**
- **skill**：跟扩展机制（shared-layer 全局 + 可复制）——与扩展同等待遇

## 7. 生态定位（调研结论）

**pi 生态无 ptl 同类**：
- pi-dashboard（48★）= 会话 Web UI（邻接，不同层次）
- monopi（145★）= 配置包管理（方向相反：统一 vs 隔离）
- roach-pi（273★）= 多 agent 编排（邻接）
- gastown（17,494★ Go）= 通用领域多 agent 编排（概念映射高度重合，但技术栈/侧重点不同）

**ptl 差异化位置** = pi 之上的"多环境 framework"（环境配方 + 统一会话 + AI 可编程 + 插件生态）。

**发布策略**：作为 pi 生态 npm 包（`@pi-triple/framework` 等），与 pi-dashboard 互补（ptl 管环境/会话编排，pi-dashboard 管远程 UI）。

## 8. 未裁决/待定稿

1. **env 命令族的完整命令集**（create/fork/list/show/set/start？还有 rm/rename？）
2. **fork 的配方复制深度**（扩展是复制 symlink 还是复制实体？skill 同理）
3. **extension copy 的跨环境语义**（复制到共享层？还是环境专属？）
4. **/reload 的触发路径**（会话内 /reload 是用户手动；AI 能否自动触发？——需要 pi 会话内 AI 调命令的机制）
5. **framework 的插件注册 API**（mail-box/容器开发/hub 作为插件如何注册进 ptl？——沿用 pi 扩展机制的具体接口）
6. **UX 打磨与能力设计的顺序**（已盘点 18 个 UX 问题——先修 UX 还是先做能力？）

## 9. 相关参考

- UX 审计：`docs/superpowers/explorations/2026-08-07-framework-ux-audit.md`（18 问题 + 8 亮点）
- pi 生态调研：`docs/superpowers/explorations/2026-08-07-pi-ecosystem-research.md`
- 拆分计划：`docs/superpowers/plans/2026-08-07-pth-assembly-and-rename.md`
- 现状代码：`src/ptl/`（launcher.ts/tmux.ts/config.ts/cli/）
- pi SDK：`node_modules/@earendil-works/pi-coding-agent/dist/core/`（agent-session.d.ts/resource-loader.d.ts/slash-commands.js）
