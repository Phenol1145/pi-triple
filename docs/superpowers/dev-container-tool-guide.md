# dev 容器工具指南 —— PTL 外接工具与开发者工具迁移指南

**版本**：v1.0
**日期**：2026-08-05
**状态**：生效（G 阶段配套）
**相关文件**：
- 镜像定义：`Dockerfile.dev`
- 服务编排：`docker-compose.yaml`（`dev` 服务）
- wrapper 生成：`tools/dev/gen-dev-wrapper.sh`
- 运维章节：`docs/superpowers/runbooks/2026-08-05-containerized-federation.md` §10
- 设计 spec：`docs/superpowers/specs/2026-08-05-dev-container-design.md`

**本文回答一个问题**：PTL（或开发者）遇到一个新工具，**应该放在哪里、怎么放进去、怎么调用**。

---

## 1. 三容器职责与放置决策树

| 容器 | 定位 | 网络 | 凭据 | 适合放什么 |
|---|---|---|---|---|
| **sandbox** | 不可信代码执行（中间态） | egress 锁定（无外网） | 无 | 一次性脚本、不可信输入处理、运行产物**中间态** |
| **dev** | 开发/学习研究/成品保留（可信） | default（可出网） | 不注入（用户裁决） | 开发工具链、数据科学、研究、**成品** |
| **宿主机** | 平台原生依赖 | — | — | 非开源/原生二进制（Mach-O）、依赖宿主服务（钥匙串/GUI）的工具 |

**放置决策**：

```
新工具 X 到来
 ├─ X 是不可信/一次性执行的代码？ ──────────────→ sandbox（用完即弃）
 ├─ X 是非开源或平台原生二进制（Mach-O/仅 macOS）？→ 保留宿主机（Linux 容器跑不了）
 ├─ X 是可信开发/研究工具（开源、要保留、要环境）？→ dev 容器
 └─ X 只是宿主已有且无需隔离？ ────────────────→ 宿主机（不动）
```

**已迁入 dev 的开源工具**（Dockerfile.dev §7）：`agent-reach`、`yt-dlp`、`instsci`。
**保留宿主机的非开源工具**（用户裁决）：`kimiim-cli`、`obsidian`（及其 git 同步）、`claude`、`qodercli`。

---

## 2. 把新工具放进 dev：两条路径

### 路径 A：临时安装（试验/一次性/快速验证）

直接进容器装——**不重建镜像**，改动落在 `dev-home` 卷上（重启不丢，但**镜像重建会丢失**）：

```bash
docker compose up -d dev

# Python 包
docker compose exec dev pip install <pkg>
# 或 uv tool（隔离环境，推荐 CLI 工具）
docker compose exec dev uv tool install <pkg>
# Node 包
docker compose exec dev npm i -g <pkg>
# conda 包（数据科学）
docker compose exec dev mamba install -c conda-forge <pkg>
# apt 系统工具（需 root）
docker compose exec -u root dev apt-get update && docker compose exec -u root dev apt-get install -y <pkg>
```

**验证**：`docker compose exec dev which <tool>`
**适用**：先试验、确认可用后再走路径 B 固化。

### 路径 B：永久安装（固化进镜像——核心工具集）

**Step 1｜确认来源**。工具可能不在默认仓库——先查实际分发源：

```bash
# PyPI？
curl -s https://pypi.org/pypi/<pkg>/json | head -5
# 不在 PyPI 的常见情况：GitHub 源（如 instsci/agent-reach）——用 git+ 安装
```

> ⚠️ **教训（instsci）**：`uv tool install instsci` 失败——它不在 PyPI，实际是 GitHub 源。
> 正确写法：`uv tool install "instsci @ git+https://github.com/<owner>/<repo>"`。
> pip 同理：`pip install "pkg @ git+https://github.com/owner/repo@main"`

**Step 2｜编辑 `Dockerfile.dev`**。注意 **USER 层级**（最常见的坑）：

| 工具类型 | 装在哪 | USER | 示例 |
|---|---|---|---|
| 用户级 CLI（nvm/uv/rustup/pip --user/uv tool） | `$HOME`（/home/jovyan） | **jovyan** | §2/§4/§5/§7-uv |
| 系统工具（apt）/Go/全局 pip | /usr、/opt/conda | **root** | §1/§3/§6/§7-pip |

> ⚠️ **教训（实测）**：以 root 跑用户级安装器（nvm/rustup/uv）会把 `$HOME` 下的目录写成 root 属主——
> 卷挂载后 jovyan 无权限写 → jupyter 启动失败（`PermissionError: /home/jovyan/.local/share/jupyter`）。
> **规则：用户级工具必须在 `USER jovyan` 下安装。**

**Step 3｜重建 + 实证**：

```bash
docker build -f Dockerfile.dev -t pi-platform:dev .
docker compose up -d --force-recreate dev
docker compose exec dev <tool> --version   # 实证
```

**Step 4｜生成宿主机 wrapper**（本机同名命令，PTL 无感调用）：

```bash
bash tools/dev/gen-dev-wrapper.sh <tool>          # 单个
bash tools/dev/gen-dev-wrapper.sh                 # 全部默认工具
```

**Step 5｜宿主机验证**：`<tool> --version`（应透传到容器内执行）。

---

## 3. 宿主机调用：wrapper 机制

**原理**：`~/.local/bin/<tool>` 是一个 shell 脚本，把调用转发给 dev 容器：

```bash
exec docker compose -f ~/pi-platform/docker-compose.yaml exec -T dev <tool> "$@"
```

- **PTL 现有调用零改动**——同名命令直接命中 wrapper；
- dev 容器未启动时 wrapper 报错（提示先 `docker compose up -d dev`）；
- **卸载**：`rm ~/.local/bin/<tool>`（或恢复原生安装）。

> 若宿主机原本就有同名工具（如 `~/.local/bin/yt-dlp` 是原生 Python 脚本），生成 wrapper 会**覆盖**它——
> 覆盖前确认迁移目标就是 dev（本指南的前提）。需要回退时从备份恢复或重新安装原生版。

---

## 4. 配置与密钥（不注入原则）

**用户裁决：dev 不注入任何 LLM/服务密钥。**

| 配置类型 | 处理方式 |
|---|---|
| 工具自身配置（agent-reach cookies 等） | 卷挂载（compose 已挂 `~/.agents:ro`）或容器内 `<tool> configure` 命令 |
| LLM API key | **不写 compose env、不烧镜像**；需要时 `docker compose exec -e DEEPSEEK_API_KEY=xxx dev bash` 临时给 |
| 项目数据 | 绑定挂载（compose 已挂 5 个核心项目目录，读写） |

**新增配置挂载**：编辑 `docker-compose.yaml` `dev.volumes`——含凭据的配置**只读挂载**（`:ro`）。

---

## 5. 产物流向（sandbox → dev）

```
PTH bash 工具 ──转发──→ sandbox 执行（中间态产物落 /data/workspaces）
                              │
                              │  成品筛选（用户裁决：中间态留 sandbox，成品进 dev）
                              ▼
              dev 容器 /data/artifacts（dev-artifacts 卷，持久保留）
                              │
                              ▼
                    宿主机访问：docker compose exec dev cat /data/artifacts/...
                    或 docker cp pi-platform-dev-1:/data/artifacts/x ./x
```

**共享点**：sandbox 与 dev 都挂 `workspaces` 卷（同路径 `/data/workspaces`）——sandbox 产物 dev 直接可见，无需搬运；成品再拷到 `/data/artifacts` 固化。

---

## 6. 坑与教训（实测沉淀）

1. **USER 切换**（路径 B Step 2）：用户级工具必须 `USER jovyan` 安装——否则家目录属主错误。
2. **卷属主漂移**：Docker 命名卷首次挂载不总保留镜像属主。compose `dev` 的 entrypoint 已对已知路径做启动期 chown（`.local/.nvm/.cargo/.rustup/go/artifacts/workspaces`）——**新增用户级工具若写入新路径，把该路径加进 chown 列表**。
3. **工具不在默认仓库**：先查实际分发源（PyPI/npm/conda-forge/git/apt）——git 源用 `git+https://...` 写法。
4. **jupyter 拒绝 root**：entrypoint 以 root 跑 chown 后必须降回 jovyan（`su jovyan`）再启动——已在 compose entrypoint 处理。
5. **非开源二进制别进容器**：Mach-O（kimiim-cli/obsidian/claude/qodercli）在 Linux 容器不可执行——保留宿主机。
6. **端口冲突**：jupyter 8888 与 WeKnora searxng 冲突时改 `JUPYTER_PORT=8889`。

---

## 7. PTL 集成说明

- **PTL 的 bash 工具走 sandbox**（egress 锁定——F/WP3）——PTL 会话内执行代码不受 dev 影响。
- **PTL 需要 dev 工具时**：走宿主机 wrapper（同名命令）——`agent-reach doctor`、`yt-dlp <url>` 等直接可用。
- **PTL 建议新工具时的标准流程**：
  1. `docker compose exec dev which <tool>` 查是否已有；
  2. 没有 → 路径 A 临时装试验；
  3. 确认可用 → 路径 B 固化（改 Dockerfile.dev + wrapper）；
  4. 放置决策树（§1）判定该不该进 dev——非开源/不可信的不进。
- **监控**：`docker-monitor`（`http://localhost:9090`）实时看 dev 及全部容器状态。

---

*文档维护：工具集变化时同步更新 Dockerfile.dev §7 注释、本指南 §1 已迁清单、wrapper 脚本默认 TOOLS 数组。*
