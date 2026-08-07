# ptl CLI 使用体验审计（framework 拆分前盘点）

- 日期：2026-08-07
- 审计对象：`src/ptl/`（PTL CLI，bin: `ptl` → `dist/ptl/pit.js`，v0.1.1）
- 审计方法：**实际操作**（`node dist/ptl/pit.js` 真实运行 20+ 命令，观察真实输出/退出码/错误路径）+ **代码走查**（UX 关键文件 15 个）+ TUI 只读代码审查（未运行交互 TUI/onboard）
- 环境：macOS，Node v24.14.1，tmux 就绪，`~/.pi-triple/` 已配置（3 模板：local/knowledge/dev），有本地 PTH
- 审计命令清单：`ptl`(裸)、`ptl help`、`ptl -h`、`ptl help start/ls/stop/session/config/tui/zzz`、`ptl --version/-v`、`ptl status`、`ptl status --json`、`ptl doctor`、`ptl template ls`、`ptl template ls --json`、`ptl template`、`ptl template rm`、`ptl ls`、`ptl ls --json`、`ptl stop <name>`、`ptl stop --all`、`ptl stop --stale`、`ptl restore`、`ptl config`、`ptl config get/set/unset`、`ptl session ls`、`ptl session ls --json`、`ptl trace ls`、`ptl flow ls`、`ptl flow ls --json`、`ptl flow`、`ptl agent`、`ptl hub programs/requests/observe/run`、`ptl shared status`、`ptl tui foo`、`ptl frobnicate`、`ptl submit`（废弃迁移）、`ptl start --json`、`ptl onboard --json`（未运行交互 onboard）

---

## UX 审计报告

### 体验问题清单

| # | 严重度 | 维度 | 问题 | 证据(命令/文件:行) | 建议 |
|---|--------|------|------|--------------------|------|
| 1 | **高** | C | **`ptl stop --all` 是坏命令，但错误提示主动推荐它**。实测 `ptl stop --all` 报 `❌ 用法: ptl stop <name> \| --stale \| --orphans`（连 `--all` 都没列出）。根因：parseArgs 把 `--all` 解析成 flag，`run.ts:214` 传给 dispatch 的是 `["", "--all"]`，`execStop` 的 `if (!name)`（commands.ts:304）先于 `if (name === "--all")`（commands.ts:310），`--all` 分支永远不可达。而 `execTemplateRm` 删除模板遇运行中会话时**明确推荐** "先执行: ptl stop --all"（commands.ts:180） | `node dist/ptl/pit.js stop --all`（exit 1）；`src/ptl/commands.ts:284-310`；`src/ptl/cli/run.ts:213-214`；`src/ptl/cli/args.ts` | 在 execStop 入口处理 `flags.all`，或把 `--all` 收进 VALUED_FLAGS/stop 的 arg 语义；统一提示与实现；usage 消息补 `--all` |
| 2 | **高** | D | **pit→ptl 改名残留：11 处用户可见输出仍在推荐 `pit <cmd>`**。`ptl ls` 底部、`flow ls` 底部、`hub programs/request/observe` 底部、模板解析失败提示、agent 输出、flow 命名空间帮助头等全部打印 `pit attach/stop/restore/template ls/hub run/flow status…`。用户照做即 "command not found"（bin 已只剩 `ptl`） | 实测：`ptl ls` → "接入: pit attach…"；`ptl flow ls` → "查看: pit flow status…"；`ptl hub programs` → "运行: pit hub run…"。源码：`src/ptl/commands.ts:279`、`src/ptl/flow/commands.ts:209`、`src/ptl/cli/onboard.ts:33`、`src/ptl/cli/sessions.ts:80,242`、`src/ptl/cli/agent.ts:86`、`src/ptl/cli/run.ts:79`、`src/ptl/cli/route.ts:88`、`src/ptl/bridge/programs.ts:34`、`request.ts:69`、`observe.ts:52` | 全局 `pit ` → `ptl ` 替换（保留测试里对旧名的断言单独处理）；拆分前必须清零 |
| 3 | **高** | C | **`ptl tui <未知面板>` 抛未捕获异常，输出裸 Node 堆栈**。`ptl tui foo` 输出 `Fatal: Error: 未知 TUI 面板: "foo"…` + 完整 stack trace。resolveTuiPanel 用 throw 表达用户输入错误，cmdTui/main 均未捕获 | 实测：`node dist/ptl/pit.js tui foo`；`src/ptl/cli/route.ts:28-32`（throw）、`src/ptl/cli/run.ts:299`、`src/ptl/pit.ts:16-17`（顶层 catch 打 Fatal） | resolveTuiPanel 改返回 `null`/错误值，cmdTui 打印 `❌ 未知 TUI 面板…可用: dashboard \| lab` 并 exit 1；顶层 catch 对已知用户错误走 emitJsonError/友好消息 |
| 4 | 中 | C/D | **doctor 把"有更新待办"显示为绿色 ✅**。"pi 更新 — 当前 v0.83.0 → 最新 v0.84.1" 标 ✅ 且全绿"所有检查通过"。warn 被 runDoctorStructured 归为 ok（`status === "ok" \|\| status === "warn"`） | 实测：`node dist/ptl/pit.js doctor`；`src/ptl/doctor.ts` checkPiUpdate（warn 分支）与 `runDoctorStructured` ok 判定 | warn 单独用 ⚠️ 呈现，且"所有检查通过"文案仅在无 warn/fail 时输出；doctor 汇总行给出"有可用更新" |
| 5 | 中 | C/A | **doctor 是"开发仓库视角"体检，对装好的 ptl 用户失准**：`npm 依赖 — 已安装`（查 cwd/node_modules）、`数据目录 — ./.pi-platform-data 可写`（cwd 相对目录，非真实 `~/.pi-triple/data`）；失败时的建议 "运行 npm run doctor 重新检查"（doctor.ts:456）指向**不存在的 npm script**（package.json scripts 无 doctor） | 实测：`node dist/ptl/pit.js doctor`；`src/ptl/doctor.ts:250-275`（checkNpmDeps/checkDataDir）、`doctor.ts:456`；`package.json` scripts | doctor 改为检查真实 config 的 dataDir/sharedDir 可写性；去掉 npm 依赖检查或改为检查 ptl 自身依赖；重跑建议改 `ptl doctor` |
| 6 | 中 | D | **配置版本号与字段名过时**：`ptl config init`/onboard 输出 "pi-triple.json 已创建 (v2, UUID+alias)"，但 `CURRENT_VERSION = 3`；`ptl config` 帮助行列出 `defaultTenant`（不存在，实为 `defaultTemplate`）；TUI config 页也渲染 "defaultTenant" 标签 | 实测：`node dist/ptl/pit.js config`；`src/ptl/cli/config-cmd.ts:12,61`、`src/ptl/cli/onboard.ts:125`、`src/ptl/tui-ptl/config-page.tsx:41`、`src/ptl/config.ts:44` | 版本号统一取 CURRENT_VERSION；defaultTenant→defaultTemplate 全量替换 |
| 7 | 中 | D | **banner 策略不一致**：大部分命令先打 "Pi-Triple v0.1.1" banner（template ls/ls/status/session ls/trace ls/hub programs/shared status），但 `ptl flow ls`、`ptl config`、`ptl flow` 命名空间帮助不打；`ptl ls`/`ptl status` 还额外多打一个空行 | 实测对比 `ptl flow ls`（无 banner）vs `ptl session ls`（有 banner）；`src/ptl/cli/run.ts:206-211`（ls 分支手动 banner+空行）、`src/ptl/flow/commands.ts:195-211`（flow ls 无 banner） | 统一走 `doPrintCommand`/单一渲染入口；banner 只打一次，尾部空行格式统一 |
| 8 | 中 | F | **flow 帮助双源漂移**：`ptl help flow`（main.ts NAMESPACE_HELP.flow）只有 5 条命令，而 `ptl flow`（run.ts 默认分支）列出 13 条（含 resume/propose/discard/edit/set/graph/rm）；且 `FLOW_SUBCOMMANDS`（dispatch.ts:30）缺 `propose`/`discard`——CLI 支持（run.ts:71,74）但 TUI 命令栏/共享分发层到不了 | 实测：`ptl help flow` vs `ptl flow` 输出不一致；`src/ptl/cli/main.ts` NAMESPACE_HELP.flow、`src/ptl/cli/run.ts:78-96`、`src/ptl/commands/dispatch.ts:30` | NAMESPACE_HELP 作为唯一事实源（补齐全部子命令），run.ts 默认分支改为复用；dispatch 集合与 CLI 集合同源生成 |
| 9 | 中 | B | **高频命令没有单命令帮助**：`ptl help ls`、`ptl help stop`、`ptl help status`、`ptl help attach` 全部回落到全量帮助（COMMAND_HELP 只有 start/tui/hub/onboard/doctor 5 个）；`help <未知>` 也静默打全量帮助且 exit 0 | 实测：`node dist/ptl/pit.js help ls` → 全量帮助；`src/ptl/cli/main.ts` COMMAND_HELP | 为 ls/stop/status/attach/switch/restore 补 usage+flags+examples；未知 topic 打印 `❌ 未知命令帮助: zzz` 并 exit 1 |
| 10 | 中 | B | **`ptl session ls` 输出噪音大且无表头**：行形如 `○ [pi] 019fdb2f… dev ○ 停止 · 6 事件` —— "○" 状态标记出现两次（前缀一个 + summary 内嵌一个）；无列头、无分页/`--limit`，本环境 33 行全量输出 | 实测：`node dist/ptl/pit.js session ls`；`src/ptl/commands/session.ts:34-39`（execSessionLs 拼接） | summary 里去掉重复状态符号；加列头（与 `ptl ls` 风格一致）；支持 `--limit`/`--stopped` 过滤 |
| 11 | 中 | B | **`ptl trace ls` 原始倾倒**：1702 行无表头、无截断，整串 UUID + tool call id 全打印，扫一眼无法定位信息；无分页 | 实测：`node dist/ptl/pit.js trace ls`；`src/ptl/commands/trace.ts` | 截断 id（8 位）、加列头（seq/time/delta/agent/summary）、默认取最近 N 条 |
| 12 | 中 | A/B | **交互 `ptl start` 无法命名会话，自动名晦涩**：picker 二步向导（模板→模式）把名字硬编码为 `session-<base36 时间戳>`（如 `local-ms9xn2h8`），没有命名输入步；且 Select 的 allowCustom/"输入自定义"是死代码——`customMode` 永不被置 true，提示语误导 | `src/ptl/picker.tsx:29,36`（customMode 不可达）、`picker.tsx:137`（自动名）；实测 `ptl ls` 中 `dev-msgyywee`/`local-ms9xn2h8` | 向导加"会话名"一步（默认建议 `<alias>-<n>` 递增序号）；删除不可达 custom 分支或真正实现输入模式 |
| 13 | 中 | B/D | **`ptl config` 全量 dump 含敏感字段**：直接 `JSON.stringify(config)` 打印整个 pi-triple.json，若配置了 `pth.token` 会明文落到 stdout（共享终端/CI 日志泄露面）；且无色彩、无键名提示在前 | `src/ptl/cli/config-cmd.ts:48-61`（无 sub 分支） | 默认隐藏 token（`pth.token: "***"`）；展示分节（模板表 + 全局键），引导 `config get/set` |
| 14 | 低 | C | **usage 类错误退出码不一致**：`ptl hub run`（无参）、`ptl agent`（无 sub）打印用法但 **exit 0**；同类 `ptl config get`（无 key）exit 1 | 实测：`ptl hub run` exit 0、`ptl agent` exit 0、`ptl config get` exit 1；`src/ptl/bridge/run.ts`、`src/ptl/cli/run.ts:286-289` | 用法错误统一 exit 1（脚本可用性） |
| 15 | 低 | D | **JSON 模式被启动更新提示污染**：`ptl start --json` 在 JSON 前输出 `⚠ pi SDK 更新可用…`（走 stderr，2>&1 消费者会看到噪声）。maybePrintUpdateHint 在 mode 解析前执行 | 实测：`node dist/ptl/pit.js start --json`；`src/ptl/cli/run.ts:156-160`、`src/ptl/version.ts:27-48` | JSON 模式跳过 update hint；或 hint 加 `ptlJsonMode` 判断 |
| 16 | 低 | E | **共享层状态只有计数**：`ptl shared status` 输出 "扩展: 14 · 技能: 9 · 包: 4"，无扩展名、无 bundled vs 用户自定义区分、无失效 symlink 检测。"扩展可管理"目标下可视性不足 | 实测：`node dist/ptl/pit.js shared status`；`src/ptl/shared-layer.ts` sharedStatus（仅计数）、`src/ptl/commands.ts` execSharedStatus | 输出扩展名清单 + 来源徽标（bundled/用户/shared）+ 断链警告 |
| 17 | 低 | F/D | **帮助分组反映不出"framework + 插件"边界**：hub（远端程序/回退/观测/调试）、flow、agent、tui lab 都可能是未来插件，但帮助无"核心 vs 插件"视觉分层，也无插件注册入口；组标题"远端程序 — PTH"容纳了 request/respond/observe/debug 等非"程序"命令 | `src/ptl/cli/main.ts` HELP_GROUPS（"远端程序"组含 9 命令）；`docs/ptl/architecture.md` | 帮助按"核心（日常/会话/模板/配置）+ 插件（hub/flow/agent/lab）"两级分组；插件可声明自己的 help 段 |
| 18 | 低 | A | **首次运行指引不检查配置存在性**：裸 `ptl` 只打 4 行 getting-started，不检测 `pi-triple.json` 是否存在、不提示 `ptl doctor`；无配置时 `ptl template ls` 会显示一个未持久化的幻影 "local" 模板（loadConfig 返回 defaultConfig 但不落盘） | 实测裸 `ptl`；`src/ptl/cli/main.ts` printGettingStarted；`src/ptl/config.ts:53-56`（defaultConfig 未保存） | getting-started 检测配置缺失时加一行 `ptl onboard` 强化提示；空状态"（无模板…）"（commands.ts:230）实际不可达，删或改为引导 onboard |

### 亮点（保留的）

1. **裸 `ptl` 的 4 行上手指引**简洁清晰（首次/日常/可视化/全部），比多数 CLI 的空输出好（main.ts printGettingStarted）。
2. **onboard 四步结构**（环境检查→配置→模板→验证）带 Step 编号、进度线、完成 🎉 与"立即打开 TUI"收尾问题，是好的首次引导骨架（onboard.ts:115-147）。
3. **JSON 模式单出口 + 结构化错误码**：`emitJson/emitJsonError` 与 `ERR.*` 常量集中，`--json` 输出统一 `{ok,data,error}`；实测 `ls/template/status/session/flow/hub programs --json` 全部干净可解析（mode.ts + output.ts）。
4. **废弃命令迁移提示**：`ptl submit` → `⚠️ ptl submit 已迁移：请使用 ptl hub submit`（route.ts DEPRECATED_COMMANDS），clean-break 处理到位。
5. **错误提示链普遍带下一步**：`template rm` 遇运行中会话给出 `ptl stop --all` 指引（虽然该指引本身坏，见 #1）；`config set` 未知键列出全部可用键；`attach` 失败提示 `ptl ls`；模板解析失败提示 `ptl template ls`。
6. **CommandResult/doPrintCommand/dispatch 分层**：纯函数命令 + 渲染解耦 + handoff（spawn `ptl <新命令>`）设计干净，是后续插件化的好地基（commands.ts / dispatch.ts）。
7. **tmux 会话管理防御到位**：会话名消毒（validateSessionName）、`=` 精确匹配、stale/orphan 清理、csi-u 服务端配置（tmux.ts）。
8. **TUI 命令栏层级补全 + 会话能力过滤菜单**（command-bar.tsx COMMAND_TREE、session-menu.tsx capability 过滤）设计用心；dashboard 单次 spawn 批量拉 pane 信息（性能注释可见）。

### 总结

- **改名欠账是最高优先级**（#2、#6 一部分）：pit→ptl 的用户可见残留 11+ 处 + `defaultTenant`/v2 字样，拆分前必须清零，否则帮助系统反而教用户打错命令。
- **两个功能性坏命令**：`ptl stop --all`（#1，且被别处推荐）与 `ptl tui <面板>` 裸堆栈（#3），都是"用户走主流程必踩"级别。
- **状态可见性**（维度 B）双速：`ptl ls/status` 已经不错（状态标记/模板/模型/年龄），但 `session ls`/`trace ls` 是原始倾倒，缺少与 `ptl ls` 同级的打磨。
- **输出一致性**（维度 D）是系统性问题：banner 有无、pit/ptl 混用、版本号过时，根源是渲染分散在 run.ts/main.ts/commands/flow/bridge 多处，缺少单一渲染管线。
- **信息架构**（维度 F）：帮助分组已按主题切好，但"核心 vs 插件"边界未显式化，flow 帮助双源漂移是当下最具体的 IA 债。
- 建议拆分前按 **#1→#3→#2→#6** 顺序修复（功能正确性 > 命名一致性 > 文案过时），随后统一渲染管线与帮助单一事实源，最后再做扩展可视性（#16）。

---

*审计期间副作用说明：`ptl restore` 实测时启动了 3 个 tmux 会话，已用 `ptl stop <name>` 全部清理并 `ptl ls` 复核为空。*
