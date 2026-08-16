# PTH Sandbox 加固与长尾收口计划（2026-08-16）

> **计划状态：可执行（2026-08-16 建立）**。
> 承接 `packages/pth-sandbox/TODO.md` 全部长尾、`docs/superpowers/explorations/2026-08-15-pth-sandbox-security-audit.md`
> P1/P2 中未被模块化 v2 P2 收编的残余，以及旧
> `2026-08-15-pth-execution-isolation.md` Task 5/6 的三个孤儿交付物
> （`verify-clean-sandbox-build.sh`、hostile integration matrix、security operations doc）。
>
> 与 `2026-08-15-pth-modularization-v2.md` 并列，二者不重复：
> - **v2 P2** 继续拥有 Execution 隔离主体：grant 化（P2-1/P2-2）、cancel-ack-release（P2-3）、
>   输出上限与进程组收割（P2-4）、KnowledgeBroker（P2-5）、liveness/readiness 拆分与
>   `check-sandbox-env.sh` 路径修正（P2-6）。
> - **本计划** 拥有 v2 P2 之外的全部沙箱安全/观测/可交付性长尾。
> - 语义重叠点只有两个：S0-1（H8）与 v2 P2-5 同源、S1-5（degraded 观测）与 v2 P2-6 相邻；
>   先落的一侧为准，后落的一侧只做适配，不重复实现。
>   此外 v2 P2-3/P2-4/P2-6 与本计划 S1-1/S1-4/S1-5 共享沙箱热点文件——归属见文末「并行执行约定」。

## 输入与基线（2026-08-16 实测）

- `packages/pth-sandbox/TODO.md`：8 项长尾全部 `[ ]`；其中「编译核/gdb 容量复核」「健康观测」
  在代码里已部分超前实现，本计划按**残余缺口**拆任务，不再重做已有部分。
- 审计 P1/P2 残余：Bash 固定完成标记跨流竞态、gdb 会话 ID 生成竞态与 GDB MI pending 关联、
  编译 cache key 不含 compiler 身份、`StreamJob` 单 `onDone`、host shutdown 未完整 dispose。
- 孤儿交付物：`scripts/verify-clean-sandbox-build.sh`、`test/pth-execution/sandbox-security.integration.test.ts`、
  `docs/pth/sandbox-security-operations.md` 均不存在（已核实磁盘）。
- 基线：全量 204 文件 / 1716 测试绿；`npm run lint`、`npm run build` 绿；工作树干净。

## 工程约束（继承 v2）

- 每个子项 = 一个独立提交；先写失败测试再实现（TDD）。
- 每阶段结束运行阶段门禁：全量 `npx vitest run` + `npm run lint` + `npm run build` 绿线；
  S2 另加 `docker compose -f deploy/docker-compose.yaml config` 与 sandbox clean-build 冒烟。
- 只暂存该子项列出的文件；`git diff --cached --check` 通过后提交。
- 不重做已落地内容：P0-1~P0-5 安全整改、kernel lease、workload allowlist、编译核
  maxCache/maxCacheBytes/并发信号量、gdb 会话上限与 idle 回收、PTH 侧 degraded 监控
  ——只做回归保护与缺口补全。

---

## S0：安全纵深闭合（H8/H9 + 流式限量 + symlink 防线）

### - [x] S0-1 HIGH：Python/Bash 记忆桥 space 盖章改为请求层带外（程序不可伪造）

- 现状：`pth-memory-lib.ts` 从 `_NAMESPACE._PTH_SPACE` 读 space 并塞进 body；PyKernel 把
  `_PTH_SPACE` 写进 exec globals（`py-kernel.ts:84-87`）；BashKernel 前置
  `export PTH_MEMORY_SPACE=...` 且 seed 函数读 `$PTH_MEMORY_SPACE`（`bash-kernel.ts:30-32,109`）。
  三者都在任务代码可写的命名空间/env 里——注释自认「程序可自改盖章」。
- 目标行为：
  - 记忆库 body **不再出现调用方可控的 `space` 字段**；space 权威来自服务端
    （PTH gateway 的 auth token 声明 / 未来 v2 P2-5 的 grant），sandbox 转发路径继续剥 body.space。
  - PyKernel 每次 execute 仍接收协议级 space，但保存在 runtime 闭包（非 exec globals）中，
    记忆库经只读 provider 取用；任务代码看不到、改不动。
  - BashKernel 不再 `export PTH_MEMORY_SPACE`，seed 函数不再传 space 参数；
    任务代码自造同名 env/函数不影响可见性。
  - kernel-mode（`PTH_PYTHON_MODE/PTH_BASH_MODE=kernel`）保持可用：缺 bridge 凭据时
    fail-closed，不允许退化回 body 自报 space。
- 文件：Modify `packages/pth-memory/src/pth-memory-lib.ts`、
  `packages/pth-sandbox/src/py-kernel.ts`、`packages/pth-sandbox/src/bash-kernel.ts`；
  Modify `test/pth-kernel-execution/space-governance.test.ts`、
  `packages/pth-sandbox/test/py-kernel.test.ts`、`packages/pth-sandbox/test/bash-kernel.test.ts`。
- 验收：
  - 测试证明任务代码打印 globals/env 看不到盖章变量；
  - 测试证明任务代码改写 `_PTH_SPACE`/`PTH_MEMORY_SPACE`/同名 shell 函数后，下一次
    `memory.query` 的可见空间不变（由服务端盖章决定）；
  - 直连 PTH 桥与 sandbox 转发两条路径的 memory 三操作均不再因 body.space 产生 400；
  - `memory.query` 仍受 PTH 侧 op 白名单 + `meta` 可见性过滤。

### - [x] S0-2 HIGH：web.fetchText DNS rebinding 防护

- 现状：只做 URL hostname 字面量检查（`capability.ts:208-218`）；fetch 用全局 DNS，
  `public.example → 169.254.x.x` 的 rebinding 未挡。
- 目标行为：解析与连接用同一份受检地址——对目标 hostname 执行自定义 lookup，
  **任一解析结果为 loopback/私网/链路本地/保留段即整体拒绝**；连接 pin 到已受检地址，
  不在检查后再触发第二次解析；`redirect: follow` 的每一跳都要重新校验。
- 文件：Modify `src/pth/impls/kernels/capability.ts`（引入受检 lookup/undici connect 配置）；
  Modify `test/pth-kernel-interpreter/web-capability.test.ts`。
- 验收：
  - mock 解析：公网域名解析到 `127.0.0.1`/`10.x`/`169.254.x`/IPv6 `::1`/`fe80::` 全部拒绝；
  - 多地址解析中混入一个私网地址即拒绝；
  - 302 跳转到私网地址被拒；
  - 现有字面量防护与正常公网 fetch 测试保持绿。

### - [x] S0-3 MEDIUM：web.fetchText 改流式限量

- 现状：`res.arrayBuffer()` 先全量下载、后判 `> maxBytes`（`capability.ts:232-234`）。
- 目标行为：用 `res.body` 流式累加，达到 `maxBytes` 立即 abort 并抛错；
  用 `TextDecoder(stream:true)` 拼接，多字节 UTF-8 字符跨 chunk 不裂；
  超限时上游连接在完整 body 传输前被关闭。
- 文件：Modify `src/pth/impls/kernels/capability.ts`；
  Modify `test/pth-kernel-interpreter/web-capability.test.ts`。
- 验收：
  - 现有 maxBytes/timeout/HTML 剥离测试绿；
  - 新增测试：mock 流服务在收到 abort/连接关闭后才继续发送（证明未全量下载）；
  - 新增测试：中文等多字节内容跨 chunk 解码正确。

### - [x] S0-4 LOW：readSource / toolstore symlink 防线

- 现状：`read-source.ts` 只做 `normalize` 词法越界；`toolstore.ts` 只做 `path.resolve` 前缀判断；
  均无 `lstat/realpath`，symlink 文件或 symlink 目录组件可逃出白名单根。
- 目标行为：先 `realpath` 白名单根与目标父目录，最终路径必须仍在根内；
  对最终文件 `lstat` 拒绝 symlink；readText 命中目录时保持既有 EISDIR 语义；
  残余 TOCTOU（lstat 与 open 之间被替换）在代码注释中如实标注为已接受边界。
- 文件：Modify `src/pth/kernel/interpreter/read-source.ts`、
  `src/pth/kernel/interpreter/toolstore.ts`；
  Create `test/pth-kernel-interpreter/read-source.test.ts`；
  Modify `test/pth-kernel-interpreter/toolstore.test.ts`。
- 验收：
  - symlink 文件指向根外文件 → 拒绝且不泄露内容；
  - symlink 目录组件 + 正常文件名 → 拒绝；
  - 根内正常文件/目录读取行为不变；
  - 既有越界/类型校验测试保持绿。

### - [x] S0-5 阶段门禁

- 全量 `npx vitest run`、`npm run lint`、`npm run build` 绿。
- 独立提交：只暂存 S0 列出的文件，`git diff --cached --check` 通过。
- 执行证据（2026-08-16）：lint/build 绿；全量 1733/1733 用例通过；
  两次全量运行各有 1–2 个 testcontainers 用例 `afterAll` 容器停止超时（环境性），
  `transcript-audit.test.ts` 与 `pg.test.ts` 单跑全绿。
- 联合门禁（合入 v2 P0 后，`98b24e8`）：lint/build 绿；210 文件 / 1759 用例中 1758 通过；
  1 个 timing 敏感的 batch fork 集成用例与 1 个 testcontainers `afterAll` 超时为环境性 flake，
  `batch-manager-fork.integration.test.ts`、`pg.test.ts`、`transcript-audit.test.ts` 单跑全绿。
- 同步 v2 P1-1/P1-2 后回归（`ef422a7`）：lint/build 绿；211 文件 / 1769 用例中 1768 通过；
  唯一失败为 v2 侧 mid-P1 的 `phase-boundaries.test.ts`（`pg-task-repository.ts` 新违规未入 baseline，
  属 v2 P1 未完成态，非本计划代码）。

---

## S1：观测与容量缺口（N5 L3 + 残余竞态）

### - [ ] S1-1 MEDIUM：kernel 池容量/回收/TTL 观测接入 N5 资源环（L3）

- 现状：`/kernel/status` 与 `obs.kernels()` 已存在；`obs.resource()` 聚合里没有 kernels。
- 目标行为：
  - `kernel-pool` 增加计数器：acquire 成功/池满拒绝/TTL dispose/lease 拒绝/release 幂等次数，
    进 `/kernel/status`（不含可预测 kernel id）；
  - `obs.resource()` 增加 `kernels` 数据源（复用受信 `/kernel/status` 通路，失败降级
    `{ error }` 不炸聚合）；
  - compose 不新增必须配置的 env（沿用 `PTH_SANDBOX_KERNEL_URL`/`SANDBOX_URL`）。
- 文件：Modify `packages/pth-sandbox/src/kernel-pool.ts`、
  `packages/pth-sandbox/src/kernel-host.ts`、`src/pth/kernel/extensions/obs.ts`；
  Modify `packages/pth-sandbox/test/sandbox-kernel-host.test.ts`；
  Create `test/pth-kernel-extensions/obs-resource.test.ts`。
- 验收：status 含计数且池满/TTL dispose 后数值正确；`obs.resource()` 在 sandbox URL
  可达时含 `kernels`，不可达时降级为 error 字段且其余数据源照常。

### - [ ] S1-2 MEDIUM：编译核 cache key 纳入 compiler 身份

- 现状：`hash = sha256(source)`（`compiled-kernel.ts:154`），gcc/clang/tcc 同源码会撞同一产物；
  磁盘/并发上限已实现，不在本项重做。
- 目标行为：cache key 至少包含 `cc` 身份（建议 `${cc}\n${source}`）；
  旧 hash 目录不改写、由既有 maxCacheBytes 淘汰逻辑自然清出；
  变更编译器后同源码不命中旧产物。
- 文件：Modify `packages/pth-sandbox/src/compiled-kernel.ts`；
  Modify `packages/pth-sandbox/test/compiled-kernel.test.ts`。
- 验收：测试证明同源码不同 cc 各自 build、各自 cache-hit；
  现有持久缓存恢复/磁盘上限/并发测试保持绿。

### - [ ] S1-3 MEDIUM：gdb 会话 ID 竞态与 GDB MI pending 关联复核

- 现状：会话上限（`PTH_DEBUG_SESSIONS`）与 30min idle 回收已落；
  `CDebugSession.id = c-debug-${Date.now().toString(36)}`（`gdb-mi.ts:220`）并发可撞；
  `pending` 队列在下一批 MI 记录到达时整体 resolve（`gdb-mi.ts:292-294`），无请求级关联。
- 目标行为：
  - 会话 id 改随机 UUID 或单调 id + 随机后缀，kernel-host 入 Map 前做唯一性检查；
  - GDB MI 每个 in-flight 请求带 token，响应按 token 派发（或按现有串行协议证明无重入后
    在代码注释固化「单飞约束」并补重入拒绝测试）；
  - attach 失败/会话被回收路径不残留 `.debug/<id>` 工作目录与 gdb 进程。
- 文件：Modify `packages/pth-sandbox/src/gdb-mi.ts`、`kernel-host.ts`；
  Modify `packages/pth-sandbox/test/gdb-mi.test.ts`、`sandbox-debug-session.test.ts`。
- 验收：并发 attach 无 id 碰撞；乱序/重入响应不被错派；回收后目录清理；
  现有 debug 全链路测试绿。

### - [ ] S1-4 MEDIUM：Bash 完成标记跨流竞态 + StreamJob 多订阅 + shutdown dispose

- 现状：Bash 固定标记 `__BASH_DONE_$?__`（`bash-kernel.ts:224-285`），用户输出可伪造标记；
  `StreamJob.onDone` 单槽（`exec-api.ts:73`）多 SSE 订阅会漏通知；
  host shutdown 未完整 dispose kernel pools/debug sessions/stream jobs。
- 目标行为：
  - Bash 每次 execute 生成一次性随机标记，解析只认当前 pending 请求的标记；
    标记独立成行写入，跨 stdout/stderr 分片不再错配；
  - `StreamJob` 完成通知改订阅者集合（每个 SSE 订阅独立收到结束事件）；
  - kernel-host/exec-api 提供可 await 的 dispose：释放全部 pool entries、detach 全部 debug
    会话、结束并清空 stream jobs，供测试与优雅关闭使用。
- 文件：Modify `packages/pth-sandbox/src/bash-kernel.ts`、`exec-api.ts`、`kernel-host.ts`；
  Modify `packages/pth-sandbox/test/bash-kernel.test.ts`、`sandbox-exec-api.test.ts`、
  `sandbox-kernel-host.test.ts`。
- 验收：
  - 程序自己 echo 固定旧标记不会提前结束；
  - 双订阅同时收到完成事件；dispose 后无残留子进程/定时器（测试断言 pool/debug/jobs 为空）。

### - [ ] S1-5 MEDIUM：sandbox 侧 degraded 观测（与 v2 P2-6 readiness 互补）

- 现状：PTH 侧 degraded 监控已落（`sandbox-bash.ts:91` + `routes-self.ts`）；
  sandbox 自身 `/health` 无条件 200、`/kernel/status` 无 degraded 维度。
- 目标行为：
  - sandbox 侧跟踪依赖条件：共享密钥缺失（kernel 路由 503）、bridge token 缺失
    （memory-bridge 503）、pool 满拒绝、编译并发满拒绝——任一持续即 `degraded`；
  - `/kernel/status` 增加 `degraded: boolean` + `reasons[]`；状态跃迁打日志，
    不在此项改动 `/health` 语义（交给 v2 P2-6 liveness/readiness 拆分接线）。
- 文件：Modify `packages/pth-sandbox/src/kernel-host.ts`（或新增
  `packages/pth-sandbox/src/health-state.ts`）；
  Modify `packages/pth-sandbox/test/sandbox-kernel-host.test.ts`。
- 验收：缺密钥/缺 token/池满场景 status.degraded=true 且 reasons 准确；
  恢复后转 false；与 v2 P2-6 落地后的 readiness 接线留 TODO 注释。

### - [ ] S1-6 阶段门禁

- 全量 `npx vitest run`、`npm run lint`、`npm run build` 绿。
- 独立提交：只暂存 S1 列出的文件，`git diff --cached --check` 通过。

---

## S2：可交付性与证据（旧 Task 5/6 孤儿项 + 命名收口）

### - [x] S2-1 LOW：sandbox-bash / kernel-host 协议文档与命名一致性

- 现状：`sandbox-bash.ts`（无状态 `/exec` 客户端）与 `BashKernel`（持久 REPL kernel）两套命名
  并存；`concepts.md:377,388,744` 对后端实体的描述已过时（声称 kernel-host 同时处理 python/ts/bash）；
  `packages/pth-sandbox` 无 README。
- 目标行为：新建 `packages/pth-sandbox/README.md`，给出端点/协议/命名对照表
  （exec-api `/exec`+SSE / kernel-host `/kernel/*` lease 协议 / sandbox-bash=BashInterpreter 客户端 /
  BashKernel=本地持久 REPL / py-kernel / compiled / gdb）；修正 concepts/deployment 中的过时描述；
  保持 `sandbox-bash.ts` 文件名不变（历史兼容），只统一文档称谓。
- 文件：Create `packages/pth-sandbox/README.md`；Modify `docs/pth/concepts.md`、
  `docs/pth/deployment.md`（如 env 表缺 `PTH_DEBUG_SESSIONS`/`PTH_DEBUG_IDLE_MS` 一并补）。
- 验收：文档中每个 sandbox 端点都有唯一名称与归属模块；grep 确认
  `kernel-host 同时处理 python/ts/bash` 类过时表述清零；无代码行为变化。

### - [x] S2-2 可交付性：`scripts/verify-clean-sandbox-build.sh`

- 现状：脚本不存在；`check-sandbox-env.sh` 仍扫根目录旧路径（该修复归 v2 P2-6，本项不抢）。
- 目标行为：脚本从干净源码执行
  `docker compose -f deploy/docker-compose.yaml config`（`:?` 变量校验保留，缺失即失败）
  + `docker build --no-cache -f packages/pth-sandbox/Dockerfile.sandbox .`；
  构建阶段不注入任何密钥；任一命令失败脚本非零退出；成功输出镜像 id 与
  `packages/pth-sandbox/Dockerfile.sandbox` 路径供记录。
- 文件：Create `scripts/verify-clean-sandbox-build.sh`；Modify `package.json`
  （新增 `verify:sandbox-build` 脚本，不改动现有脚本语义）。
- 验收：Dockerfile 路径缺失时脚本失败；正常 clean build 退出 0；
  `docker compose config` 在未提供 `SANDBOX_SHARED_SECRET` 时失败（`:?` 生效）。
- 执行证据（2026-08-16）：缺失密钥分支实测非零退出；`npm run verify:sandbox-build`
  完整跑通（compose config + 无缓存镜像构建，镜像 `sha256:65a3d30a…`，构建未注入密钥）。

### - [ ] S2-3 证据：hostile integration matrix

- 现状：`test/pth-execution/` 不存在；旧 Task 6 Step 1 的 7 项敌对矩阵没有自动化承接。
- 目标行为：Create `test/pth-execution/sandbox-security.integration.test.ts`，
  以 `PTH_SANDBOX_INTEGRATION=1` 显式门控 + docker 可用性检测；无门控时 skip 且不报错；
  用独立 compose project name 起一次性拓扑，注入 tenant A/B 合成数据后断言：
  1. A 的执行不能读 B 的 workspace/artifact/task/memory/transcript/audit；
  2. malformed/expired/wrong-language/wrong-generation/replay 的 grant/lease 被拒；
  3. workload 读不到 controller/PTH 的 secret 文件、env、socket、DB URL、docker socket；
  4. 可预测 kernel id、body 自报 space、无凭据 memory-bridge、默认密钥均不能授权；
  5. cancel/transport abort/controller timeout/pool expiry/worker crash 不重发活跃 REPL；
  6. 递归后代被收割、输出 flood 被截断、清理后资源指标回落；
  7. sandbox 控制面不出现在宿主发布端口，只走 internal 网络。
- 验收：无门控 `npx vitest run test/pth-execution` 显示 skip；
  有门控 + docker 环境下矩阵全绿；README/plan 记录运行方法与清理命令。
- 依赖：第 2/4/5 条在 v2 P2 grant/cancel-ack 未落地前只能断言**当前协议**的拒绝行为
  （lease 校验已有）；计划按当前实现编写，v2 P2 落地后由 S2-5 收账时补矩阵列。

### - [ ] S2-4 运维：`docs/pth/sandbox-security-operations.md`

- 现状：文件不存在；审计「建议的处置顺序」与 P0 整改后没有统一运维手册。
- 目标行为：覆盖密钥轮换（`SANDBOX_SHARED_SECRET` / `PTH_MEMORY_BRIDGE_TOKEN`）、
  controller 健康与 lease-drain、授权失败/replay/撤销响应、工作区清理、事故证据采集、
  安全回滚（回滚不得恢复默认密钥/公开 memory-bridge 行为）；
  与 `docs/pth/deployment.md` 互链。
- 文件：Create `docs/pth/sandbox-security-operations.md`；Modify `docs/pth/deployment.md`
  （安全运维段链接）。

### - [ ] S2-5 收账：包 TODO 勾平 + 审计状态回填 + 阶段门禁

- 文件：Modify `packages/pth-sandbox/TODO.md`（勾平已落项，保留未落项与理由）、
  `packages/pth-memory/TODO.md`（readSource/toolstore symlink 行勾平并指向本计划 S0-4）、
  `docs/superpowers/explorations/2026-08-15-pth-sandbox-security-audit.md`（P1/P2 逐项状态回填）。
- 门禁：全量 `npx vitest run`、`npm run lint`、`npm run build` 绿；
  `docker compose -f deploy/docker-compose.yaml config` 通过；
  `./scripts/verify-clean-sandbox-build.sh` 通过（有 docker 环境时）。
- 独立提交：只暂存本子项列出的文档与账本文件。

---

## 并行执行约定（2026-08-16 用户裁决：fork 两侧并行）

> 本计划与 `2026-08-15-pth-modularization-v2.md` 由 fork 出的两侧并行推进；
> 形态 = **双翼交错、热点串行**。v2 侧持有热点文件期间，本计划 S1 系列一律等待。

### 热点文件归属（串行区）

| 文件 | 持有侧 | 本计划等待点 |
|---|---|---|
| `packages/pth-sandbox/src/kernel-host.ts`、`exec-api.ts`、`bash-kernel.ts`、`py-kernel.ts`、`compiled-kernel.ts`、`gdb-mi.ts`、`kernel-pool.ts` | v2 P2（P2-2~P2-6）完成前 | S1-1~S1-5 不得开工 |
| `packages/pth-sandbox/test/sandbox-kernel-host.test.ts` 及上述包运行期测试 | 同上 | 同上 |
| `package.json` | 轮流 | 只新增独立 script 键 `verify:sandbox-build`，与 v2 的 `check:pth-boundaries` 先后提交 |
| memory-bridge 协议 | 本计划 S0-1 先行 | v2 P2-5 在其后只做 grant 适配 |

### Wave 调度

1. **Wave 1（并行翼）**：本计划 S0-2/S0-3/S0-4/S2-1/S2-2 ‖ v2 P0。
2. **Wave 2（并行翼）**：本计划 S0-1 ‖ v2 P1。
3. **Wave 3（热点串行）**：v2 P2-1~P2-7 独占沙箱热点文件并消费 S0-1；
   P2-6 合并本计划 S1-5 的 degraded 状态输入；P2 完成后释放 →
   本计划按 S1-1 → S1-2 → S1-3 → S1-4 顺序补齐。
4. **Wave 4（收尾并行翼）**：本计划 S2-3/S2-4 ‖ v2 P3。
5. **Wave 5**：本计划 S2-5 收账；两侧合入主线后跑联合全量门禁。

### Fork 工程约束

- 两侧使用独立 git worktree/branch；子项独立提交；Wave 结束合入共同主线再跑该 Wave 联合门禁。
- 下一 Wave 开工前必须在主线确认对侧完成；热点文件未释放不得越界。
- 生产/实机部署与 `docker compose` 冒烟只在合入主线后的 Wave 门禁执行，fork 分支上只跑
  单测/全量 vitest/lint/build。
- 全部子项完成前，本文件是 sandbox 长尾的唯一执行入口；新增沙箱范围变更先更新本文件或另立新计划。
