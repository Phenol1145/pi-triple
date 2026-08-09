# archive/ — 已归档模块（保留代码，不再编译/加载）

2026-08-09 PTL 瘦身决策：PTL 回归交互层定位（CLI + TUI + tmux + 扩展层 + PTL→PTH 桥），
放弃 workflow engine 与 agent-lab 经济引擎。归档代码保留完整（含测试），供 0.7/0.8 恢复参考；
历史版本见 git 与 GitHub Release v0.5.0。

| 目录 | 原位置 | 内容 |
|------|--------|------|
| `framework-flow/` | `packages/framework/src/flow/` | ptl-flow 波次工作流引擎（engine/schema/store/expr/edit/commands… 12 文件 4.3k 行 + 17 个测试） |
| `agent-lab/` | `extensions/agent-lab/` | agent 经济引擎（WorkLoop 图灵机状态机 + arena 市场竞拍 + 调度/优化闭环；含 .pi-subagents 生成物） |
| `agent-lab-bidder/` | `extensions/agent-lab-bidder/` | place_bid 竞价工具（用户保留意向：0.7/0.8 可能复用） |
| `workflow-ext/` | `extensions/workflow/` | pi 会话内编排接口扩展（/flow 命令 + flow_run 工具 + gate 通知——调 ptl flow CLI） |

## 断链点（代码侧已清理）

- `cli/main.ts`：flow 命令族注册移除；`cli/mode.ts`/`cli/run.ts`：flow 分支与 import 移除
- `tui-ptl/command-bar.tsx`/`dashboard.tsx`：flow 命令组与提示文案清理
- `launcher.ts`/`cli/route.ts`/`shared-layer.ts`/`tui-ptl/config-page.tsx`：AGENT_LAB env 注入与目录创建移除
- `tui-lab/app.tsx`：Arena Tab 断开（`arena.ts`/`trace-provider.ts` 保留文件、容错降级——agent-lab.db 不存在时空返回）
- `lab-data/schema.ts`：agent-lab 表常量保留（无副作用）；`packages/infra` sdk-adapter 注释更新

## 恢复方式（如需）

```bash
git mv archive/framework-flow packages/framework/src/flow
git mv archive/agent-lab extensions/agent-lab
git mv archive/agent-lab-bidder extensions/agent-lab-bidder
git mv archive/workflow-ext extensions/workflow
# 恢复断链点（git show v0.5.0:对应文件 可回看原注入代码）
```
