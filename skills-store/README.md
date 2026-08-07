# skills-store — Skill 存储区（不接入）

两位作者的 agent skills 归档库。**只存储，不接入**——这些 skill 不在 pi 的
加载源路径下（`~/.pi-triple/data/pi-config/<env>/skills/`、`.pi/skills/`、
`skillPaths`），pi 启动时不会加载它们。

## 内容

| 目录 | 作者 | 许可 | skill 数 | 来源 |
|---|---|---|---|---|
| `superpowers/` | Jesse Vincent (obra) | MIT | 14 | https://github.com/obra/superpowers |
| `mattpocock/` | Matt Pocock | MIT | 35 | https://github.com/mattpocock/skills |

### superpowers（14）—— 软件开发方法论（流程门禁式）

`brainstorming` `dispatching-parallel-agents` `executing-plans`
`finishing-a-development-branch` `receiving-code-review` `requesting-code-review`
`subagent-driven-development` `systematic-debugging` `test-driven-development`
`using-git-worktrees` `using-superpowers` `verification-before-completion`
`writing-plans` `writing-skills`

### mattpocock（35）—— 工程实操工具集（小而可组合）

- **engineering（19）**: `ask-matt` `code-review` `codebase-design` `diagnosing-bugs`
  `domain-modeling` `grill-with-docs` `implement` `improve-codebase-architecture`
  `prototype` `research` `resolving-merge-conflicts` `setup-matt-pocock-skills`
  `tdd` `to-spec` `to-tickets` `triage` `wayfinder` `wizard`
- **productivity（8）**: `grill-me` `grilling` `handoff` `teach` `to-questionnaire`
  `wait-what` `writing-for-agents`
- **misc（5）**: `git-guardrails-claude-code` `migrate-to-shoehorn`
  `scaffold-exercises` `setup-pre-commit`
- **in-progress（3 可用）**: `claude-handoff` `loop-me` `setup-ts-deep-modules`
  （另有 writing-beats/fragments/shape 写作系列）

## 接入 / 移除

### 接入某个 skill（激活）

```bash
# 方式一：ptl env skill-copy（推荐——走 PTL 环境机制）
ptl env skill-copy <name> --from <env>            # 引用模式（symlink 共享）
ptl env skill-copy <name> --mode 源码 --from <env> # 源码模式（实体遮蔽）

# 方式二：手动 symlink（引用模式）
ln -s /absolute/path/to/skills-store/superpowers/<name> \
      ~/.pi-triple/data/pi-config/<env>/skills/<name>

# 然后会话内重载
/reload
```

### 移除某个 skill（停用）

```bash
# symlink 引用模式：直接删链接
rm ~/.pi-triple/data/pi-config/<env>/skills/<name>

# 源码实体模式：删实体目录
rm -rf ~/.pi-triple/data/pi-config/<env>/skills/<name>

# 或直接 /reload 前从环境配方中摘除（env set）
ptl env set --skills '[...]' <env>
```

## 说明

- **为什么不在加载源里**：`loadSkillsFromDirInternal` 只递归扫描指定目录下的
  `SKILL.md`。本目录不在任何加载源，pi 永远不会加载，除非显式 `skill-copy`。
- **升级来源**：重新克隆上游仓库后覆盖对应目录即可（保持目录名一致）。
- **发行**：本目录不在根包 `files` 白名单，不会进入 npm 发行包。
