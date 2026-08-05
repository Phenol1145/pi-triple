# PTL 技能/扩展创作指南

> PTL（Pi-Triple-Lite）文档 — 在 PTL 结构下**放置与挂载** skill / extension 的规范。
> 内容怎么写（SKILL.md 格式、扩展 API、Agent Skills 标准）以 pi 上游文档为准：
> `docs/skills.md`、`docs/extensions.md`（随 `@earendil-works/pi-coding-agent` 包分发）。
> 本文**不复制**上游内容，只解决"放在哪、怎么挂、怎么拆"。
>
> **已按 pi SDK 0.82.x 验证（2026-08-06）**。SDK 升级复检规则见文末。

## TL;DR 决策树

```
新建一个 skill / extension，放哪？

├─ 只有某一个模板用 / 还在试验阶段
│    → 模板本地：~/.pi-triple/data/pi-config/<uuid>/skills|extensions/<name>
│
├─ 多个模板共享、希望统一管理
│    → 共享层：~/.pi-triple/data/shared/skills|extensions/<name>
│      （下次启动自动挂进所有模板，无需手动 symlink）
│
└─ 刻意要对所有 pi 进程生效、绕过模板治理（少见，想清楚）
     → 用户级：~/.agents/skills/<name>
       ⚠️ pit 完全看不见它：pit template ls 不统计、无法按模板管控
```

## 核心机制（决定一切操作语义）

launcher 在**每次启动 pi 前**调用 `ensureTemplateLinks`
（`src/ptl/launcher.ts:136` → `shared-layer.ts` 的 `linkTemplateToShared`）：

1. **缺链自动补**：共享层有、模板里没有 symlink 的条目 → 自动创建相对 symlink。
2. **不覆盖**：模板里已存在同名路径（真实文件/目录）→ 跳过，模板自有条目优先。
3. **只管共享层→模板方向**：模板自有条目永不反向进共享层。

三条推论：

| 推论 | 后果 |
|---|---|
| 共享层 = **全模板全局** | 放进共享层的条目会出现在所有模板；**不存在持久的按模板排除**——手动删模板里的 symlink，下次启动会复活 |
| 按模板分化只有一条路 | 把条目**移出共享层**，作为真实文件放进目标模板本地 |
| 同名遮蔽可行 | 模板本地放一个与共享层同名的真实条目，可临时覆盖共享版（共享链接不会再建） |

bundled 扩展（随 pi-triple 包分发、`pit update --all` 覆盖式同步）由
`.bundled-manifest` 托管——**自定义扩展不要与 bundled 同名**，否则升级时被覆盖/剪枝。

## 操作手册

### 新建 skill

**模板本地**（试验/私有）：

```bash
T=~/.pi-triple/data/pi-config/<uuid>     # pit template ls 查 uuid
mkdir -p $T/skills/my-skill
$EDITOR $T/skills/my-skill/SKILL.md      # 格式按上游 docs/skills.md
```

**共享层**（受控共享）：

```bash
S=~/.pi-triple/data/shared
mkdir -p $S/skills/my-skill
$EDITOR $S/skills/my-skill/SKILL.md
# 无需手动 symlink —— 任一模板下次 pit start/pi 时自动挂载
```

**从模板本地提升到共享层**：`pit shared init` 会把默认模板的条目整体提升
（`promoteToShared`，同名冲突保留共享层版本）；也可手动 `mv` 后依赖自动补链。

### 新建 extension

同上两级放置，目录换成 `extensions/`，单文件 `my-ext.ts` 或目录 `my-ext/index.ts` 均可。

- npm 依赖：扩展旁放 `package.json` + `npm install`（上游约定，PTL 下同样有效）。
- 需要跨会话共享状态的扩展（信箱/审计/DB）参考共享层内的
  `pit-communicate` / `agent-lab`，数据落 `~/.pi-triple/data/shared/`。

### 卸载 / 收缩范围

| 目标 | 操作 |
|---|---|
| 从某个模板去掉**模板本地**条目 | 直接 `rm -rf` 模板里的真实目录/文件 |
| 从某个模板去掉**共享层**条目 | ❌ 删 symlink 无效（启动复活）。✅ 把条目移出共享层：只留在需要的模板本地 |
| 彻底删除共享层条目 | `rm -rf ~/.pi-triple/data/shared/{skills,extensions}/<name>`，再清各模板残留 symlink（dangling 链接 launcher 不会自动清理，也不影响启动） |
| 删除用户级技能 | `rm -rf ~/.agents/skills/<name>`（如是市场安装的，同时清 `~/.agents/.skill-lock.json` 条目） |

### 查看现状

```bash
pit template ls          # 各模板挂载的扩展/技能计数（只统计模板目录）
pit shared status        # 共享层条目计数
ls ~/.agents/skills/     # 用户级"编外"技能（pit 不可见，需手动盘点）
```

## 陷阱清单（真实案例）

1. **agent 按上游习惯写到了用户级目录**（obsidian-cli 案例，2026-08-05）：
   superpowers `writing-skills` 指路 "runtime's skills directory" → 裸 pi 语义下
   agent 把新技能写进 `~/.agents/skills/`。对裸 pi 正确，对 PTL 是体制外：
   不受模板治理、无法分类盘点。**要求 agent 写技能时，请明确说"放进 PTL 共享层/
   模板本地"**；验收时 `pit template ls` 计数应 +1。
2. **市场安装 = 用户级**：pi 技能市场安装落到 `~/.agents/skills/`
   （lockfile `~/.agents/.skill-lock.json`），同样绕过模板治理；需要治理就手动迁入共享层。
3. **删 symlink ≠ 卸载**：见上表，共享层条目的"按模板排除"只能通过移出共享层实现。
4. **bundled 同名覆盖**：自定义扩展与 bundled 扩展同名 → `pit update --all` 时被
   `syncBundledExtensions` 覆盖/剪枝。

## SDK 升级复检护栏

上游 `docs/skills.md` / `docs/extensions.md` 随 SDK npm 包更新，其中
**Locations / Extension Locations 段落**定义了加载位置约定。本指南基于该约定，
因此升级 SDK（`SDK_COMPAT_RANGE` 变更，见 `src/shared/sdk-adapter/index.ts`）时必须：

1. diff 新旧版 `docs/skills.md` 的 "Locations" 段与 `docs/extensions.md` 的
   "Extension Locations" 段；
2. 有变化 → 同步更新本文与 `architecture.md` 共享层一节；无变化 → 免检；
3. 升级后跑 `pit doctor` + `pit shared status` 确认挂载链路完好。
