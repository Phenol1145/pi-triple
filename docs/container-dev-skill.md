# 容器开发 skill——在容器中开发扩展后端

**版本**：v1.0
**日期**：2026-08-08
**状态**：生效（framework 拆分 Plan C Task 3）
**读者**：开发者（人）+ 未来 AI 主会话（本文档可被整体加载为 skill 指导）
**相关文件**：
- 镜像定义：`Dockerfile.dev`（本文 §1.2 基于 **已提交版本** 描述，工作区 WIP 见 §1.5）
- 服务编排：`docker-compose.yaml`（`dev` 服务，§1.3）
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

dev 容器 = **多语言开发工作区**（G 阶段），PTL 外接工具环境 + 开发者工作台共用。入口：

```bash
docker compose up -d dev      # 启动（首次自动 build）
docker compose ps dev         # 状态
docker compose exec dev bash  # 进入（默认 jovyan 用户）
docker compose exec -u root dev bash   # 需要 root 时
```

Jupyter 界面：`http://127.0.0.1:8888`（仅本机绑定；token 见 compose `JUPYTER_TOKEN`）。端口与 WeKnora searxng 冲突时设 `JUPYTER_PORT=8889`。

### 1.2 镜像定义（Dockerfile.dev，已提交版本逐节）

基础：`quay.io/jupyter/minimal-notebook:python-3.13`（Python 3.13 + conda/mamba）。

| 节 | 内容 | 安装用户 |
|---|---|---|
| §1 | 系统工具（apt）：`git-lfs gh jq curl wget tmux vim ripgrep sqlite3 ffmpeg tesseract-ocr z3`，`git lfs install --system` | root |
| §2 | Node：nvm v0.40.1 + LTS，`NVM_DIR=/home/jovyan/.nvm` | jovyan |
| §3 | Go：官方 tarball 装 `/usr/local/go`，`ARG GO_VERSION=1.24.2`，`GOPATH=/home/jovyan/go` | root |
| §4 | Rust：rustup，`~/.cargo/bin` | jovyan |
| §5 | uv：`~/.local/bin`（多 Python 版本管理） | jovyan |
| §6 | 数据科学包（conda base）：`pandas numpy matplotlib seaborn scikit-learn scipy`（mamba conda-forge，`mamba clean -ai`） | root |
| §7 | PTL 外接工具（开源集——**用户裁决：非开源保留本机**）：`yt-dlp`（PyPI→/opt/conda）、`agent-reach`（GitHub Panniantong）、`instsci`（GitHub rimagination，uv tool）、`chatgpt-share`（本地单文件脚本→`/usr/local/bin`） | root + jovyan |
| §8 | 目录：`/data/artifacts`（成品保留区）、`/works`（工作区），`WORKDIR /works`，`EXPOSE 8888` | root |

**USER 层级规则**（镜像内已按此分层，扩展工具时照抄）：用户级安装（nvm/rustup/uv/`uv tool`）必须 `USER jovyan`——以 root 装会把 `$HOME` 写成 root 属主，卷挂载后 jovyan 无权限写，jupyter 直接启动失败；系统级（apt、`/usr/local`、`pip`→`/opt/conda`）用 root。

### 1.3 服务编排（docker-compose.yaml `dev` 服务，已提交版本）

| 项 | 值 | 说明 |
|---|---|---|
| user | `"0:0"` | entrypoint 以 root 跑 chown，随后 `su jovyan` 降级启动 jupyter（jupyter 拒绝 root） |
| ports | `127.0.0.1:8888:8888` | 仅本机 |
| networks | `default` | 可出网 |
| volumes | 见下表 | 家目录命名卷 + 仓库绑定挂载 + 凭据只读挂载 |

**卷挂载清单**（真实值）：

```yaml
- dev-home:/home/jovyan          # 命名卷：conda env/jupyter 配置/uv 缓存/nvm 持久化
- dev-artifacts:/data/artifacts  # 成品保留区
- workspaces:/data/workspaces    # 与 pth/sandbox 共享（cwd 语义一致）
- ${HOME}/ai-teach-jupyter:/works/ai-teach-jupyter:rw
- ${HOME}/pi-platform:/works/pi-platform:rw    # ← 主仓库挂载点
- ${HOME}/docs:/works/docs:rw
- ${HOME}/Projects:/works/Projects:rw
- ${HOME}/go:/works/go:rw
- ${HOME}/.agents:/home/jovyan/.agents:ro     # agent-reach skill/配置（只读——含凭据）
```

**entrypoint**：`chown -R jovyan:users` 已知路径列表（`.local .nvm .cargo .rustup go artifacts workspaces`——新增用户级工具写入新路径时**必须**加进此列表，防命名卷属主漂移）→ `su jovyan` + 显式 PATH（`/opt/conda/bin:/usr/local/bin:/usr/bin:/bin:/home/jovyan/.local/bin:/home/jovyan/.nvm/current/bin:/usr/local/go/bin:/home/jovyan/.cargo/bin`）→ `start-notebook.sh`。

### 1.4 配套工具（tools/dev/）

| 文件 | 作用 |
|---|---|
| `tools/dev/gen-dev-wrapper.sh` | 生成宿主机 wrapper：`~/.local/bin/<tool>` → `docker compose -f ~/pi-platform/docker-compose.yaml exec -T dev <tool> "$@"`。默认 TOOLS：`agent-reach yt-dlp instsci chatgpt-share`；可传参只生成指定工具；目标是符号链接时先 rm（防写入穿透）。卸载 = `rm ~/.local/bin/<tool>` |
| `tools/dev/agent-reach-chatgpt/` | `chatgpt-share`（单文件纯 stdlib 解码器，镜像 §7 COPY 到 `/usr/local/bin`）、`chatgpt_share.py` + `chatgpt.md`（agent-reach 渠道补丁素材）、`patch-agent-reach.sh`（容器内重装渠道：CLI + channel 插件 + SKILL.md 路由注册，幂等） |
| `tools/dev/bfc/` | Brainfuck 工具（**工作区 WIP，未提交**，见 §1.5）：`bf`（beef 友好入口 shim：`-p/-c` 直传、文件、stdin 管道）、`bfc`（自写 bf→C 翻译器，纯 Python stdlib，配合 tcc 编译出可执行文件） |

### 1.5 WIP 标注（工作区未提交改动——文档按已提交版本描述，以下为现状差异）

> ⚠️ 以下改动在**工作区尚未提交**（用户 WIP）。本节的其余部分基于已提交版本；提交后请同步更新本文档。

| 文件 | WIP 改动 |
|---|---|
| `Dockerfile.dev` | 新增 §7b：apt 装 `beef`（Brainfuck 解释器）+ `tcc`（Tiny C 编译器）+ `libc6-dev`；COPY `tools/dev/bfc/bf`、`tools/dev/bfc/bfc` → `/usr/local/bin`。新增 §7c：apt 装 `gcc binutils fonts-noto-cjk`（Rust 链接必需——`/usr/bin/cc` 被 tcc 占用，lifelab 的 `core/.cargo/config.toml` 钉死 `linker=gcc`）；`uv tool install maturin`（PyO3 wheel 构建）；pip 装 `ipywidgets`。lifelab 源码在宿主挂载 `/works/labs/lifelab`，镜像重建后需跑 `docker compose exec dev bash /works/labs/lifelab/install.sh` 恢复 |
| `docker-compose.yaml` | dev 卷新增 `${HOME}/lifelab:/works/labs/lifelab:rw`；entrypoint chown 列表加 `.config .cache .jupyter .ipython` 并在启动前自动检测/重装 lifelab；`JUPYTER_TOKEN` 默认值改 `TokenForJupyter` |
| `tools/dev/gen-dev-wrapper.sh` | 默认 TOOLS 增加 `bf bfc` |
| `tools/dev/bfc/` | 整体未跟踪（untracked） |

---

## 2. 工具链

**语言运行时**（全部镜像内置，直接可用）：

| 工具 | 版本/位置 | 验证命令 |
|---|---|---|
| Python | 3.13（conda base `/opt/conda`） | `python3 --version` |
| Node.js | LTS（nvm，`/home/jovyan/.nvm/current`） | `node --version`、`npm --version` |
| Go | 1.24.2（`/usr/local/go`） | `go version` |
| Rust | rustup 最新 stable（`~/.cargo/bin`） | `cargo --version` |
| uv | `~/.local/bin`（可装任意 Python 版本） | `uv --version` |

**数据科学**（conda base env）：`pandas numpy matplotlib seaborn scikit-learn scipy`。

**系统工具**：`git-lfs gh jq curl wget tmux vim ripgrep sqlite3 ffmpeg tesseract-ocr z3`。

**PTL 外接工具**（开源集——非开源保留宿主机）：

| 工具 | 来源 | 安装层 | 用途 |
|---|---|---|---|
| `agent-reach` | GitHub Panniantong（pip git+） | `/opt/conda` | 信息检索/渠道聚合 |
| `yt-dlp` | PyPI（pip） | `/opt/conda` | 视频/媒体下载 |
| `instsci` | GitHub rimagination（uv tool） | `~/.local/share/uv` | 学术研究 |
| `chatgpt-share` | 本地单文件（`tools/dev/agent-reach-chatgpt/`） | `/usr/local/bin` | ChatGPT 分享会话解码（JS 渲染页专用后端） |

**Brainfuck 工具**（工作区 WIP 已装，见 §1.5）：`bf`（beef 解释器入口：`bf -p 'CODE'` / `bf FILE.bf` / `echo 'CODE' | bf`）、`bfc`（编译：`bfc hello.bf -o hello`，自动探测 `tcc → cc → gcc`；`--emit-c` 只输出 C 源码；`-c` 命令行直读）。

**宿主机 wrapper 机制**（工具在容器、命令在宿主机）：`bash tools/dev/gen-dev-wrapper.sh` 生成 `~/.local/bin/<tool>`，此后宿主机（含 PTL）直接敲 `<tool>` 即透传容器内执行，现有调用零改动。wrapper 依赖 dev 容器已启动。

**各语言在容器内新增依赖**（临时，落卷或镜像层）：

```bash
docker compose exec dev pip install <pkg>            # Python → /opt/conda（镜像层，重建丢）
docker compose exec dev uv tool install <pkg>        # CLI → ~/.local/share/uv（dev-home 卷，保留）
docker compose exec dev npm i -g <pkg>               # Node 全局（nvm 目录，保留）
docker compose exec dev mamba install -c conda-forge <pkg>  # 数据科学 → /opt/conda（镜像层）
docker compose exec -u root dev apt-get install -y <pkg>    # 系统工具（镜像层）
```

固化进镜像（长期工具）→ 编辑 `Dockerfile.dev`（注意 §1.2 USER 层级规则）+ 重建 + `gen-dev-wrapper.sh` 生成 wrapper，完整流程见 `docs/superpowers/dev-container-tool-guide.md` §2 路径 B。

---

## 3. 开发流程

**总览**：`挂载仓库 → 改代码 → 容器内验证 → 导出`。仓库已由 compose 绑定挂载（`~/pi-platform:/works/pi-platform:rw`），**宿主机与容器共享同一份文件**——改代码在宿主机编辑器做、验证在容器内做，无需拷贝。

### Step 1｜启动并进入

```bash
docker compose up -d dev
docker compose exec dev bash        # jovyan 用户；root 操作加 -u root
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
| 成品文件 | `/data/artifacts`（dev-artifacts 卷，持久） | `docker compose exec dev cp result.txt /data/artifacts/` |
| 取回宿主机 | — | `docker compose exec dev cat /data/artifacts/x` 或 `docker cp pi-platform-dev-1:/data/artifacts/x ./x` |
| 与 sandbox 共享 | `/data/workspaces`（共享卷） | 双容器同路径直读，无需搬运 |

### Step 5｜完整示例（走一遍）

```bash
# 1. 启动
docker compose up -d dev

# 2. 挂载仓库已在 compose 定义——直接改宿主 ~/pi-platform/extensions/foo/index.ts

# 3. 容器内验证
docker compose exec -T dev bash -lc 'cd /works/pi-platform && npm run build && npm test'

# 4. 导出：构建产物固化到成品区
docker compose exec dev bash -lc 'cp -r /works/pi-platform/dist /data/artifacts/foo-dist'

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
        │  docker compose -f ~/pi-platform/docker-compose.yaml exec -T dev <cmd>
        ▼
dev 容器（完整工具链 + 出网 + 可信）→ 执行 → 退出码/输出透传回宿主
```

**为什么选 dev 容器**：sandbox 无网无密钥（中间态，不可信）；宿主机缺多语言工具链；dev 有完整工具链（§2）+ 可出网 + 可信环境——扩展后端的开发/验证/运行都在这。

### 4.2 命令族接口约定（Task 4 落地）

实现见 `packages/extensions-in-container/`（`/container` 命令族），接口约定：

| 命令 | 行为 | 底层操作 |
|---|---|---|
| `/container start [--name]` | 启动 dev 容器 | `docker compose up -d dev` |
| `/container mount <dir>` | 挂载仓库目录（写入 compose `dev.volumes`） | 编辑 `docker-compose.yaml` |
| `/container verify <cmd>` | 容器内运行验证命令 | `docker compose exec -T dev bash -lc <cmd>`，退出码透传 |
| `/container status` | 容器状态 | `docker compose ps dev`（或 docker-monitor `http://localhost:9090`） |

### 4.3 挂载点与路径约定

| 用途 | 容器路径 | 备注 |
|---|---|---|
| 仓库 | `/works/<name>`（`~/pi-platform` → `/works/pi-platform`） | 绑定挂载，rw |
| 家目录持久层 | `/home/jovyan`（dev-home 命名卷） | conda env/uv 缓存/nvm/配置 |
| 成品 | `/data/artifacts`（dev-artifacts 卷） | 导出目的地 |
| 与 pth/sandbox 共享 | `/data/workspaces` | cwd 语义一致 |
| 凭据配置 | `/home/jovyan/.agents` | 只读挂载（`:ro`），不注入密钥 |

### 4.4 扩展开发检查清单

1. 扩展需要什么工具链？→ 对照 §2；缺失先 `docker compose exec dev <pkgmgr> install`（临时）或固化进 `Dockerfile.dev`；
2. 命令薄壳只做参数解析 + `exec` 转发——**逻辑放容器内**；
3. 验证：`/container verify '<命令>'` 退出码必须能反映成败（`-T` 非 TTY + 透传）；
4. 导出：成品写 `/data/artifacts`，代码提交走仓库挂载。

---

## 5. 最佳实践

### 5.1 卷挂载

- **家目录用命名卷**（`dev-home:/home/jovyan`）：conda env、jupyter 配置、uv 缓存、nvm 重启/重建不丢；
- **仓库用绑定挂载**（`~/xxx:/works/xxx:rw`）：双向同步，宿主编辑容器验证，零拷贝；
- **含凭据的配置只读挂载**（`:ro`，如 `~/.agents`）：防容器内误写；
- **新增用户级工具写入新路径** → 把该路径加进 compose entrypoint 的 chown 列表（命名卷首次挂载不保留镜像属主，会 root 属主漂移）；
- **新增绑定挂载** → 编辑 compose `dev.volumes`（Task 4 提供 `/container mount`）。

### 5.2 密钥不注入（用户裁决）

- dev 容器**不注入任何 LLM/服务密钥**——不写 compose env、不烧镜像；
- 确需时临时给：`docker compose exec -e DEEPSEEK_API_KEY=xxx dev bash`（进程级，容器重启即失效）；
- 工具凭据（agent-reach cookies 等）走只读卷挂载（`~/.agents:ro`）或容器内 `<tool> configure`。

### 5.3 构建产物导出

- 成品统一落 `/data/artifacts`（dev-artifacts 卷，持久保留）；
- 取回宿主机：`docker compose exec dev cat /data/artifacts/...` 或 `docker cp pi-platform-dev-1:/data/artifacts/x ./x`；
- 与 sandbox 共享走 `/data/workspaces`（同卷同路径，无需搬运）；
- 代码产物（dist 等）直接写仓库挂载目录，宿主机即可见可提交。

### 5.4 USER 层级与属主

- 用户级安装（nvm/rustup/uv/uv tool）**必须 `USER jovyan`**——root 安装导致家目录 root 属主 → jupyter 启动失败；
- 系统级（apt、`/usr/local`、pip→`/opt/conda`）用 root；
- 容器内 root 操作：`docker compose exec -u root dev ...`（jupyter 进程本身拒绝 root，勿用 root 启 notebook）。

### 5.5 镜像重建注意事项

| 改动位置 | 重建后 | 恢复方法 |
|---|---|---|
| `/opt/conda`、`/usr/local/bin`、apt 包（镜像层） | **丢失** | 重跑对应 `RUN`（固化进 Dockerfile 才持久） |
| `~/.local/share/uv`、`~/.nvm` 等（dev-home 卷） | 保留 | — |
| agent-reach 的 chatgpt_share 渠道补丁（site-packages） | **丢失**（pip 重装重置） | 重跑 `tools/dev/agent-reach-chatgpt/patch-agent-reach.sh` |
| lifelab（WIP §7c，源码在挂载） | wheel/包丢失 | `docker compose exec dev bash /works/labs/lifelab/install.sh` |

### 5.6 坑与教训（实测沉淀）

1. **USER 层级**：用户级工具 root 安装 → 家目录属主错 → jupyter 起不来（§5.4）；
2. **卷属主漂移**：命名卷首次挂载不保留镜像属主——entrypoint chown 列表要覆盖所有用户级路径；
3. **tcc 占用 `/usr/bin/cc`**（WIP §7b/§7c）：Rust 链接需要 gcc——项目 `core/.cargo/config.toml` 钉死 `linker=gcc`，勿依赖系统默认 cc；
4. **jupyter 拒绝 root**：entrypoint chown 后必须 `su jovyan` 降级启动；
5. **端口冲突**：jupyter 8888 与 WeKnora searxng 撞 → `JUPYTER_PORT=8889`；
6. **wrapper 符号链接穿透**：`~/.local/bin/<tool>` 若是软链，`cat >` 会写坏链接目标——`gen-dev-wrapper.sh` 已先 rm；手写 wrapper 同样先查 `ls -la`；
7. **非开源二进制不进容器**：Mach-O（kimiim-cli/obsidian/claude/qodercli）Linux 容器不可执行，保留宿主机；
8. **容器内 npm 原生模块**：宿主（macOS）装的 node_modules 原生产物在容器（Linux）不可用——容器内重装（§3 Step 3 提示）；
9. **临时安装 vs 固化**：路径 A（exec 装）方便但镜像层改动重建即丢——长期工具走 Dockerfile.dev（路径 B，见 dev-container-tool-guide §2）。

---

*文档维护：Dockerfile.dev / docker-compose.yaml / tools/dev/ 变化时同步更新本文；工作区 WIP（§1.5）提交后移除标注并合并进正文。*
