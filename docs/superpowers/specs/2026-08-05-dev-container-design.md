# G 阶段设计：开发环境容器化（dev 容器）

**版本**：v0.1（草案）
**状态**：设计草案，待评审收敛
**日期**：2026-08-05
**前置**：F 阶段（`docs/superpowers/specs/2026-08-05-containerization-architecture-design.md`——pth/sandbox/redis 已容器化）
**输入裁决**（2026-08-05 用户确认）：①范围=开发环境容器（jupyter/研究工具为主，pipx CLI 逐步迁入）；②形态=新增独立 dev 容器（与 pth/sandbox/redis 并列，同 compose 编排，职责分离）；③用途=通用隔离环境（不污染系统 Python）。
**调研依据**：`/tmp/g-dev-container/1-tools-inventory.md`（本机工具清单）、`2-jupyter-stacks.md`（镜像选型）、`3-compose-integration.md`（compose 集成点）。

---

## §1 定位

**dev 容器 = 用户日常开发/研究的"干净房间"**——jupyter notebook/lab + Python 多版本 + 数据/AI 工具，全部隔离在容器内，与宿主多版本 Python（3.10/3.12/3.14 并存）+ pip 全局工具链完全解耦。

**不是**：
- ❌ 代码执行沙箱（那是 sandbox——无外部网络、无密钥、不可信）
- ❌ PTL 宿主（本机 PTL 保持 tmux 工具——F 裁决不动）
- ❌ 联邦节点（不进 hub 交互面——演进项，见 §7）

**本质**：开发环境的**生命周期管理**问题——jupyter/多语言/CLI 工具随系统 Python 安装会污染、冲突、难以复现；容器化后 `docker compose up dev` 一键可复现、可销毁重建、可版本化。

## §2 容器选型

| 项 | 选型 | 理由 |
|---|---|---|
| 基础镜像 | `quay.io/jupyter/minimal-notebook:python-3.13` | Docker Hub jupyter/* 已停更（2023-10 冻结）→ quay.io 为官方现行源；minimal 0.58G（scipy 1.3G/datascience 2.4G 过大）；Python 3.13 + conda 26.7 + mamba 2.8 内置（**多 Python 环境支持**）；非 root 用户 jovyan；端口 8888 + token 认证；卷惯例 /home/jovyan/work |
| tag 固定 | `:python-3.13`（或带日期的具体 tag） | 不用 latest——可复现 |
| 数据科学包 | 镜像内 mamba 按需装（脚本化） | minimal 只带 jupyter 基础；pandas/numpy/matplotlib 等进自定义层（§4） |
| 扩展层 | 自建 `Dockerfile.dev`（FROM 基础镜像） | 预装工具 + 启动脚本 + 配置 |

**镜像大小预算**：基础 0.58G + 数据科学包 ~0.5-0.8G + 工具 ≈ **1.3-1.5G 总量**（首次拉取+构建一次性成本；运行期零宿主污染）。

## §3 compose 集成

```yaml
  dev:
    build:
      context: .
      dockerfile: Dockerfile.dev
    ports:
      - "127.0.0.1:8888:8888"        # 仅本机访问
    networks:
      - default                        # 出网装包 + 连 pth（如需）
    volumes:
      - workspaces:/data/workspaces    # 与 pth/sandbox 共享（cwd 语义一致）
      - dev-home:/home/jovyan          # /home/jovyan 持久化（jupyter 配置/内核/conda env）
      - ./..:  # 项目目录按需挂载（§3.1）
    environment:
      - JUPYTER_TOKEN=${JUPYTER_TOKEN:-}   # 固定 token（空则随机打印）
      # LLM 密钥可选注入（dev 可信环境——§3.2）
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
      - OPENAI_API_KEY=${OPENAI_API_KEY:-}
      - DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-}
    depends_on:
      redis:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:8888/api"]
      interval: 30s
      timeout: 5s
      retries: 3
```

**网络**：default（出网——装包/LLM API 必需）。与 sandbox 的 internal 隔离**不共享**（职责分离：sandbox=不可信执行，dev=可信开发）。

**端口**：`127.0.0.1:8888`（仅本机）。⚠️ **WeKnora searxng 默认占 8888**——compose 启动撞端口时改 8889（`JUPYTER_PORT` 环境变量支持；compose 注释标注）。

**健康检查**：`curl :8888/api`——jupyter 无 token 也返回 401/200（服务活着即通过）。

### §3.1 项目卷挂载（决策点 D1）

本机工作区（scout 实证）：pi-platform / CLI-Anything / WeKnora / WorkBuddy / bf-rust / llm-cloud-probe / ai-teach-jupyter / Zotero 等。

**建议**：挂载 `~/pi-platform`、`~/docs`、`~/Projects`、`~/go`（只读或读写？）——挂载路径语义：容器内 `/works/<项目名>`（非覆盖 /home/jovyan/work——避免与镜像卷冲突）。ai-teach-jupyter（jupyter 教学）必须可访问。
**裁决点**：挂载哪些目录 + 只读还是读写。

### §3.2 密钥注入（决策点 D2）

**建议**：dev 容器**持 LLM 密钥**（可信环境——用户自己的日常开发；与 sandbox"不持密钥"的裁决不冲突，那是不可信执行区）。compose `${KEY:-}` 从宿主 env 注入。
**裁决点**：是否注入全部密钥（ANTHROPIC/OPENAI/DEEPSEEK）还是按需。

## §4 Dockerfile.dev 内容

```dockerfile
FROM quay.io/jupyter/minimal-notebook:python-3.13

# 1) 系统工具（apt——Ubuntu 24.04）
RUN sudo apt-get update && sudo apt-get install -y --no-install-recommends \
    git-lfs gh jq curl wget tmux vim ripgrep sqlite3 ffmpeg tesseract-ocr z3 && \
    sudo rm -rf /var/lib/apt/lists/*

# 2) uv（多 Python 版本管理）
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc

# 3) 数据科学常用包（conda base env——容器内装，不碰宿主）
RUN mamba install -y -c conda-forge pandas numpy matplotlib seaborn scikit-learn scipy && \
    mamba clean -ai

# 4) 自定义启动脚本（entrypoint 扩展——token 提示/挂载提示）
COPY scripts/dev-entry.sh /usr/local/bin/
```

**内置工具**（scout ✅ 类）：git-lfs/gh/jq/curl/wget/tmux/vim/rg/sqlite3/ffmpeg/tesseract/z3 + uv + 数据科学包。
**延后**：docker/kubectl/dapr（宿主已有）、postgres/mysql/cmake（无需求不装）。
**不迁**：pi/pit/codex 等 PTL 专属 + dot 配置（保持宿主）。

## §5 使用方式

```bash
docker compose up -d dev                    # 启动（首次构建 ~5-10min）
docker compose logs dev | grep token        # 取 token（未固定时）
open http://127.0.0.1:8888                  # jupyter 浏览器访问（或 lab）
docker compose exec dev bash                # CLI 进容器用工具（uv/node/git 等）
docker compose exec dev mamba env create -n py312 python=3.12   # 多 Python 环境
docker compose down dev                     # 销毁（卷保留——数据不丢）
```

**多 Python**：conda base=3.13 + `mamba env`/`uv python install` 任意版本；内核注册（`python -m ipykernel install`）后 jupyter 可选内核。

## §6 与既有服务的关系

| 服务 | 职责 | 网络 | 密钥 | 代码执行 |
|---|---|---|---|---|
| pth | 联邦宿主（会话/构件/定时） | default+internal | LLM 密钥 | 转发 sandbox |
| sandbox | **不可信**代码执行 | 仅 internal | ❌ 无 | 自身执行 |
| redis | 状态/审计 | internal | - | - |
| **dev** | **可信**开发环境（jupyter/工具） | default | ✅ 持（D2） | 自身执行 |

边界：dev 容器**不**替代 sandbox——联邦的代码执行仍强制沙箱化；dev 是用户**人工**开发/研究空间。

## §7 演进（非本阶段）

- **scipy/datascience 升级**：数据栈需求增长时换基础镜像或 mamba 装（镜像 tag 固定可重建）
- **GPU**：pytorch/tensorflow 的 `cuda-*` tag（用户无 GPU 需求——标注即可）
- **联邦接入**：dev 作为普通节点经 hub 交互（构件/回退/观测）——用户已裁决暂为基础设施并列，此为其演进路径
- **CLI 工具迁入**：pipx 类工具（agent-reach/yt-dlp 等）逐步 uv tool 装进容器（替代宿主全局）

## §8 开放问题/遗留

- WeKnora searxng 8888 冲突（compose 注释标注，遇冲突 JUPYTER_PORT=8889）
- runbook 陈旧注释（sandbox 3001/health——顺手修正）
- 首次镜像拉取 0.58G+ 构建成本（一次性）
- ai-teach-jupyter 项目挂载路径（D1 裁决）
- jupyter 多用户/共享（单用户足够——演进）
