# G 阶段设计：开发环境容器化（dev 容器）

**版本**：v0.3（实施完成稿）
**状态**：✅ **已实施**（2026-08-05——dev 容器构建+运行+工具迁入+监控面板全部落地实证；runbook 见 `docs/superpowers/runbooks/2026-08-05-containerized-federation.md` §dev）
**日期**：2026-08-05
**前置**：F 阶段（`docs/superpowers/specs/2026-08-05-containerization-architecture-design.md`——pth/sandbox/redis 已容器化）
**输入裁决**（2026-08-05 用户确认，两轮）：
- ①范围=开发环境容器（jupyter/研究工具为主，PTL 外接工具迁入）；②新增独立 dev 容器（与 pth/sandbox/redis 并列）；③通用隔离环境（不污染系统 Python）
- **④sandbox=运行产物的中间态，成品保留在 dev**（职责：sandbox 跑、dev 存/开发）
- **⑤把目前 PTL 外接的工具尽量转移到容器中**（PTL 工具环境=dev）
- **⑥多语言**：Python（多版本）+ Node + Go + Rust；jupyter 为 Python 环境形态之一
**调研依据**：`/tmp/g-dev-container/1-tools-inventory.md`、`2-jupyter-stacks.md`、`3-compose-integration.md`

---

## §1 定位

**dev 容器 = 多语言开发工作区**——提供给 **PTL（外接工具环境）与用户（开发/学习研究）共用**：

1. **PTL 工具环境**：目前 PTL 外接的 CLI 工具（`~/.local/bin` 的 agent-reach/claude/hermes/instsci/kimiim/obsidian/yt-dlp 等 + `/usr/local/bin` 部分）**尽量迁入容器**——工具与宿主隔离、可复现、随镜像版本化。
2. **用户开发/学习研究区**：jupyter notebook/lab（Python 交互）+ 多语言（Python 多版本/Node/Go/Rust）调试、写程序、实验。
3. **成品保留区**：sandbox 运行产物的**成品**保留在 dev（中间态留在 sandbox——§6 边界）。

**不是**：
- ❌ 代码执行沙箱（那是 sandbox——无外部网络、不可信、中间态）
- ❌ PTL 宿主本体（本机 tmux 壳保持——F 裁决；但 PTL 的工具依赖迁入 dev）
- ❌ 联邦节点（不进 hub 交互面——演进项，§7）

## §2 容器选型

| 项 | 选型 | 理由 |
|---|---|---|
| 基础镜像 | `quay.io/jupyter/minimal-notebook:python-3.13` | quay.io 为官方现行源（Docker Hub 停更）；minimal 0.58G；Python 3.13 + conda 26.7 + mamba 2.8（多 Python 环境）；非 root jovyan；端口 8888 + token 认证 |
| tag 固定 | `:python-3.13`（不用 latest） | 可复现 |
| 多语言叠加 | 自建 `Dockerfile.dev`：Node + Go + Rust + 数据科学包 + PTL 工具 | §4 |
| 成品区 | 命名卷 `dev-artifacts`（/data/artifacts） | 成品保留（§6） |

**镜像大小预算**：基础 0.58G + 多语言（Node ~0.3G/Go ~0.3G/Rust ~1G）+ 数据科学包 ~0.5G + PTL 工具 ≈ **2.5-3G 总量**（一次性构建；Rust 工具链最大头——可按需分阶段）。

## §3 compose 集成

```yaml
  dev:
    build:
      context: .
      dockerfile: Dockerfile.dev
    ports:
      - "127.0.0.1:8888:8888"        # jupyter（仅本机）
    networks:
      - default                        # 出网装包 + LLM API + PTL 工具联网
    volumes:
      - dev-home:/home/jovyan          # /home/jovyan 持久化（jupyter 配置/conda env/uv 缓存）
      - dev-artifacts:/data/artifacts  # 成品保留区（§6）
      # 项目目录按需挂载（D1）
      - ${HOME}/ai-teach-jupyter:/works/ai-teach-jupyter:rw
      - ${HOME}/pi-platform:/works/pi-platform:rw
      - ${HOME}/docs:/works/docs:rw
      - ${HOME}/Projects:/works/Projects:rw
      - ${HOME}/go:/works/go:rw
    environment:
      - JUPYTER_TOKEN=${JUPYTER_TOKEN:-}   # 固定 token（空则随机打印）
      # LLM 密钥（dev 可信环境——与 sandbox"不持密钥"不冲突，那是不可信执行区）
      - DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
      - OPENAI_API_KEY=${OPENAI_API_KEY:-}
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:8888/api"]
      interval: 30s
      timeout: 5s
      retries: 3
```

**网络**：default（出网——装包/LLM/工具联网必需）。与 sandbox internal 隔离不共享。

**端口**：`127.0.0.1:8888`。⚠️ WeKnora searxng 默认占 8888——冲突时 `JUPYTER_PORT=8889`（compose 注释标注）。

## §4 Dockerfile.dev 内容

```dockerfile
FROM quay.io/jupyter/minimal-notebook:python-3.13

# 1) 系统工具（apt）
RUN sudo apt-get update && sudo apt-get install -y --no-install-recommends \
    git-lfs gh jq curl wget tmux vim ripgrep sqlite3 ffmpeg tesseract-ocr z3 && \
    sudo rm -rf /var/lib/apt/lists/*

# 2) 多语言（用户裁决⑥）
# Node（LTS——nvm 或 apt nodejs？裁决：nvm 便于多版本）
# Go（官方 tarball /usr/local/go）
# Rust（rustup + cargo）
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/... | bash && \
    curl -fsSL https://go.dev/dl/go1.24.x.linux-arm64.tar.gz | sudo tar -C /usr/local -xzf - && \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# 3) uv（多 Python 版本管理）
RUN curl -LsSf https://astral.sh/uv/install.sh | sh

# 4) 数据科学常用包（conda base env）
RUN mamba install -y -c conda-forge pandas numpy matplotlib seaborn scikit-learn scipy && mamba clean -ai

# 5) PTL 外接工具迁入（用户裁决⑤——逐步，先核心集）
# uv tool install agent-reach yt-dlp ...（按工具清单分阶段）
# 启动脚本 scripts/dev-entry.sh（成品区初始化/工具清单校验）
```

**内置工具**（scout ✅ 类）：git-lfs/gh/jq/curl/wget/tmux/vim/rg/sqlite3/ffmpeg/tesseract/z3 + uv + Node/Go/Rust + 数据科学包。
**PTL 工具迁入**（决策点 D3）：agent-reach/claude/yt-dlp 等——**先迁哪些、wrapper 怎么接**（§5）。
**不迁**：pi/pit/codex 本体（PTL 宿主）+ dot 配置。

## §5 使用方式

```bash
docker compose up -d dev                    # 启动（首次构建 ~10-15min）
docker compose logs dev | grep token        # 取 token
open http://127.0.0.1:8888                  # jupyter 访问
docker compose exec dev bash                # 进容器（多语言/工具）
docker compose exec dev mamba env create -n py312 python=3.12   # 多 Python
docker compose exec dev node -v && go version && cargo --version  # 多语言验证
```

**PTL 调用容器工具（决策点 D3——wrapper 形态）**：
- 方案 A：本机 wrapper（`~/.local/bin/agent-reach` → `docker compose exec dev agent-reach "$@"`）——PTL 命令无感
- 方案 B：仅手动 `docker exec`——PTL 脚本需显式加前缀
- 方案 C：本机不装、PTL 配置指向容器（改动 PTL 配置面）

## §6 与 sandbox 的边界（用户裁决④）

| | sandbox | dev |
|---|---|---|
| 职责 | 运行产物**中间态**（代码执行） | 开发/调试/学习 + **成品保留** |
| 网络 | 无外部（internal） | 出网（default） |
| 密钥 | ❌ 无 | ✅ 持（LLM/工具联网） |
| 信任 | 不可信 | 可信 |
| 使用者 | agent（联邦运行时） | PTL 工具 + 用户人工 |
| 产物 | 临时（随会话清理） | 成品持久化（dev-artifacts 卷） |

**衔接**：sandbox 执行完成后，**成品**由 PTL/用户收集到 dev（`/data/artifacts` 或项目卷）——人工/半自动（演进：hub debug 或构件上传通道连通后自动）。

## §7 演进（非本阶段）

- **PTL 工具全量迁入**：D3 分批（先核心集→全量）；本机逐步停用（镜像版本化保证可复现）
- **hub 接入 dev**：hub debug/构件开发/回退补全接入 dev 容器（替代 sandbox 内嵌调试区——演进裁决）
- **GPU**：pytorch cuda tag（无需求——标注）
- **联邦节点**：dev 作为普通节点（构件/回退/观测）
- **多用户**：jupyter 多用户（当前单用户足够）

## §8 开放问题/决策点

- **D1 挂载目录**：已按核心项目集（ai-teach-jupyter/pi-platform/docs/Projects/go）——可增删
- **D2 密钥**：建议全注入（DEEPSEEK/ANTHROPIC/OPENAI）——待确认
- **D3 PTL 工具迁入**：先迁哪些（核心集建议：agent-reach/yt-dlp/instsci/kimiim）+ wrapper 形态（A/B/C）
- WeKnora searxng 8888 冲突（标注，遇冲突 8889）
- runbook 陈旧注释（sandbox 3001/health——顺手修）
- 镜像大小 2.5-3G（Rust 大头——可分阶段：先 Python+Node+Go，Rust 后补）
