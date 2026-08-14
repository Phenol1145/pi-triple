# 容器开发 skill——在容器中开发扩展后端

**版本**：v1.0
**日期**：2026-08-08
**状态**：生效（framework 拆分 Plan C Task 3）
**读者**：开发者（人）+ 未来 AI 主会话（本文档可被整体加载为 skill 指导）
**相关文件**：
- 镜像定义：`deploy/Dockerfile.dev`（本文 §1.2 基于 **已提交版本** 描述，工作区 WIP 见 §1.5）
- 服务编排：`deploy/docker-compose.yaml`（`dev` 服务，§1.3）
- 配套工具：`tools/dev/`（`gen-dev-wrapper.sh`、`agent-reach-chatgpt/`、`bfc/`，§1.4）
- 姊妹篇（工具迁移视角）：`docs/superpowers/dev-container-tool-guide.md`
- 设计 spec：`docs/superpowers/specs/2026-08-05-dev-container-design.md`
- 运维 runbook：`docs/superpowers/runbooks/2026-08-05-containerized-federation.md` §10
- 扩展承载（Task 4 实现）：`packages/extensions-in-container/`（`/container` 命令族，§4）

**本文回答一个问题**：我要开发/验证一个扩展后端（任意语言：Node/Python/Go/Rust），**怎么在 dev 容器里完成"改代码 → 验证 → 导出"全流程**。

---

## 0. 何时使用本文档（触发条件）

出现以下任一情形时，按本文档操作：

1. 需要 **Node/Python/Go/Rust/数据科学** 工具链执行或验证代码（宿主机没有或版本不一致）；
2. 需要 **出网** 抓取/下载/研究（`yt-dlp`、`agent-reach`、`curl` 等）——dev 容器可出网（`default` 网络）；
3. 需要 **多语言混编** 验证（如 Brainfuck 编译、Rust 链接、PyO3 wheel 构建）；
4. 要开发 **跑在容器里的 pi 扩展后端**（扩展命令在宿主机注册、执行体在容器内——§4 模式）；
5. 宿主机是 macOS，目标运行环境是 Linux——用容器保证行为一致。

**不需要用容器**：纯宿主已有工具链能完成的工作；不可信/一次性执行（那是 **sandbox** 的职责，egress 锁定、无密钥）；非开源二进制（Mach-O，Linux 容器跑不了，保留宿主机）。

> 三容器职责速记：**sandbox** = 不可信代码执行（中间态，无网无密钥）；**dev** = 开发/验证/成品保留（可信，可出网，无密钥注入）；**宿主机** = 平台原生依赖与非开源工具。

---

## 1. 容器环境

### 1.1 总览

dev 容器 = **PTL 工具容器**（2026-08-12 瘦身版——G 阶段），承载外接工具（agent-reach/yt-dlp/bfc/chatgpt-share）。
**jupyter 已独立为 compose `jupyter` 服务**（官方 minimal-notebook——数据科学工作台单独跑）。入口：

```bash
docker compose up -d dev      # 启动（首次自动 build——秒级）
docker compose ps dev         # 状态
docker compose -f deploy/docker-compose.yaml exec -T dev bash  # 进入（root 单用户——工具容器无多用户）
```

Jupyter（独立服务）：`http://127.0.0.1:8888`（仅本机绑定；token 见 compose `JUPYTER_TOKEN`）。端口与 WeKnora searxng 冲突时设 `JUPYTER_PORT=8889`。

### 1.2 镜像定义（deploy/Dockerfile.dev，已提交版本逐节）

基础：`python:3.13-slim`（工具全为 python 生态）。体积 ~559MB（对比 jupyter 基座时代 1.5GB——瘦 63%）。

| 节 | 内容 | 安装方式 |
|---|---|---|
| §1 | 系统工具（apt）：`curl git ca-certificates beef tcc libc6-dev`（beef=Brainfuck 解释器，tcc=bfc 的 C 编译器） | root |
| §2 | pip 工具：`yt-dlp`（PyPI）、`agent-reach`（GitHub Panniantong） | root |
| §3 | uv（按需——容器内不预装 instsci：宿主机已有 `~/.local/bin/instsci`，用户裁决迁移本地） | root |
| §4 | bfc/bf 工具（纯 Python stdlib——`tools/dev/bfc/`）→ `/opt/tools/bfc/` + `/usr/local/bin` symlink | root |
| §5 | chatgpt-share（`tools/dev/agent-reach-chatgpt/`）→ `/opt/tools/chatgpt-share/` | root |
| §6 | 目录：`WORKDIR /works`；entrypoint 长驻（`tail -f /dev/null`——wrapper exec 直执行） | root |

**热修改**（2026-08-12 新增）：compose 将宿主机 `tools/dev/bfc` → `/opt/tools/bfc`、`tools/dev/agent-reach-chatgpt` → `/opt/tools/chatgpt-share` **bind 挂载**——改宿主机源码容器内立即生效，免 rebuild。

### 1.3 服务编排（deploy/docker-compose.yaml `dev` 服务，已提交版本）

| 项 | 值 | 说明 |
|---|---|---|
| user | 默认（root） | 工具容器单用户——无 jupyter 拒绝 root 问题 |
| ports | 无 | 工具容器不暴露端口（jupyter 独立服务暴露 8888） |
| networks | `default` | 可出网 |
| volumes | 见下表 | 热改源码 + 工作区 + 凭据只读挂载 |

**卷挂载清单**（真实值）：

```yaml
- ${HOME}/pi-platform/tools/dev/bfc:/opt/tools/bfc:rw               # 热改源：bf/bfc（改即生效）
- ${HOME}/pi-platform/tools/dev/agent-reach-chatgpt:/opt/tools/chatgpt-share:rw  # 热改源：chatgpt-share
- ${HOME}/.agents:/root/.agents:ro     # agent-reach skill/配置（只读——含凭据）
- ${HOME}/pi-platform:/works/pi-platform:rw    # 主仓库挂载点
- ${HOME}/docs:/works/docs:rw
- ${HOME}/Projects:/works/Projects:rw
- ${HOME}/go:/works/go:rw
```

**entrypoint**：`exec tail -f /dev/null`（长驻——wrapper `exec -T dev <tool>` 直执行工具；不跑 jupyter/不跑服务）。

**jupyter 独立服务**（compose 新增，2026-08-12）：`quay.io/jupyter/minimal-notebook:python-3.13` 官方镜像——jovyan/conda/start-notebook.sh 原生生态完整保留；挂载 `jupyter-home` 卷（/home/jovyan）+ 工作区；healthcheck curl 8888。

### 1.4 配套工具（tools/dev/）

| 文件 | 作用 |
|---|---|
| `tools/dev/gen-dev-wrapper.sh` | 生成宿主机 wrapper：`~/.local/bin/<tool>` → `docker compose -f ~/pi-platform/deploy/deploy/docker-compose.yaml exec -T dev <tool> "$@"`。默认 TOOLS：`agent-reach yt-dlp chatgpt-share bf bfc`（instsci 不入列——宿主机已有 `~/.local/bin/instsci`）；可传参只生成指定工具；目标是符号链接时先 rm（防写入穿透）。卸载 = `rm ~/.local/bin/<tool>` |
| `tools/dev/agent-reach-chatgpt/` | `chatgpt-share`（单文件纯 stdlib 解码器，镜像 §7 COPY 到 `/usr/local/bin`）、`chatgpt_share.py` + `chatgpt.md`（agent-reach 渠道补丁素材）、`patch-agent-reach.sh`（容器内重装渠道：CLI + channel 插件 + SKILL.md 路由注册，幂等） |
| `tools/dev/bfc/` | Brainfuck 工具（**工作区 WIP，未提交**，见 §1.5）：`bf`（beef 友好入口 shim：`-p/-c` 直传、文件、stdin 管道）、`bfc`（自写 bf→C 翻译器，纯 Python stdlib，配合 tcc 编译出可执行文件） |

### 1.5 WIP 标注（工作区未提交改动——文档按已提交版本描述，以下为现状差异）

> ⚠️ 以下改动在**工作区尚未提交**（用户 WIP）。本节的其余部分基于已提交版本；提交后请同步更新本文档。

| 文件 | WIP 改动 |
|---|---|
| `deploy/Dockerfile.dev` | 新增 §7b：apt 装 `beef`（Brainfuck 解释器）+ `tcc`（Tiny C 编译器）+ `libc6-dev`；COPY `tools/dev/bfc/bf`、`tools/dev/bfc/bfc` → `/usr/local/bin`。新增 §7c：apt 装 `gcc binutils fonts-noto-cjk`（Rust 链接必需——`/usr/bin/cc` 被 tcc 占用，lifelab 的 `core/.cargo/config.toml` 钉死 `linker=gcc`）；`uv tool install maturin`（PyO3 wheel 构建）；pip 装 `ipywidgets`。lifelab 源码在宿主挂载 `/works/labs/lifelab`，镜像重建后需跑 `docker compose -f deploy/docker-compose.yaml exec -T dev bash /works/labs/lifelab/install.sh` 恢复 |
| `deploy/docker-compose.yaml` | dev 卷新增 `${HOME}/lifelab:/works/labs/lifelab:rw`；entrypoint chown 列表加 `.config .cache .jupyter .ipython` 并在启动前自动检测/重装 lifelab；`JUPYTER_TOKEN` 默认值改 `TokenForJupyter` |
| `tools/dev/gen-dev-wrapper.sh` | 默认 TOOLS 增加 `bf bfc` |
| `tools/dev/bfc/` | 整体未跟踪（untracked） |

---

## 2. 工具链

**语言运行时**（镜像内置，直接可用）：

| 工具 | 版本/位置 | 验证命令 |
|---|---|---|
| Python | 3.13（`/usr/local`——python:3.13-slim） | `python3 --version` |
| uv | `/usr/local/bin`（按需装任意 Python 版本） | `uv --version` |

> 2026-08-12 瘦身版：Node/Go/Rust/conda 数据科学栈已移除（dev 回归工具容器本职）。需要完整多语言开发环境 → **jupyter 独立服务**（minimal-notebook：Node/conda 数据科学栈）或宿主机制。

**系统工具**（apt）：`curl git ca-certificates beef tcc libc6-dev`（beef=Brainfuck 解释器；tcc=bfc 的 C 编译器）。

**PTL 外接工具**（开源集——非开源保留宿主机）：

| 工具 | 来源 | 安装层 | 用途 |
|---|---|---|---|
| `agent-reach` | GitHub Panniantong（pip git+） | `/usr/local` | 信息检索/渠道聚合 |
| `yt-dlp` | PyPI（pip） | `/usr/local` | 视频/媒体下载 |
| `chatgpt-share` | 本地脚本（`tools/dev/agent-reach-chatgpt/`） | `/opt/tools/chatgpt-share`（热改挂载） | ChatGPT 分享会话解码（JS 渲染页专用后端） |
| `instsci` | GitHub rimagination（uv tool） | **宿主机** `~/.local/bin/instsci` | 学术研究（2026-08-12 用户裁决迁移本地——254MB 不占镜像） |

**Brainfuck 工具**（`/opt/tools/bfc/`——热改挂载）：`bf`（beef 解释器入口：`bf -p 'CODE'` / `bf FILE.bf` / `echo 'CODE' | bf`）、`bfc`（编译：`bfc hello.bf -o hello`，自动探测 `tcc → cc → gcc`；`--emit-c` 只输出 C 源码；`-c` 命令行直读）。

**宿主机 wrapper 机制**（工具在容器、命令在宿主机）：`bash tools/dev/gen-dev-wrapper.sh` 生成 `~/.local/bin/<tool>`，此后宿主机（含 PTL）直接敲 `<tool>` 即透传容器内执行，现有调用零改动。wrapper 依赖 dev 容器已启动。

**各工具在容器内新增依赖**（临时，镜像层——重建丢）：

```bash
docker compose -f deploy/docker-compose.yaml exec -T dev pip install <pkg>            # Python → /usr/local（镜像层，重建丢）
docker compose -f deploy/docker-compose.yaml exec -T dev uv tool install <pkg>        # CLI → /root/.local/share/uv（镜像层，重建丢）
docker compose exec -u root dev apt-get install -y <pkg>    # 系统工具（镜像层，重建丢）
```

固化进镜像（长期工具）→ 编辑 `deploy/Dockerfile.dev`（注意 §1.2 USER 层级规则）+ 重建 + `gen-dev-wrapper.sh` 生成 wrapper，完整流程见 `docs/superpowers/dev-container-tool-guide.md` §2 路径 B。

---

## 3. 开发流程

**总览**：`挂载仓库 → 改代码 → 容器内验证 → 导出`。仓库已由 compose 绑定挂载（`~/pi-platform:/works/pi-platform:rw`），**宿主机与容器共享同一份文件**——改代码在宿主机编辑器做、验证在容器内做，无需拷贝。

### Step 1｜启动并进入

```bash
docker compose up -d dev
docker compose -f deploy/docker-compose.yaml exec -T dev bash        # root 单用户（工具容器）
```

### Step 2｜改代码

- **宿主机编辑**（推荐）：直接改 `~/pi-platform/...`——容器内 `/works/pi-platform/...` 实时同步；
- 容器内编辑：`vim`/`tmux` 已装；挂载点下任何写入宿主机立即可见；
- 其他已挂目录：`~/ai-teach-jupyter`、`~/docs`、`~/Projects`、`~/go`（→ `/works/<同名>`）。

### Step 3｜容器内验证

```bash
# 常规进入后（镜像 ENV 已含各语言 bin）：
cd /works/pi-platform

# Node 项目
npm test / npm run build / node --experimental-strip-types --test

# Python
python3 -m pytest / python3 script.py

# Go
go test ./... / go build

# Rust
cargo test / cargo build

# Brainfuck（WIP 工具）
bf -p '++++++++[>++++[>++>+++>+++>+<<<<-]>+>+>->>+[<]<-]>>.>---.+++++++..+++.>>.<-.<.+++.------.--------.>>+.>++.'
bfc hello.bf -o hello && ./hello
```

> ⚠️ **原生模块注意**：绑定挂载的 `node_modules` 若是宿主机（macOS）安装的，含原生编译产物（`.node`）的依赖在容器（Linux）内不可直接使用——容器内重新 `npm ci`（或按包平台隔离）。纯 JS 依赖无此问题。

> 💡 需要把整个命令一次性跑完（非交互）：`docker compose exec -T dev bash -lc 'cd /works/pi-platform && npm test'`。`-T` 关闭 TTY（脚本/CI 场景），退出码透传。

### Step 4｜导出

| 产物类型 | 去处 | 方法 |
|---|---|---|
| 代码改动 | 仓库本身 | 绑定挂载双向同步，宿主机直接 `git add/commit`（容器内也可 git，镜像已装） |
| 成品文件 | `/data/artifacts`（dev-artifacts 卷，持久） | `docker compose -f deploy/docker-compose.yaml exec -T dev cp result.txt /data/artifacts/` |
| 取回宿主机 | — | `docker compose -f deploy/docker-compose.yaml exec -T dev cat /data/artifacts/x` 或 `docker cp pi-platform-dev-1:/data/artifacts/x ./x` |
| 与 sandbox 共享 | `/data/workspaces`（共享卷） | 双容器同路径直读，无需搬运 |

### Step 5｜完整示例（走一遍）

```bash
# 1. 启动
docker compose up -d dev

# 2. 挂载仓库已在 compose 定义——直接改宿主 ~/pi-platform/extensions/foo/index.ts

# 3. 容器内验证
docker compose exec -T dev bash -lc 'cd /works/pi-platform && npm run build && npm test'

# 4. 导出：构建产物固化到成品区
docker compose -f deploy/docker-compose.yaml exec -T dev bash -lc 'cp -r /works/pi-platform/dist /data/artifacts/foo-dist'

# 5. 宿主机侧：提交代码（改动已在挂载目录）
cd ~/pi-platform && git add extensions/foo && git commit
```

---

## 4. 扩展开发模式（extensions-in-container：扩展跑容器里）

### 4.1 模式总览

**理念（用户裁决）**："在容器中开发扩展后端"的开发模式——pi 扩展的**命令在宿主机注册（薄壳），执行体跑在 dev 容器里**。

```
宿主 pi 主会话（用户 / AI）
        │  /container <子命令>（Task 4 扩展注册的命令族）
        ▼
packages/extensions-in-container（宿主机侧薄壳）
        │  docker compose -f ~/pi-platform/deploy/deploy/docker-compose.yaml exec -T dev <cmd>
        ▼
dev 容器（完整工具链 + 出网 + 可信）→ 执行 → 退出码/输出透传回宿主
```

**为什么选 dev 容器**：sandbox 无网无密钥（中间态，不可信）；宿主机缺多语言工具链；dev 有完整工具链（§2）+ 可出网 + 可信环境——扩展后端的开发/验证/运行都在这。

### 4.2 命令族接口约定（Task 4 落地）

实现见 `packages/extensions-in-container/`（`/container` 命令族），接口约定：

| 命令 | 行为 | 底层操作 |
|---|---|---|
| `/container start [--name]` | 启动 dev 容器 | `docker compose up -d dev` |
| `/container mount <dir>` | 挂载仓库目录（写入 compose `dev.volumes`） | 编辑 `deploy/docker-compose.yaml` |
| `/container verify <cmd>` | 容器内运行验证命令 | `docker compose exec -T dev bash -lc <cmd>`，退出码透传 |
| `/container status` | 容器状态 | `docker compose ps dev`（或 docker-monitor `http://localhost:9090`） |

### 4.3 挂载点与路径约定

| 用途 | 容器路径 | 备注 |
|---|---|---|
| 仓库 | `/works/<name>`（`~/pi-platform` → `/works/pi-platform`） | 绑定挂载，rw |
| 工具热改源 | `/opt/tools/bfc`、`/opt/tools/chatgpt-share`（`~/pi-platform/tools/dev/*`） | 绑定挂载，rw——改即生效 |
| 成品 | `/data/artifacts`（dev-artifacts 卷） | 导出目的地 |
| 与 pth/sandbox 共享 | `/data/workspaces` | cwd 语义一致 |
| 凭据配置 | `/root/.agents` | 只读挂载（`:ro`），不注入密钥 |

### 4.4 扩展开发检查清单

1. 扩展需要什么工具链？→ 对照 §2；缺失先 `docker compose -f deploy/docker-compose.yaml exec -T dev <pkgmgr> install`（临时）或固化进 `deploy/Dockerfile.dev`；
2. 命令薄壳只做参数解析 + `exec` 转发——**逻辑放容器内**；
3. 验证：`/container verify '<命令>'` 退出码必须能反映成败（`-T` 非 TTY + 透传）；
4. 导出：成品写 `/data/artifacts`，代码提交走仓库挂载。

---

## 5. 最佳实践

### 5.1 卷挂载

- **工具热改源用绑定挂载**（`~/pi-platform/tools/dev/*:/opt/tools/*:rw`）：改宿主机源码容器内立即生效，免 rebuild（2026-08-12 瘦身版核心机制）；
- **仓库用绑定挂载**（`~/xxx:/works/xxx:rw`）：双向同步，宿主编辑容器验证，零拷贝；
- **含凭据的配置只读挂载**（`:ro`，如 `~/.agents`）：防容器内误写；
- **新增绑定挂载** → 编辑 compose `dev.volumes`（Task 4 提供 `/container mount`）。

### 5.2 密钥不注入（用户裁决）

- dev 容器**不注入任何 LLM/服务密钥**——不写 compose env、不烧镜像；
- 确需时临时给：`docker compose exec -e DEEPSEEK_API_KEY=xxx dev bash`（进程级，容器重启即失效）；
- 工具凭据（agent-reach cookies 等）走只读卷挂载（`~/.agents:ro`）或容器内 `<tool> configure`。

### 5.3 构建产物导出

- 成品统一落 `/data/artifacts`（dev-artifacts 卷，持久保留）；
- 取回宿主机：`docker compose -f deploy/docker-compose.yaml exec -T dev cat /data/artifacts/...` 或 `docker cp pi-platform-dev-1:/data/artifacts/x ./x`；
- 与 sandbox 共享走 `/data/workspaces`（同卷同路径，无需搬运）；
- 代码产物（dist 等）直接写仓库挂载目录，宿主机即可见可提交。

### 5.4 属主与权限

- 工具容器 root 单用户（2026-08-12 瘦身版）——无多用户属主问题；
- 系统级安装（apt、pip→`/usr/local`）用 root（默认）；
- 宿主机文件权限决定 bind 挂载后的容器内权限（如 `tools/dev/bfc/bfc` 需 `chmod +x` 才可执行）。

### 5.5 镜像重建注意事项

| 改动位置 | 重建后 | 恢复方法 |
|---|---|---|
| `/usr/local`（pip/uv tool）、apt 包（镜像层） | **丢失** | 重跑对应 `RUN`（固化进 Dockerfile 才持久） |
| `/opt/tools`（bind 挂载） | **保留**（宿主机源码） | — |
| agent-reach 的 chatgpt_share 渠道补丁（site-packages） | **丢失**（pip 重装重置） | 重跑 `tools/dev/agent-reach-chatgpt/patch-agent-reach.sh` |

### 5.6 坑与教训（实测沉淀）

1. **基座不匹配**（2026-08-12 病根复盘）：entrypoint 的 chown jovyan/start-notebook.sh 是 jupyter 基座写法——基座换成 node/python 镜像后必崩（`chown: invalid user` 重启循环）。改基座必同步改 entrypoint；
2. **bash 引号嵌套**：bash 函数内构造 JSON（curl -d）用 python json.dumps 委托（argv 传递）——`"` 与 `'"'"'` 嵌套极易错；
3. **tcc 占用 `/usr/bin/cc`**：Rust 链接需要 gcc——项目 `core/.cargo/config.toml` 钉死 `linker=gcc`，勿依赖系统默认 cc（2026-08-12 瘦身版已移除 Rust——如复加注意）；
4. **jupyter 独立服务**：jupyter 8888 与 WeKnora searxng 撞 → `JUPYTER_PORT=8889`；
5. **wrapper 符号链接穿透**：`~/.local/bin/<tool>` 若是软链，`cat >` 会写坏链接目标——`gen-dev-wrapper.sh` 已先 rm；手写 wrapper 同样先查 `ls -la`；
6. **非开源二进制不进容器**：Mach-O（kimiim-cli/obsidian/claude/qodercli）Linux 容器不可执行，保留宿主机；
7. **大工具迁移宿主机**（2026-08-12 用户裁决）：instsci（254MB）等体积大的工具留宿主机 `~/.local/bin`，不入镜像——wrapper 无需生成（宿主机命令直接可用）；
8. **临时安装 vs 固化**：路径 A（exec 装）方便但镜像层改动重建即丢——长期工具走 deploy/Dockerfile.dev（路径 B，见 dev-container-tool-guide §2）。

---

*文档维护：deploy/Dockerfile.dev / deploy/docker-compose.yaml / tools/dev/ 变化时同步更新本文；工作区 WIP（§1.5）提交后移除标注并合并进正文。*
