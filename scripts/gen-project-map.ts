/**
 * 项目全貌文档生成（project-map——公共记忆区注入——worker 一次读知道代码库结构）。
 * 用法：node --experimental-strip-types scripts/gen-project-map.ts
 * 输出：stdout markdown（人工 review / CI 检查——运行时注入由 injectPromptDocs 完成）
 * 单源：复用 src/pth/kernel/prompt-docs.ts 的 buildProjectMap（职责表只维护一份）
 */
import { buildProjectMap } from "../src/pth/kernel/prompt-docs.js";

const map = await buildProjectMap();
console.log(map);
