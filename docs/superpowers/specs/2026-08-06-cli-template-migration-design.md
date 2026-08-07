# CLI 化迁移：Roadmap + P1 试点规格

> 日期：2026-08-06 · 状态：设计待评审
> 上游约定依赖：pi SDK 0.82.x（`SDK_COMPAT_RANGE`）
> 关联：`docs/ptl/authoring.md`（创作指南）、`src/ptl/shared-layer.ts`、G 阶段 dev 容器（`Dockerfile.dev` + compose `dev` 服务）

## 1. 背景与终局愿景

PTL 当前的能力扩展依赖 pi 扩展机制（进程内 symlink 挂载）。终局目标：

```
扩展机制退场                      pit CLI 变身
─────────────────                ─────────────────
extensions（进程内工具/钩子）      人类友好 CLI（TUI/表格/彩色）
        ↓                                ↓
CLI + 操作技能（进程外调用）       agent 友好 CLI（JSON/稳定契约/幂等）

root 模板（原 local）= 唯一保留扩展的控制面
其余模板 = 纯 pi + skills + CLI，逐个迁移
```

两个正交转变：
1. **能力载体**：扩展 → CLI + 操作技能（agent 经 bash 调用，技能负责指路）。
2. **pit 用户**：人类 → agent（pit CLI 成为 agent 驾驶 PTL 的接口）。

### 扩展能力可替换性分类（P3 迁移的分类依据）

| 类别 | 例子 | 迁移目标路径 |
|---|---|---|
| 工具类（agent 主动调用） | openrouter、ustc-pan、agent_lab、notebook_*、place_bid | **(b) CLI 后端适配壳**（默认）；低风险组合型工具可走 (c) |
| 命令/UI 类 | /control、/flow、/health、/lab、questionnaire | pit CLI --json（agent 化后不需要富 UI） |
| 进程内 hook 类 | ptl-providers（401/403 密钥切换，after_provider_response） | localhost provider proxy 管 keypool（P3 专项），或永久留 root |
| 实时推送/遥测类 | ptl-communicate 投递、agent-lab 遥测注入 | 轮询 CLI（信箱已有落盘）/ sidecar，接受延迟降级 |

### 1.1 扩展替换的三条路线

```
(a) 进程内扩展      逻辑在 pi 内                      ← 现状
(b) CLI 后端适配壳  壳只声明 schema + spawn CLI + 回传结构化结果 ⭐ P3 默认
(c) 裸 CLI + 技能   agent 自己拼 bash，技能指路        ← P1 试点验证下限
```

**pi 支撑面**（已查证，SDK 0.82.x）：
- `pi.registerTool()`：一等公民，TypeBox schema，支持动态注册/`setActiveTools` 启停；
- 无内置 MCP（官方明言），但可用一个通用桥扩展把 MCP server 工具批量 registerTool
  （环境已有现成 server：`bl mcp`、obsidian-mcp、instsci-mcp）；
- 运行时**真校验**：`validateToolArguments`（prepareArguments → Convert/coercion →
  Compile Check → 失败抛错回给模型重试）。(b) 与原生工具强制力平权。

**schema 表达力结论**：结构约束（嵌套/union/enum/正则/范围/递归 + Unsafe 逃生舱）
几乎无上限且运行时强制；但模型侧执行力度随 provider 波动（高级关键字可能被忽略），
且跨字段语义约束表达不了——后者下沉到 shim/CLI 校验，闭环一致。**实践准则：
schema 适度扁平 + 封闭集用 enum，语义规则下沉 CLI。**

因此“扩展退场”准确表述为**业务逻辑退出扩展**：扩展机制降级为平台托管的薄驱动层
（shim/桥，可自动生成），业务实现全部在 CLI（容器内、任意语言、独立可测）。

## 2. 四期 Roadmap

| 期 | 内容 | 完成判据 |
|---|---|---|
| **P1（本 spec）** | cli-dev 试点模板 + 通用排除机制 + dev-cli/ptl-agent 双技能 + local→root 更名 | 见 §3 验收 |
| **P2** | pit CLI agent 化：`ptl commands --json` 机器可读命令目录、稳定错误码、非 TTY 零交互护栏、JSON 覆盖面审计补齐 | agent 在纯 CLI 模板内可完成全部 PTL 操作 |
| **P3** | 按 §1 分类逐扩展迁移，**默认走 (b) 适配化**：CLI 实现 + shim 声明 schema；每个扩展退场须过 **parity 门槛**（功能等价 + 延迟可接受 + 安全面不回退）；(c) 裸 CLI 仅限低风险组合型工具；hook 类不迁（proxy 专项或留 root） | 非 root 模板业务扩展清零（仅剩平台托管 shim） |
| **P4** | root 定位为控制面模板（唯一保留扩展）；全量验收；扩展机制文档降级为 "root 专属" | roadmap 关闭 |

## 3. P1 详细规格

### 3.0 local → root 更名（先行）

`ptl template rename local root`。别名是元数据（UUID `ee7cae31…` 不变），
运行中会话不受影响（别名在启动时读入）。更名后同步更新 README/docs 中
"local" 作为默认模板的措辞（如有硬编码引用）。

### 3.1 排除机制 `.ptl-shared-exclude`（唯一的 PTL 代码改动）

**位置**：`~/.pi-triple/data/pi-config/<uuid>/.ptl-shared-exclude`（模板目录内，
随模板存在/删除）。

**格式**：
```json
{
  "extensions": ["agent-lab", "workflow"],
  "skills": ["*"],
  "git": [],
  "npm": []
}
```
- 数组元素 = 共享层条目的**目录/文件名**（逐字精确匹配，不支持 glob），`"*"` = 该类全排除。
- 缺省/空数组 = 该类不排除。文件不存在 = 行为与现状完全一致。

**语义**（在 `linkTemplateToShared` 中实现）：
1. 被排除条目：**跳过建链**；
2. 模板里已存在的被排除条目：若为 **symlink 则解链**；若是模板自有真实文件/目录，
   **永不删除**（防误伤）；
3. 每次启动强制生效（`ensureTemplateLinks` 调用路径不变）——"共享层负责推，
   模板有权拒，拒绝在每次启动时强制生效"。

**代码改动**：
- `src/ptl/shared-layer.ts`：新增读取/解析排除文件；`linkTemplateToShared`
  增加排除分支（跳过 + 解链）。解析失败（坏 JSON）→ 视为无排除文件 + 一次性告警，
  不阻塞启动。
- `test/unit/`：新增 shared-layer-exclude 测试——
  (a) 排除条目不建链；(b) 已存在的排除项 symlink 被解除；(c) 同名真实文件不被删除；
  (d) 无排除文件时行为回归不变；(e) `"*"` 通配；(f) 坏 JSON 容错。

**文档**：
- `authoring.md`："按模板分化"路径更新为两种——移出共享层（物理隔离）或
  `.ptl-shared-exclude`（逻辑排除，推荐，条目仍留共享层供他模板用）。
- `architecture.md` 共享层一节：修正"按模板排除需移出共享层"的警示表述。

### 3.2 cli-dev 模板

- `ptl template new cli-dev`（UUID 自动生成）。
- 写入 `.ptl-shared-exclude`：
  - `extensions`：排除共享层全部扩展，**仅保留 `ptl-providers`（密钥 failover）
    与 `questionnaire.ts`（交互提问）**。已查证两者均不 import `_shared`，
    故 `_shared` 一并排除（最终保留名单 = `ptl-providers`、`questionnaire.ts`）。
  - `skills`：`["*"]`（共享层 9 个技能全排除）。
- 该模板 pi 启动后预期加载：扩展 2 个（ptl-providers + questionnaire.ts）+ 模板本地技能 2 个。

### 3.3 模板本地技能（真实目录，不受共享层补链影响）

**`skills/dev-cli/`** —— 容器工具操作技能：
- 工具地图：容器内（apt 工具链 gh/jq/rg/ffmpeg/tesseract/z3/sqlite3 ·
  Node/Go/Rust/uv · pandas/scipy/sklearn · jupyter :8888 · yt-dlp/agent-reach/instsci）
  vs 宿主专属（obsidian、kimiim-cli 等非开源）。
- 路由规则：wrapper 命令（agent-reach/yt-dlp/instsci）直接调用；
  其余容器工具经 `docker exec pi-platform-dev-1 <cmd>`（实施时确认容器名）；
  文件交互优先走 `/works/*` 绑定挂载（~/pi-platform、~/docs、~/Projects、~/go）。
- 产物流向：中间产物留容器临时区；成品落 `/data/artifacts`（dev-artifacts 卷）；
  跨环境共享走 `/works/*`。
- 护栏：容器内新增工具前先按 dev-container-tools 技能（用户级，保留不纳入）的
  放置决策树判断 dev/sandbox/宿主归属。

**`skills/ptl-agent/`** —— agent 驾驶 PTL 技能（P2 的试验田）：
- 覆盖当前已稳定的 `--json` 面：session（ls/stop/restore）、template ls、
  flow（run/status/ls/approve）、hub（programs/submit/run）、config get/set。
- 约定：非 TTY 下禁用 TUI 命令；错误判读（ok/data/error 结构）；
  已知未 --json 化的命令标注"人类模式，agent 避免"。

### 3.4 验收标准

1. `npm test` 全绿（含 §3.1 新测试）。
2. `ptl template ls`：`local` 消失，`root` 为默认；`cli-dev` 存在。
3. `cli-dev` 启动会话：`extensions/` 实际挂载仅保留项；`skills/` 仅 dev-cli +
   ptl-agent（+ 用户级技能，见风险 R1）；**重启后排除不被复活**。
4. 会话内实测：`yt-dlp --version`（wrapper）、`docker exec pi-platform-dev-1 rg --version`、
   `ptl ls --json` 各成功一次。

## 4. 非目标与风险

**非目标（P1 不做）**：P2/P3/P4 工作项；扩展 proxy 方案；`~/.agents/skills/`
用户级技能的治理；cli-dev 预装任何业务 CLI 技能（bailian 等）。

**风险**：
- **R1 用户级技能仍会加载**：`~/.agents/skills/`（obsidian-cli、agent-reach、
  grilling、dev-container-tools）由 pi 直接加载，排除机制管不到。P1 接受此残留；
  用户级治理是独立议题。
- **R2 保留扩展的隐性依赖**：ptl-providers/questionnaire.ts 若 import `_shared`
  或已排除扩展，排除后启动报错。已静态检查（两者仅依赖 pi SDK 与 typebox，
  不引用 `_shared`），测试覆盖启动路径兜底。
- **R3 容器名耦合**：`docker exec` 依赖 compose 生成的容器名，compose project
  变更会破坏技能文案。缓解：技能内给出 `docker compose ps` 动态探测的兜底命令。
- **R4 provider schema 执行差异**：(b) 路线的富 schema 在不同 provider 上执行力度
  不一（P3 阶段风险；P1 不受影响）。缓解：schema 扁平化 + enum 准则（见 §1.1）。
