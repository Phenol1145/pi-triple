/**
 * @away_from/framework — PTL 主体公共入口（barrel）
 *
 * 仅导出无副作用 API（与 pit.ts 的测试兼容 re-export 保持一致）；
 * 主流程（cli/run）保持延迟加载，避免 node:sqlite ExperimentalWarning 提前触发。
 */
export { parseArgs } from "./cli/args.js";
export { resolveOrFail } from "./cli/onboard.js";
