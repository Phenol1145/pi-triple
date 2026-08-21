# CLI 化迁移 P1 试点实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 P1 试点——local→root 更名、`.ptl-shared-exclude` 排除机制、cli-dev 纯 CLI 模板（dev-cli/ptl-agent 双技能）。

**Architecture:** 排除机制在 `linkTemplateToShared` 中实现（跳过建链 + 解链存量 symlink，永不删真实文件），每次启动强制生效；cli-dev 模板只保留 ptl-providers + questionnaire.ts 两个胶水扩展，能力全靠 CLI + 模板本地技能。

**Tech Stack:** TypeScript（vitest 测试）、pit CLI、共享层 symlink 机制。

**Spec:** `docs/superpowers/specs/2026-08-06-cli-template-migration-design.md`

## Global Constraints

- pi SDK `^0.82.1`（`SDK_COMPAT_RANGE`），不改 SDK 适配层
- 排除机制对共享层**只读**：永不删除/修改 `~/.pi-triple/data/shared/` 内容
- 模板自有**真实文件/目录永不删除**（只解 symlink）
- 排除文件坏 JSON = 无排除 + 不阻塞启动
- cli-dev 保留扩展名单（已静态查证无 `_shared` 依赖）：`ptl-providers`、`questionnaire.ts`
- dev 容器名：`pi-platform-dev-1`（技能内提供 compose 动态探测兜底）
- 提交信息风格：`<type>(<scope>): 中文摘要——细节`（对齐现有 git log）

---

### Task 0: local → root 更名

**Files:**
- Modify: 无代码文件（pit 元数据 + 文档措辞）

- [ ] **Step 1: 执行更名**

```bash
cd /Users/anzhize/pi-platform
ptl template rename local root
```

若命令形态不对，先 `ptl template --help` 确认参数顺序。

- [ ] **Step 2: 验证**

```bash
ptl template ls --json | python3 -c "import json,sys; d=json.load(sys.stdin)['data']['templates']; print([(t['alias'],t['isDefault']) for t in d])"
```

Expected: `[('root', True), ('knowledge', False), ('dev', False)]`，无 `local`。UUID 应仍为 `ee7cae31-2dee-46bf-90b3-0adeaf62116b`。

- [ ] **Step 3: 文档措辞巡检**

```bash
grep -rn "local" docs/ README.md ARCHITECTURE.md | grep -iv "localhost\|local 跑\|本地" | grep -i "模板\|template\|local（\|(local)"
```

把指代"默认模板 local"的措辞改为 root（README 快速开始里 `ptl template new local` 是示例命令，保留但可加注释说明默认模板现为 root）。

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "chore(ptl): 默认模板 local 更名 root——控制面语义归位（CLI 化迁移 P1/Task 0，UUID 不变）"
```

---

### Task 1: 排除机制（TDD）

**Files:**
- Modify: `src/ptl/shared-layer.ts`
- Test: `test/unit/shared-layer.test.ts`（追加 describe 块）

**Interfaces:**
- Produces: `SHARED_EXCLUDE_FILE`（常量 `".ptl-shared-exclude"`）、
  `readSharedExclude(templateDir: string): SharedExclude`、
  `SharedExclude` 接口（`extensions?/skills?/git?/npm?: string[]`）；
  `linkTemplateToShared` 行为变更（后续任务依赖"排除项不建链 + 存量 symlink 被解除"）

- [ ] **Step 1: 写失败测试**

在 `test/unit/shared-layer.test.ts` 顶部 import 行把 `resolveBundledDir` 改为：

```typescript
import { resolveBundledDir, linkTemplateToShared, readSharedExclude, SHARED_EXCLUDE_FILE } from "../../src/ptl/shared-layer.js";
```

文件末尾追加：

```typescript
describe("readSharedExclude", () => {
  it("文件不存在 → 空排除", () => {
    const tpl = makeTmp();
    expect(readSharedExclude(tpl)).toEqual({});
  });

  it("坏 JSON → 空排除（容错，不抛错）", () => {
    const tpl = makeTmp();
    fs.writeFileSync(path.join(tpl, SHARED_EXCLUDE_FILE), "{not json!");
    expect(readSharedExclude(tpl)).toEqual({});
  });

  it("合法 JSON → 原样返回", () => {
    const tpl = makeTmp();
    fs.writeFileSync(path.join(tpl, SHARED_EXCLUDE_FILE), JSON.stringify({ skills: ["*"], extensions: ["agent-lab"] }));
    expect(readSharedExclude(tpl)).toEqual({ skills: ["*"], extensions: ["agent-lab"] });
  });
});

describe("linkTemplateToShared — 排除机制", () => {
  function setup(shared: string, template: string): void {
    for (const name of ["keep-ext", "drop-ext"]) {
      fs.mkdirSync(path.join(shared, "extensions", name), { recursive: true });
    }
    fs.mkdirSync(path.join(shared, "skills", "drop-skill"), { recursive: true });
    fs.mkdirSync(template, { recursive: true });
  }

  it("无排除文件 → 行为不变（全部建链）", () => {
    const shared = makeTmp(), tpl = makeTmp();
    setup(shared, tpl);
    linkTemplateToShared(tpl, shared);
    expect(fs.lstatSync(path.join(tpl, "extensions", "keep-ext")).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(tpl, "extensions", "drop-ext")).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(tpl, "skills", "drop-skill")).isSymbolicLink()).toBe(true);
  });

  it("排除项不建链，其余照常", () => {
    const shared = makeTmp(), tpl = makeTmp();
    setup(shared, tpl);
    fs.writeFileSync(path.join(tpl, SHARED_EXCLUDE_FILE), JSON.stringify({ extensions: ["drop-ext"] }));
    linkTemplateToShared(tpl, shared);
    expect(fs.existsSync(path.join(tpl, "extensions", "drop-ext"))).toBe(false);
    expect(fs.lstatSync(path.join(tpl, "extensions", "keep-ext")).isSymbolicLink()).toBe(true);
  });

  it("已存在的排除项 symlink 被解除（启动复活防御）", () => {
    const shared = makeTmp(), tpl = makeTmp();
    setup(shared, tpl);
    linkTemplateToShared(tpl, shared); // 先全量建链
    fs.writeFileSync(path.join(tpl, SHARED_EXCLUDE_FILE), JSON.stringify({ extensions: ["drop-ext"], skills: ["*"] }));
    linkTemplateToShared(tpl, shared); // 再链接：排除项应被解链
    expect(fs.existsSync(path.join(tpl, "extensions", "drop-ext"))).toBe(false);
    expect(fs.existsSync(path.join(tpl, "skills", "drop-skill"))).toBe(false);
    expect(fs.lstatSync(path.join(tpl, "extensions", "keep-ext")).isSymbolicLink()).toBe(true);
  });

  it("'*' 通配 = 该类全排除", () => {
    const shared = makeTmp(), tpl = makeTmp();
    setup(shared, tpl);
    fs.writeFileSync(path.join(tpl, SHARED_EXCLUDE_FILE), JSON.stringify({ extensions: ["*"] }));
    linkTemplateToShared(tpl, shared);
    expect(fs.existsSync(path.join(tpl, "extensions", "keep-ext"))).toBe(false);
    expect(fs.existsSync(path.join(tpl, "extensions", "drop-ext"))).toBe(false);
    expect(fs.lstatSync(path.join(tpl, "skills", "drop-skill")).isSymbolicLink()).toBe(true);
  });

  it("同名真实目录永不删除（即使被排除）", () => {
    const shared = makeTmp(), tpl = makeTmp();
    setup(shared, tpl);
    // 模板自有真实目录与共享项同名
    fs.mkdirSync(path.join(tpl, "extensions", "drop-ext"), { recursive: true });
    fs.writeFileSync(path.join(tpl, "drop-ext-marker"), "real");
    fs.writeFileSync(path.join(tpl, SHARED_EXCLUDE_FILE), JSON.stringify({ extensions: ["drop-ext"] }));
    linkTemplateToShared(tpl, shared);
    expect(fs.lstatSync(path.join(tpl, "extensions", "drop-ext")).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(tpl, "drop-ext-marker"))).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /Users/anzhize/pi-platform && npx vitest run test/unit/shared-layer.test.ts
```

Expected: FAIL（`readSharedExclude`/`SHARED_EXCLUDE_FILE` 未导出）。

- [ ] **Step 3: 实现**

`src/ptl/shared-layer.ts`：

（a）`SHARED_DIRS` 定义之后追加：

```typescript
/** 模板级共享排除清单文件名（位于模板目录内，随模板共存亡） */
export const SHARED_EXCLUDE_FILE = ".ptl-shared-exclude";

export interface SharedExclude {
  extensions?: string[];
  skills?: string[];
  git?: string[];
  npm?: string[];
}

/** 读取排除清单；文件缺失/坏 JSON → 视为无排除（不阻塞启动） */
export function readSharedExclude(templateDir: string): SharedExclude {
  try {
    const raw = fs.readFileSync(path.join(templateDir, SHARED_EXCLUDE_FILE), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SharedExclude;
    }
  } catch { /* 缺失或坏 JSON：视为无排除 */ }
  return {};
}

function isExcluded(list: string[] | undefined, name: string): boolean {
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.includes("*") || list.includes(name);
}
```

（b）`linkTemplateToShared` 改造：函数体开头加一行

```typescript
  const exclude = readSharedExclude(templateDir) as Record<string, string[] | undefined>;
```

在 `// 逐个共享项创建相对 symlink（跳过已存在的）` 循环**之前**插入解链段：

```typescript
    // 排除项：解除模板里已存在的 symlink（真实文件/目录永不删）
    const excl = exclude[dir];
    if (excl && excl.length > 0) {
      for (const entry of fs.readdirSync(tenantSubDir, { withFileTypes: true })) {
        if (!isExcluded(excl, entry.name)) continue;
        const fullPath = path.join(tenantSubDir, entry.name);
        try {
          if (fs.lstatSync(fullPath).isSymbolicLink()) fs.unlinkSync(fullPath);
        } catch { /* ok */ }
      }
    }
```

在逐项建链循环内、`const linkPath = ...` 之前插入：

```typescript
      if (isExcluded(excl, entry.name)) continue;
```

- [ ] **Step 4: 测试通过 + lint**

```bash
npx vitest run test/unit/shared-layer.test.ts && npm run lint
```

Expected: PASS + exit 0。

- [ ] **Step 5: 提交**

```bash
git add src/ptl/shared-layer.ts test/unit/shared-layer.test.ts
git commit -m "feat(ptl): 模板级共享排除机制——.ptl-shared-exclude（跳过建链+解链存量 symlink+真实文件永不删+坏 JSON 容错）；CLI 化迁移 P1/Task 1"
```

---

### Task 2: cli-dev 模板 + 排除清单

**Files:**
- Create: `~/.pi-triple/data/pi-config/<uuid>/.ptl-shared-exclude`

- [ ] **Step 1: 建模板**

```bash
ptl template new cli-dev
ptl template ls --json | python3 -c "import json,sys; d=json.load(sys.stdin)['data']['templates']; print([t['id'] for t in d if t['alias']=='cli-dev'][0])"
```

记下输出的 UUID（下文用 `<uuid>`）。

- [ ] **Step 2: 写排除清单**

```bash
T=~/.pi-triple/data/pi-config/<uuid>
cat > $T/.ptl-shared-exclude <<'EOF'
{
  "extensions": [
    "_shared", ".bundled-manifest", "agent-lab", "agent-lab-bidder",
    "health-check.ts", "model-search", "openrouter.ts", "ptl-communicate",
    "ptl-control", "preset.ts", "speed-bench", "ustc-pan", "workflow"
  ],
  "skills": ["*"]
}
EOF
```

注意：denylist 语义——将来共享层新增条目会默认进 cli-dev，需同步追加排除（见 Task 5 文档）。

- [ ] **Step 3: 触发链接并验证**

```bash
cd /Users/anzhize/pi-platform && npx tsx -e "
import { linkTemplateToShared } from './src/ptl/shared-layer.ts';
import os from 'node:os';
linkTemplateToShared(os.homedir() + '/.pi-triple/data/pi-config/<uuid>', os.homedir() + '/.pi-triple/data/shared');
console.log('linked');
"
ls -la $T/extensions/ $T/skills/
```

Expected: `extensions/` 仅 `ptl-providers`、`questionnaire.ts` 两个 symlink（无 _shared 等 13 项）；`skills/` 为空。

- [ ] **Step 4: 再跑一次验证持久性**（模拟重启补链）

重复 Step 3 的链接调用与 ls，Expected 不变。

- [ ] **Step 5: 提交说明**（数据目录不在 git，跳过 commit；在 Task 6 验收时以运行时状态为准）

---

### Task 3: dev-cli 技能

**Files:**
- Create: `~/.pi-triple/data/pi-config/<uuid>/skills/dev-cli/SKILL.md`

- [ ] **Step 1: 写技能**

```bash
mkdir -p $T/skills/dev-cli
```

写入以下内容到 `$T/skills/dev-cli/SKILL.md`：

````markdown
---
name: dev-cli
description: dev 容器工具操作。需要跑编程语言/工具链/数据科学/调研/下载等能力时使用。本模板无扩展机制，所有工具经 CLI：wrapper 命令（agent-reach/yt-dlp/instsci）宿主机直接调用自动转发容器；其余容器工具经 docker exec pi-platform-dev-1。触发词：跑代码/python/node/go/rust/jupyter/数据分析/ffmpeg/下载视频/调研/装工具。
---

# Dev CLI 操作

本模板（cli-dev）没有扩展机制，所有能力 = CLI + 本技能。

## 第 0 步：环境自检

```bash
docker ps --format '{{.Names}} {{.Status}}' | grep dev
```
应见 `pi-platform-dev-1 ... (healthy)`。不存在则 `cd ~/pi-platform && docker compose up -d dev`。
容器名兜底：`docker compose -f ~/pi-platform/docker-compose.yaml ps -q dev`（compose project 变化时用）。

## 工具地图

### A. 直接调用（宿主 wrapper，自动转发容器）
| 命令 | 用途 |
|---|---|
| `agent-reach` | 多平台互联网调研 |
| `yt-dlp` | 视频下载 |
| `instsci` | 科学计算仪器 |

### B. 容器原生工具（经 docker exec）
```bash
docker exec pi-platform-dev-1 <cmd>                          # 一次性命令
docker exec -w /works/pi-platform pi-platform-dev-1 <cmd>    # 指定工作目录
docker exec -it pi-platform-dev-1 bash                       # 交互（谨慎，避免阻塞会话）
```
- 语言运行时：python3（3.13 + conda）、node（nvm）、go、rustc/cargo、uv
- 工具链：gh、jq、rg、sqlite3、ffmpeg、tesseract-ocr、z3、git-lfs、curl、wget、tmux、vim
- 数据科学：pandas、numpy、scipy、scikit-learn、matplotlib、seaborn
- jupyter：http://127.0.0.1:8888（容器端口已映射）

### C. 宿主专属（不进容器）
`obsidian`、`kimiim-cli`——宿主机直接调用。

## 工作目录与产物流向

| 位置 | 语义 |
|---|---|
| `/works/pi-platform`、`/works/docs`、`/works/Projects`、`/works/go` | = 宿主 ~/pi-platform、~/docs、~/Projects、~/go 同一份文件——文件读写优先这里 |
| `/data/artifacts` | 成品保留区（容器卷，持久） |
| `/data/workspaces` | 与 pth/sandbox 共享卷 |
| 容器 /tmp | 中间态临时产物（可弃） |

## 护栏

- 往容器**安装新工具**前，先按放置决策树判断归属（dev/sandbox/宿主）；
  判断依据参考 dev-container-tools 技能（若加载）或 docs/superpowers/dev-container-tool-guide.md
- 长任务（训练/渲染）用 `docker exec -d` 或容器内 tmux，不要阻塞当前会话
- 容器重启不丢：~/ 挂载与 /data 卷持久；容器内其他路径重启即失
````

- [ ] **Step 2: 验证技能格式**

```bash
head -5 $T/skills/dev-cli/SKILL.md   # frontmatter 完整（name/description）
```

---

### Task 4: ptl-agent 技能

**Files:**
- Create: `~/.pi-triple/data/pi-config/<uuid>/skills/ptl-agent/SKILL.md`

- [ ] **Step 1: 写技能**

写入以下内容到 `$T/skills/ptl-agent/SKILL.md`：

````markdown
---
name: ptl-agent
description: 用 pit CLI 驾驶 PTL 平台。需要管理 pi 会话、查询/创建模板、运行或审批 ptl-flow 工作流、向 PTH 提交/运行 agent 程序时使用。agent 一律加 --json 取机器可读输出；禁止 TUI/attach 类交互命令。触发词：会话/模板/工作流/flow/hub/提交程序。
---

# pit CLI — Agent 驾驶手册

## 约定
- 支持的命令一律加 `--json`：返回 `{"ok":bool,"data":...,"error":...}`
- `ok:false` 或非零退出 → 读 `error` 换路，不要盲目重试
- **禁止**：`ptl tui *`、`ptl attach`、`ptl switch`（需交互终端）

## 会话
```bash
ptl ls --json                              # 会话列表（状态/模板/模型）
ptl start --template <alias> --bg --name <n>   # 后台起会话
ptl stop <name>                            # 停止
ptl restore                                # 按注册表恢复
```

## 模板
```bash
ptl template ls --json                     # 模板 + 挂载计数
```

## 工作流（ptl-flow）
```bash
ptl flow run <flow.json> --input k=v --json    # 启动
ptl flow status <runId 前缀> --json            # 查状态
ptl flow ls --json
ptl flow approve <runId>                   # 人工门禁——仅当用户明确批准时执行
ptl flow reject <runId>
```
`status=waiting_human` = 需要人类审批，转告用户，不要自行 approve。

## PTH hub（联邦）
```bash
ptl hub programs --json                    # PTH 上的程序
ptl hub submit <dir>                       # 提交 agent 程序（agent.json manifest）
ptl hub run <program> ...                  # 联邦运行（SSE 回显）
```

## 已知边界
`ptl status`、`ptl doctor` 为人类可读输出（无 --json），可执行但需自行解析文本。
````

- [ ] **Step 2: 验证 frontmatter**

```bash
head -4 $T/skills/ptl-agent/SKILL.md
```

---

### Task 5: 文档更新

**Files:**
- Modify: `docs/ptl/authoring.md`（"按模板分化"改双路径 + denylist 维护提醒）
- Modify: `docs/ptl/architecture.md`（共享层警示框更新）

- [ ] **Step 1: authoring.md**

把「核心机制」推论表中「按模板分化只有一条路」行改为：

```
| 按模板分化有两条路 | ① `.ptl-shared-exclude` 排除文件（推荐，条目仍留共享层供他模板用，每次启动强制生效）；② 把条目移出共享层，放目标模板本地（物理隔离） |
```

「卸载 / 收缩范围」表中「从某个模板去掉共享层条目」行改为：

```
| 从某个模板去掉**共享层**条目 | 在该模板目录写 `.ptl-shared-exclude`（见下）；移出共享层仅当所有模板都不要它 |
```

并在「操作手册」新增小节：

````markdown
### 模板级排除（`.ptl-shared-exclude`）

模板目录内创建 `.ptl-shared-exclude`：

```json
{ "extensions": ["agent-lab", "workflow"], "skills": ["*"], "git": [], "npm": [] }
```

- 逐字精确匹配共享层条目名；`"*"` = 该类全排除；缺省 = 不排除。
- 下次启动强制生效：排除项不建链，存量 symlink 自动解除；模板自有真实文件永不删。
- ⚠️ denylist 语义：共享层**新增**条目会默认进入未排除它的模板——新增共享条目时，
  巡检各模板的排除文件（cli-dev 等严格模板尤其注意）。
- 实例：cli-dev 模板仅保留 `ptl-providers` + `questionnaire.ts`。
````

- [ ] **Step 2: architecture.md**

把此前加的警示行：

```
> ⚠️ 注意：`ensureTemplateLinks` 在每次启动时补链——共享层条目 = 全模板全局，删 symlink 会复活，按模板排除需移出共享层。新建/挂载/卸载技能与扩展的操作规范见 [创作指南](../../ptl/authoring.md)。
```

改为：

```
> ⚠️ 注意：`ensureTemplateLinks` 在每次启动时补链——共享层条目默认全模板全局，删 symlink 会复活。按模板排除用 `.ptl-shared-exclude` 排除文件（启动时强制生效），或移出共享层做物理隔离。操作规范见 [创作指南](../../ptl/authoring.md)。
```

「关键函数」列表追加一行：

```
- `readSharedExclude(templateDir)` — 读取模板级排除清单（`.ptl-shared-exclude`，坏 JSON 容错）
```

- [ ] **Step 3: 提交**

```bash
git add docs/ptl/authoring.md docs/ptl/architecture.md
git commit -m "docs(ptl): 排除机制落文档——authoring 双路径分化+denylist 维护提醒；architecture 警示更新"
```

---

### Task 6: 全量验收

- [ ] **Step 1: 测试与构建**

```bash
cd /Users/anzhize/pi-platform && npm test && npm run lint
```

Expected: 全绿（测试数 ≥ 950 + 新增 8 例）。

- [ ] **Step 2: 模板状态**

```bash
ptl template ls --json
```

Expected: `root`（默认）、`knowledge`、`dev`、`cli-dev`；cli-dev 的 extensions 计数 = 2、skills 计数 = 0。

- [ ] **Step 3: cli-dev 起会话实测**

```bash
ptl start --template cli-dev --bg --name cli-verify
sleep 5 && ptl ls --json
```

Expected: `cli-verify` 会话在列。再次确认 `$T/extensions/` 仅 2 项（启动补链未复活排除项）。

- [ ] **Step 4: CLI 烟雾测试**

```bash
yt-dlp --version                                  # wrapper 路线
docker exec pi-platform-dev-1 rg --version        # docker exec 路线
ptl ls --json >/dev/null && echo OK               # ptl agent 化接口
```

Expected: 三条均成功。

- [ ] **Step 5: 清理验证会话**

```bash
ptl stop cli-verify
```

- [ ] **Step 6: 收尾提交**（如有验收中发现的修复）

```bash
git add -A && git commit -m "fix(ptl): P1 验收修复（如有）"
```
