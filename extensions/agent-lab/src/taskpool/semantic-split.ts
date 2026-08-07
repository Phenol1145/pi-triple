import type { TaskTemplate } from "./templates.ts";

/** 首个任务模板：语义分解（联邦地基一 semanticSplitTask 协议模板化，<relPath> 占位符）。 */
export const SEMANTIC_SPLIT_TEMPLATE: TaskTemplate = {
  id: "semantic-split",
  name: "语义分解",
  description: "将指定文档分解为可独立成立的语义事实条目，写入记忆库",
  labels: ["memory-maintenance", "semantic-split"],
  params: [{ name: "relPath", description: "待分解文档的相对路径", required: true }],
  protocol:
    `语义分解 <relPath>：读取该文档，识别可独立成立的语义事实（定义/决策/规则/结论/不变量），每条经 sdk.memory.write 写一个 MemoryEntry（kind=fact，anchors=文档标签+更细主题锚点，content=事实本身，末尾附 "源: <relPath>"）。不改写原文档、不删除指针条目。`,
  acceptance: "产出条目≥1；全部锚点非空；指针条目未被破坏",
  output: { kind: "memory", target: "记忆库（锚点=文档标签+主题锚点）" },
  registeredBy: "system",
  createdAt: 0, // 注册时由调用方覆写
};
