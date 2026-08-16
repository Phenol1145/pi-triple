# PTH 任务模板统一收口（A+）可执行计划

> **计划状态：可执行（2026-08-16 建立）**
>
> **用户裁决（2026-08-16）**：
> 1. 合并方案 = **A+：TaskTemplate 唯一任务模板契约 + 共享解析器；TriggerDef.task 支持模板引用，内联 title/text 仅作兼容逃生舱**；
> 2. 顺带收口 = 系统内部提示词迁入模板库（hidden）、pth CLI 增加 `--template`、接通 perf 策略动作投递。

## 问题

三处各自定义“任务从参数变成 task”：

| 消费方 | 现状 |
|---|---|
| 发布 API | `TASK_TEMPLATES` + `renderTaskTemplate` + `validateTemplateParams`（`routes-kernel.ts`） |
| TriggerEngine | `TriggerDef.task {title,text,role,tags}` + 私有 `{{taskId}}/{{role}}/{{detail}}` 渲染 |
| PerfStrategy.actions | `{type:"task", template, params}` 结构声明但未接线（apply 只计数） |

渲染、必填校验、默认路由、payload 溯源四处漂移；以后新增模板/触发源要改三处。

## 目标模型

```
TaskTemplate {
  id, name, description,
  params: [{key, required, description}],
  roleTag,                       // 默认路由标签
  render(params) → text,         // 任务正文（TS 程序或治理提示词）
  title?: (params) => string,    // 缺省 "[id] name"
  hidden?: boolean,              // 系统内部模板（不出现在 /templates 列表）
}

resolveTemplateTask({ template, params, title?, tags?, role?, payload? }, { eventVars? })
  → { ok:false, code, missing? } | { ok:true, title, text, tags, role?, payload }
```

- 校验必填在**事件变量注入之后**（`url:"{{detail}}"` 且 detail 为空 → missing）；
- 路由优先级：显式 `role` > 显式 `tags` > 模板 `roleTag`；
- payload 统一含 `{template, params(已注入), ...额外 payload}`；
- 发布 API / TriggerEngine / PerfStrategy 三处都只调这一个解析器。

## 执行阶段（每个子项独立提交；TDD）

### U1：模板契约 + 共享解析器
- [x] U1-1 `TaskTemplate` 增加 `title?` / `hidden?`；`resolveTemplateTask`（含事件变量注入、必填后置校验、路由优先级、payload 溯源）
- [x] U1-2 `listPublicTemplates()`（过滤 hidden）
- [x] U1-3 单元测试：渲染/缺参/注入/路由优先级/hidden

### U2：TriggerEngine 模板引用 + 系统提示词迁移
- [x] U2-1 `TriggerDef.task` 增加 `{template, params}` 引用形态（与内联 title/text 兼容；reload 校验更新）
- [x] U2-2 `publishFromTrigger` 收口到 `resolveTemplateTask`（内联路径保留渲染）
- [x] U2-3 `memory-sweep` 内部提示词迁入 TASK_TEMPLATES（hidden:true）；`buildMemorySweepTrigger` 改为 `task:{template:"memory-sweep", role:"memory-keeper", tags:[...]}`
- [x] U2-4 测试：trigger 模板引用（事件变量注入 params）、未知模板跳过、memory-sweep 迁移回归

### U3：发布 API 收口
- [x] U3-1 `routes-kernel.ts` 模板发布分支改调 `resolveTemplateTask`（错误码语义不变：unknown→404 / missing→400）
- [x] U3-2 `GET /api/v1/kernel/templates` 过滤 hidden
- [x] U3-3 测试：模板 API 回归 + hidden 不可见

### U4：PerfStrategy 动作投递收口
- [x] U4-1 `perf.apply` 执行 `actions`：每个 `{type:"task", template, params}` 经 `resolveTemplateTask` + `ctx.dataWorld.tasks.publish`（createdBy=perf-strategy:<id>）；单条失败进 dispatchErrors 不炸整轮
- [x] U4-2 测试：策略动作发布成功/未知模板失败隔离

### U5：CLI --template + 文档 + 全量门禁
- [x] U5-1 `scripts/pth-cli.ts`：`submit --template <id> [--param k=v]... [--tags a,b]`（走 `/api/v1/kernel/tasks {template,params}`）
- [x] U5-2 文档：`docs/pth/trigger-runtime.md` 更新模板引用形态；`docs/ptl/pth-task-submission.md` 补 pth CLI 模板用法
- [x] U5-3 全量 `npm test` + `npm run lint` + `npm run build` + `check:pth-boundaries` 全绿
- [x] U5-4 收账：勾平 checkbox，独立提交

## 收账证据（2026-08-16）

- 全量 vitest：**231 文件通过 / 1889 用例绿 / 9 hostile integration skip**（232 文件；较 trigger 统一化前 +13 用例）；
- `npm run lint`（含 `check:pth-boundaries`）：**0 违规**；
- `npm run build`：干净；
- pth CLI 帮助烟测通过（`--template/--param` 用法可见）。

## 退出门禁

- 全量 vitest 绿；lint（含 boundaries 0 违规）；build 干净；
- 兼容性：`/api/v1/kernel/tasks {template,params}` 与 `/templates` 对外行为不变（仅 hidden 项不外显）；
- 既有内存里 `kind='trigger'` 的内联 `task.title/text` 定义继续可用；
- 每个子项独立提交。
