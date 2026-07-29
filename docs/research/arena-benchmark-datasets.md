# Arena 竞价系统——开源测试集调研报告

> 调研日期: 2026-07-29  
> 目的: 为 agent-lab Arena 竞价调度器找到适合多模型真实竞价对比的开源编程任务集  
> 需求: 每条任务=prompt 字符串 + 客观评判标准（测试用例/参考答案），轻量、下载即用

## 一、候选基准概览

### 1. HumanEval (OpenAI)

| 属性 | 值 |
|------|-----|
| 仓库 | https://github.com/openai/human-eval |
| Stars | 3,324 |
| 任务数 | **164** (HumanEval.jsonl.gz) |
| 数据格式 | JSONL: `task_id`, `prompt`(函数签名+docstring), `entry_point`, `canonical_solution`, `test`(assert 测试) |
| 语言 | Python |
| License | MIT |
| 获取 | `git clone` 或直接下载 [HumanEval.jsonl.gz](https://raw.githubusercontent.com/openai/human-eval/master/data/HumanEval.jsonl.gz) |
| 评判 | 执行 `test` 字段中的 assert，pass/fail 二元 |

**样本**:
```json
{
  "task_id": "HumanEval/0",
  "prompt": "from typing import List\n\n\ndef has_close_elements(numbers: List[float], threshold: float) -> bool:\n    \"\"\" Check if in given list of numbers, are any two numbers closer to each other than given threshold.\n    >>> has_close_elements([1.0, 2.0, 3.0], 0.5)\n    False\n    \"\"\"\n",
  "entry_point": "has_close_elements",
  "canonical_solution": "...",
  "test": "def check(candidate):\n    assert candidate([1.0, 2.0, 3.9, 4.0, 5.0, 2.2], 0.3) == True\n    ..."
}
```

**适合 Arena?** ✅ 非常合适。轻量(44KB)，JSONL 直接解析，测试用例客观，行业标准。唯一不足是 164 题偏少。

---

### 2. HumanEval+ / EvalPlus

| 属性 | 值 |
|------|-----|
| 仓库 | https://github.com/evalplus/evalplus |
| Stars | 1,784 |
| 任务数 | **164**（同 HumanEval，但每题的测试用例大幅扩展至 **平均 774 个**） |
| 数据格式 | 与 HumanEval 兼容，扩展了更多 test cases |
| License | MIT |
| 获取 | `pip install evalplus` |
| 评判 | 扩展的测试用例覆盖更多边界条件，减少误判 |

**适合 Arena?** ✅ 是 HumanEval 的超集——同 164 题但评判更严苛。**推荐替代原始 HumanEval**。

---

### 3. MBPP (Mostly Basic Python Problems)

| 属性 | 值 |
|------|-----|
| 仓库 | https://github.com/google-research/google-research/tree/master/mbpp |
| Stars | ~34,000 (google-research monorepo) |
| 任务数 | **~974**（500 test + 10 few-shot + 464 train/validation） |
| 数据格式 | JSONL: `task_id`, `text`(问题描述), `code`(参考解), `test_list`(3 个 assert) |
| 语言 | Python |
| License | Apache 2.0 (Google Research) |
| 获取 | 💡 HuggingFace: `HuggingFaceH4/mbpp`（sanitized split，427 prompt/test）；或原版 `google-research-datasets/mbpp` |
| 评判 | 执行 `test_list` 中的 3 个 assert |

**适合 Arena?** ✅ 500 道测试题，比 HumanEval 多 3 倍，入门级 Python（适合快跑多模型）。HuggingFace 直接下载 JSONL。但部分题目质量参差（crowd-sourced）。

> ⚠️ 仅用 MBPP 的 **test split**（500 题），不要用 full（含训练集污染风险）。

---

### 4. LiveCodeBench

| 属性 | 值 |
|------|-----|
| 仓库 | https://github.com/LiveCodeBench/LiveCodeBench |
| Stars | 916 |
| 任务数 | **1,055** (release_v6, 截至 2025-04，持续更新) |
| 数据格式 | 比赛题目（LeetCode/AtCoder/CodeForces），含 `prompt`、`starter_code`、`public_test_cases`、`private_test_cases` |
| 语言 | Python（为主） |
| License | MIT |
| 获取 | `pip install livecodebench`；数据集通过脚本生成，可按时间窗过滤 |
| 评判 | 公开+私有测试用例，pass@1 |
| 特点 | **抗污染**（仅含 2023-05 后的新题） |

**适合 Arena?** ✅✅ **强烈推荐**。题量大(1000+)、持续更新（无污染风险）、LeetCode 风格易于评判、支持时间窗过滤（可只测某段时间的题）。需要 pip 安装工具包但数据获取简单。

---

### 5. BigCodeBench

| 属性 | 值 |
|------|-----|
| 仓库 | https://github.com/bigcode-project/bigcodebench |
| Stars | 517 |
| 任务数 | **1,140** |
| 数据格式 | 函数级代码生成，含多样化函数调用（而非简单算法） |
| 语言 | Python |
| License | Apache 2.0 |
| 获取 | `pip install bigcodebench==0.1.5`；数据通过 `bigcodebench.generate` 脚本访问 |
| 评判 | 基于执行的测试用例（含并发/文件系统场景） |

**适合 Arena?** ⚠️ 题量大且任务描述接近真实工程（比 HumanEval 更具挑战性），但安装偏重（PyPI 包），且不适合"轻量 prompt → code → run test"的快节奏竞价循环（部分任务需要外部依赖）。适合深度评测场景。

---

### 6. SWE-bench / SWE-bench Verified

| 属性 | 值 |
|------|-----|
| 仓库 | https://github.com/SWE-bench/SWE-bench |
| Stars | 5,515 |
| 任务数 | Verified: **500**（人工验证） / Lite: **300** / Full: **2,294** |
| 数据格式 | GitHub Issue → Patch 修复，需 Docker 执行单元测试验证 |
| 语言 | Python（12 个开源仓库） |
| License | MIT |
| 获取 | HuggingFace: `datasets load SWE-bench/SWE-bench_Verified` |
| 评判 | 在 Docker 中执行 repo 的单元测试，pass/fail |

**适合 Arena?** ❌ **不适合当前阶段**。单任务执行太重（需 clone repo + Docker 构建 + 运行测试套件，动辄数分钟），不适合"多个模型对一题竞价、快速结算"的模式。但未来如需测试"完整软件工程任务"的竞价能力可考虑。

---

### 7. Aider Polyglot Benchmark

| 属性 | 值 |
|------|-----|
| 仓库 | https://github.com/Aider-AI/polyglot-benchmark |
| Stars | 223 |
| 任务数 | **133** Python 练习题（来自 Exercism） |
| 数据格式 | 每道题包含：`instructions.md`（需求）、`test_xxx.py`（pytest 测试） |
| 语言 | Python |
| License | MIT |
| 获取 | `git clone https://github.com/Aider-AI/polyglot-benchmark`；直接下载 ZIP |
| 评判 | 执行 pytest，全绿=通过 |

**适合 Arena?** ✅ 轻量(`git clone` 即用)、test-driven（pytest 直接评判）、Exercism 题目质量好（有真实教学价值）。133 题每个都有独立的测试文件——非常适合"多模型对不同题目竞价、跑完即结算"。

---

### 8. APPS (CodeContests)

| 属性 | 值 |
|------|-----|
| 仓库 | https://huggingface.co/datasets/codeparrot/apps |
| 任务数 | **10,000**（introductory/interview/competition 三级） |
| 数据格式 | 编程竞赛题：`question`(描述) + `input_output`(测试用例) + `solutions`(参考解) |
| 语言 | Python |
| License | MIT (codeparrot) |
| 获取 | HuggingFace: `datasets load codeparrot/apps` |

**适合 Arena?** ⚠️ 数据量大但需要 pip install datasets，部分题依赖标准输入/输出判题（需要 runner），不像 HumanEval 直接执行 assert。可作为**大规模扩展集**。

---

### 9. DS-1000

| 属性 | 值 |
|------|-----|
| 仓库 | https://github.com/HKUNLP/DS-1000 |
| 任务数 | **1,000**（7 个数据科学库：Pandas/NumPy/Matplotlib/SciPy/Scikit-learn/TensorFlow/PyTorch） |
| 数据格式 | 简化为 JSONL（`ds1000.jsonl.gz`），含 `prompt` + `reference_code` + `test` |
| 语言 | Python + 数据科学库 |
| License | MIT |
| 获取 | HuggingFace: `xlangai/DS-1000` |

**适合 Arena?** ⚠️ 数据科学场景而非通用代码生成，需要安装 Pandas/TF 等重型库。适合定向测试（模型的数据科学能力竞价）而非通用擂台。

---

### 10. 中文编程基准

| 名称 | 仓库 | 说明 | 适用性 |
|------|------|------|--------|
| **CodeFuse-Eval** | https://github.com/codefuse-ai/codefuse-evaluation | 企业级代码生成评测（含中文场景），111 stars | ⚠️ 偏企业内部评测框架，非即插即用 |
| **CoderEval** | https://github.com/CoderEval/CoderEval | 实用代码生成（非 LeetCode 风格），含中文 README，159 stars | ⚠️ 侧重开源项目代码补全 |
| **HumanEval-XL** | https://github.com/floatai/HumanEval-XL | 多语言代码生成基准（含中文 Python 描述） | ⚠️ 42 stars，社区小 |
| **HumanEval 中文翻译** | 社区自制（无统一仓库） | HumanEval 的 prompt 翻译成中文 | 可自行用 LLM 翻译 164 题的 prompt |

> **结论**: 没有找到与 HumanEval/MBPP 同等质量且"下载即用"的中文编程基准。建议**先用英文基准验证竞价链路**，后续可自行翻译 HumanEval 的 prompt 为中文作为扩展。

---

## 二、推荐排序

### 🥇 第一推荐: HumanEval+ (EvalPlus)

- **任务数**: 164（每道 774 个增强测试）
- **获取**: `git clone https://github.com/evalplus/evalplus && cd evalplus && pip install -e .`
- **理由**: 行业金标准、MIT 许可、JSONL 格式、直接 assert 判分、40KB 即可下载全部数据、测试扩展版防止误判。**最轻量、最直接**。
- **下载命令**: 
  ```bash
  # 只取数据（不需要 pip 安装框架）
  curl -sL https://raw.githubusercontent.com/openai/human-eval/master/data/HumanEval.jsonl.gz -o HumanEval.jsonl.gz
  gzip -d HumanEval.jsonl.gz  # 得到 164 行 JSONL
  ```

### 🥈 第二推荐: LiveCodeBench (release_v6)

- **任务数**: 1,055（持续增长）
- **获取**: `pip install livecodebench` 或直接通过 HuggingFace 下载数据
- **理由**: 题量最大、**抗污染**（2023-05 后的新题）、LeetCode 风格易评判、支持时间窗过滤。适合大规模、长周期竞价测试。
- **数据获取**:
  ```bash
  # 通过 livecodebench 工具下载
  pip install livecodebench
  python -c "from lcb_runner.utils.scenarios import Scenario; print('done')"
  # 或通过 HuggingFace 直接取
  # https://huggingface.co/datasets/livecodebench/code_generation_lite
  ```

### 🥉 第三推荐: Aider Polyglot (133 题)

- **任务数**: 133 Exercism Python 练习题
- **获取**: `git clone https://github.com/Aider-AI/polyglot-benchmark`
- **理由**: git clone 即用、每道题独立目录（`instructions.md` + `test_xxx.py`）、pytest 直接判分、题目质量高（来自真实教学题库 Exercism）。**最适合"快跑多模型对比"**。
- **数据获取**:
  ```bash
  git clone https://github.com/Aider-AI/polyglot-benchmark
  ls polyglot-benchmark/exercises/practice/  # 133 个目录
  ```

### 替补: MBPP (500 test tasks)

- **任务数**: 500（仅 test split，排除训练集污染）
- **获取**: HuggingFace 直接下载 JSONL
- **理由**: 题量中等、题目简单（入门级 Python）、3 个 assert 判分。如果觉得 HumanEval 太少而 LiveCodeBench 太重，MBPP 是中间选项。

---

## 三、推荐组合策略

对于 Arena 竞价系统的测试，建议**分层使用**：

| 阶段 | 基准 | 用途 |
|------|------|------|
| **冒烟验证** (Phase 1) | HumanEval (164 题) | 快速验证竞价→执行→结算全链路 |
| **对比评测** (Phase 2) | HumanEval+ + Aider (297 题) | 多模型在多题上重复竞价，积累统计显著性 |
| **规模化** (Phase 3) | LiveCodeBench (1,055 题) | 大规模长周期竞价，检验调度器稳定性 |

所有推荐基准均满足：
- ✅ MIT/Apache 2.0 许可
- ✅ 直接下载（git clone 或 curl）
- ✅ 可机器评判（assert 或 pytest）
- ✅ 适合"prompt → 生成代码 → 执行测试 → pass/fail"的竞技循环

---

## 四、格式适配说明

对于 Arena 竞价系统，任务格式需要适配为：

```
任务 = 一条 prompt 字符串 + 测试用例/评判函数
```

- **HumanEval/MBPP**: 直接取 `prompt` 字段作为任务，`test` 字段作为评判
- **Aider Polyglot**: 取 `instructions.md` 内容作为 prompt，对应 `test_xxx.py` 作为评判
- **LiveCodeBench**: 取 `prompt` + `starter_code` 拼接，用 `test_cases` 判分

所有推荐基准的 prompt 都是**纯文本**，可直接传入 Arena 的 `task` 参数。

---

> **URL 与数字均经 GitHub API / HuggingFace API 实时查询核实（2026-07-29）。**  
> MBPP 的 HuggingFace 数据集因 SSL 限制未直接返回 num_examples（已在报告注明）；LiveCodeBench release 版本号来自其 README.md 原文。
