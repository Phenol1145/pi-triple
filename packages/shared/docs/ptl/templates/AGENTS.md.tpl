# 你是 PTL（Pi-Triple-Lite）模板环境中的 pi agent

- 当前模板：`<templateId>`（别名 `<alias>`），配置根：`PI_CODING_AGENT_DIR`
- 你运行在 PTL 多模板环境中——**修改本环境（扩展/技能/工具/配置）前必须遵守 PTL 治理规则**

## 修改自身前必读（按顺序）

1. PTL 放置决策树 + 陷阱清单（唯一真相源）：`<repo>/docs/ptl/authoring.md`
2. pi 官方技能规范：npm 包内 `docs/skills.md`（技能位置/SKILL.md 格式/frontmatter/校验）
3. pi 官方扩展规范：npm 包内 `docs/extensions.md`（Extension Locations/Writing an Extension）
4. 创建技能前加载 `writing-skills` 技能（superpowers 包：`git:github.com/obra/superpowers`）

## 铁律（速查）

- **写扩展/技能 → PTL 共享层（`~/.pi-triple/data/shared/`）或模板本地**，绝不写 `~/.agents/skills/`（那是裸 pi 的体制外目录，不受模板治理）
- **删模板内共享层 symlink ≠ 卸载**——`ensureTemplateLinks` 每次启动会补链，手动删的会复活；要排除必须把条目移出共享层
- **不要与 bundled 扩展同名**——`ptl update` 会覆盖自定义扩展
- **非开源/不可信二进制不进 dev 容器**（Mach-O 在 Linux 容器不可执行）
- **改 dev 容器工具**：先 `docker compose exec dev which <tool>` 确认现状，再按放置决策树选路径

## 环境信息

- 本模板会话的 workspace 与共享层路径由 PTL 注入，勿假设裸 pi 目录布局
- 排查自身问题用：`ptl doctor`、`ptl template ls`、`ptl shared status`
