# LLM→工具调用→执行核 链路筛查报告（2026-08-15）

> 触发：memory-keeper 实机任务报告 PTC surface 误判「逗号连声明 + 两字母变量名」。
> 方式：三个只读审计子代理（PTC 契约与执行核链 / agent-loop 工具调用链 / 记忆·文件·能力注入面）+ 主会话语料复现。
> 验证基线：全量 vitest 195 文件 / 1645 用例全绿；tsc 干净。

## 一、本次已修复

### PTC 能力面预检（ptc/surface.ts）
- ✅ 逗号连声明 / let-var 多声明：逐项解析声明符（此前只收第一个，`rb` 被误判未注入能力）
- ✅ 对象方法简写 / getter / setter / class 方法 / `function*`：方法名入安全名（此前 `name(` 被当直接调用根）
- ✅ 除法链 `a / b / c`：正则字面量启发式按「前邻上下文」区分除号与正则（此前整段被剥成 `/x/` 吞掉后续代码）
- ✅ `if/while (foo())` 的 foo 漏检：扫描改用负向后行断言，不再消费前导字符
- ✅ 控制流头部成员访问漏检（`if (foo.bar)`）、TS 非空断言漏检（`foo!.bar` / `foo!()`）
- 已知边界文档化：模板串 `${}` 插值、`if (x) /re/` 语句位正则、含空白正则字面量

### 只读 SQL 执行器（storage/index.ts）
- ✅ H1 表名白名单旁路：逗号连表 / `TABLE` 子句显式拒绝
- ✅ H2 假 LIMIT 绕过：LIMIT 检测只在噪声掩码后的真实代码上做；统一外层子查询强制封顶
- ✅ M1 有副作用 SELECT：拒绝 `nextval/setval/lo_*`、`FOR UPDATE/SHARE`、`SELECT INTO`

### 记忆可见性与写入面
- ✅ H3 缺 meta 列默认公开 → fail-closed：会话空间下 `memory.query` / Python 记忆桥查询必须含 `meta` 列，否则拒绝
- ✅ H5 `state.recall*` 绕过可见性：召回面接入会话空间过滤
- ✅ H6 `memory.update` 字段白名单（拒绝 meta 提权）；governance 层 official 条目内容冻结
- ✅ H7 伪造系统恢复源：`worker-role` / `space-reg` / `worker-index` 归入 prompt 层（worker 拒写）

### 工具执行面
- ✅ HIGH-1 bash 失败回填 `error: unknown`：stderr/error 真实写回 tool 消息
- ✅ MEDIUM-1 负结果引导与真实结果共用 toolCallId 被去重：合并为同一条 tool 消息
- ✅ MEDIUM-2 unknown-tool / empty-done / empty-reply 护栏从不重置：在非命中路径显式 reset
- ✅ MEDIUM-4 provider `arguments: null` 打崩任务：llm-fn 对象化 + executeStep 入口防御
- ✅ LOW-4 缺 `tool_calls[].function` 的畸形响应不再二次解引用

### 文件与网络
- ✅ H4 `fs.task` 路径穿越：`resolve + relative` 词法包含校验（`sub/../../etc/passwd` 拒绝）
- ✅ H9 SSRF 字面量防护：localhost / 私网 / 链路本地 **IP 字面量**拒绝（DNS rebinding 留给出站防火墙，见下）
- ✅ M3 `ext.db.query` 签名错配：改接 `queryTemplate` 双参通道
- ✅ M4 `memory.write` 位置形签名被契约误拒：validate 兼容双签名
- ✅ M7 runner 二次截断丢 `truncated` 标志
- ✅ M6 ts-interpreter 把字符串/注释里的 `import/require` 当真实代码拒绝
- ✅ 契约失真：`memory.query` / `memory.write` returnType 与注入实现对齐；`state.recall*` 签名改 `anchors: string[]`；`fs.list` 契约改无参；`asAction` 不再生成 `"undefined"`

## 二、未修（已挂 TODO，按优先级）

| 级别 | 问题 | 位置 | 说明 |
|---|---|---|---|
| HIGH | Python 记忆桥 `space` 可在程序内伪造 | py-kernel / pth-memory-lib | 软治理已文档化；根治需请求层带外盖章 |
| HIGH | ts-interpreter `insertBeforeReturn` / 尾表达式提取在字符串内切分 | ts-interpreter.ts | 字符串含 `return`/`;` 的合法程序会被拒；需 noise-aware 尾表达式提取 |
| HIGH | DNS rebinding SSRF（主机名 → 私网） | web.fetchText | 本机 DNS 沙箱把公网域名解析到保留段，DNS 校验会误杀全部出站；字面量防护已上，出站边界留给网络策略 |
| MEDIUM | 非 ASP 模式 schema 声明 ASP-only 工具 | agent-tools/agent-loop | schema 面与执行面应同源 |
| MEDIUM | ASP 内联工具异常未捕获 | agent-loop 571-682 | 打崩任务而非回填错误 |
| MEDIUM | 解构默认值 / 模板插值 / `as` 断言漏检 | ptc/surface | 守卫漏报（M2/M3/M5） |
| MEDIUM | `ext.syncIndex` 永远失败；`memoryScope:own` 读侧未过滤；`manage.scheme.publish` id 未校验 | ext-capability / kernel-manager / manage | 一致性 + 纵深 |
| MEDIUM | web.fetchText 超限检查在完整下载后 | capability.ts | 改流式限量 |
| LOW | 别名门控 / 工具描述重复 / symlink 逃逸 / 命名不一致 | agent-loop / read-source / toolstore | 收尾批 |

## 三、结论

- 触发误判（逗号声明/短变量名）已根修，并有回归测试钉死。
- 三路筛查共确认 9 个 HIGH、约 15 个 MEDIUM、若干 LOW；本轮修复 9 个 HIGH 中的 7 个（剩余 2 个为架构级：Python 桥盖章、DNS rebinding）及多数可低成本修复的 MEDIUM。
- 剩余项已进入 TODO 待办，建议下一批按表内顺序处理。
