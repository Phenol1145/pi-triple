#!/usr/bin/env node
/**
 * pit — Pi-Triple 统一 CLI (PTL)
 *
 * 模板使用 UUID + alias 模式。
 * 所有路径用 UUID，用户交互用 alias。
 *
 * 入口职责：最早安装警告过滤（node:sqlite builtin 加载即发 ExperimentalWarning，
 * ESM import 提升使其先于任何模块体执行——故主逻辑延迟加载），再启动主流程。
 */

import { installWarningFilter } from "./warnings.js";
installWarningFilter();

// 测试兼容 re-export（args/onboard 无 node:sqlite 链，静态加载安全）
export { parseArgs } from "./pit/args.js";
export { resolveOrFail } from "./pit/onboard.js";

// 主逻辑延迟加载：其静态 import 链（含 lab-data → node:sqlite）在过滤安装后求值
const { main } = await import("./pit/run.js");

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
