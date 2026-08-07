# 联邦运行时恢复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把联邦运行时从"裸进程 + 旧 dist"切到容器化栈：重建 dist → 清理裸/僵尸进程 → compose 栈拉起 → runbook §9 冒烟。

**Architecture:** pth/sandbox/redis 按 `docker-compose.yaml` 定义拉起（pth 双网络、sandbox internal-only）；旧裸 pth（PID 44236，8/3 旧构建）停止，其数据 `.pi-platform-data/` 原样保留不删；容器化栈数据在 docker 命名卷（canonical 存储）。

**Tech Stack:** docker compose、pit CLI（hub 命令）、curl 健康探测。

**Runbook:** `docs/superpowers/runbooks/2026-08-05-containerized-federation.md`（§2 启动、§8 已知边界、§9 冒烟清单）

## Global Constraints

- 仓库在 main 直接工作（ops 任务，无/极少代码改动；遵循仓库既有约定）
- **禁止删除** `.pi-platform-data/`（旧裸 pth 数据，保留备查）
- **禁止动** 宿主原生 redis（PID 3152，localhost:6379）——compose redis 走内部网络 `redis://redis:6379`，两者互不干扰
- **禁止动** dev 容器（`pi-platform-dev-1`，独立于本计划）
- 冒烟中发现 runbook 与实际不符 → 记录到报告，仅在 Task 5 统一修订，不得边跑边改
- 提交信息风格：`<type>(<scope>): 中文摘要——细节`

---

### Task 1: 构建与测试门禁

**Files:**
- 无持久改动（验证性任务）

**Interfaces:**
- Produces: 最新 `dist/`（pth 镜像构建与本地 pit CLI 共用）；测试绿色证据

- [ ] **Step 1: 重建 dist**

```bash
cd /Users/anzhize/pi-platform && npm run build
```

Expected: tsc 无错误；`ls -la dist/pth/main.js dist/ptl/pit.js` 时间为当前。

- [ ] **Step 2: 全量测试 + lint**

```bash
npm test && npm run lint
```

Expected: 全绿（≥950 用例）。失败则 BLOCKED 上报（不得带病切换）。

- [ ] **Step 3: 记录构建指纹**

```bash
git rev-parse HEAD && ls -la dist/pth/main.js
```

写入报告（Task 4 冒烟时比对镜像来源）。

---

### Task 2: 停旧运行时

**Files:**
- 无（进程操作）

**Interfaces:**
- Consumes: Task 1 绿色门禁
- Produces: :3000 空闲；无 pth/僵尸测试进程

- [ ] **Step 1: 清理僵尸测试进程**

```bash
ps -p 24976 -o pid,command | tail -1    # 确认是 assembly-integration 测试
kill 24976; sleep 2; ps -p 24976 || echo "cleaned"
```

若仍存活：`kill -9 24976`。

- [ ] **Step 2: 停裸 pth**

```bash
ps -p 44236 -o pid,command | tail -1    # 确认是 node dist/pth/main.js
kill 44236                              # 优雅停止
sleep 5; ps -p 44236 || echo "stopped"
```

仍存活则 `kill -9`，并在报告标注（可能丢懒落盘窗口内的会话——runbook §8 已知边界）。

- [ ] **Step 3: 验证端口释放**

```bash
lsof -iTCP:3000 -sTCP:LISTEN || echo ":3000 free"
```

Expected: `:3000 free`。

---

### Task 3: 容器化栈拉起

**Files:**
- 无（compose 操作）

**Interfaces:**
- Consumes: Task 1 dist、Task 2 空闲端口
- Produces: pth/sandbox/redis 三容器 healthy；:3000 由容器 pth 服务

- [ ] **Step 1: 构建并拉起**

```bash
cd /Users/anzhize/pi-platform && docker compose up -d --build pi-platform sandbox redis 2>&1 | tail -15
```

注意：不要加 `--build` 到全栈默认（会连带重建 dev 镜像）；服务名是 `pi-platform`（不是 pth）。

- [ ] **Step 2: 等待健康**

```bash
sleep 15 && docker compose ps
```

Expected: pth / sandbox / redis 均 Up（healthy 或 starting——sandbox/pth 有 healthcheck）。
若 starting 超过 60s：`docker compose logs pth | tail -30` 排查并记录。

- [ ] **Step 3: 健康验证**

```bash
curl -sf http://localhost:3000/health && echo && lsof -iTCP:3000 -sTCP:LISTEN | grep -c docker
```

Expected: `{"status":"ok",...}`（sandbox 正常时无 degraded 字段或 degraded:false）；监听者为 docker 进程。

---

### Task 4: runbook §9 冒烟

**Files:**
- Create: 报告文件（SDD workspace 内）：冒烟结果逐项 PASS/FAIL/SKIP + 原始输出摘录

**Interfaces:**
- Consumes: Task 3 健康栈
- Produces: 冒烟报告（含 §9 五项逐项结论）

按 runbook §9 顺序执行（`docs/superpowers/runbooks/2026-08-05-containerized-federation.md` 185-213 行）：

- [ ] **Step 1: 基线（§9.1）** — `docker compose ps` 全 healthy + `curl -sf localhost:3000/health`
- [ ] **Step 2: 构件闭环（§9.2）**

```bash
ptl hub submit examples/pr-review/
ptl hub programs
ptl hub request "冒烟：缺一个 X" --slot slot-a
ptl hub requests
ptl hub respond <id> examples/pr-review/
```

每步记录输出；`respond` 后 `requests` 应无 open。

- [ ] **Step 3: 定时/事件（§9.3）** — best-effort：`/lab schedule` 需 pi 会话内斜杠命令，
  无现成会话则 SKIP 并在报告标注"人工验证项"；`ptl hub observe events` 可独立执行则跑。
- [ ] **Step 4: sandbox 降级/恢复（§9.4）**

```bash
docker compose stop sandbox && sleep 3 && curl -s localhost:3000/health    # 期望 503/degraded（可能需连续失败到阈值 3——多打几次）
docker compose start sandbox && sleep 12 && curl -sf localhost:3000/health  # 恢复 200
```

- [ ] **Step 5: 持久化（§9.5）**

```bash
docker compose stop pi-platform sandbox redis && docker compose start pi-platform sandbox redis && sleep 20
curl -sf localhost:3000/health && ptl hub programs    # 构件仍在（冒烟提交的 program 可见）
```

用 stop/start 代替 down/up：等效验证卷持久化且避免误删栈外定义；若需严格 down/up，先确认无其他 compose 依赖。对照 runbook §2 持久化不变量清单逐项确认。

---

### Task 5: 收尾

**Files:**
- Modify: runbook/docs 仅当冒烟发现不符（否则无改动）

- [ ] **Step 1: 汇总报告** — 合并 Task 1-4 报告：最终状态表（容器/端口/数据位置）+ 残留风险 + 人工验证项清单
- [ ] **Step 2: runbook 修订（条件）** — 冒烟中发现命令/输出与实际不符之处，最小化修订 runbook 并说明依据
- [ ] **Step 3: 提交（条件）** — 有文档改动才提交：

```bash
git add docs/ && git commit -m "docs(runbook): 联邦运行时恢复冒烟修订——<要点>"
```

无改动则跳过，报告注明。
