// 2026-08-13 审计 P1 瘦身：barrel 消费面仅 tui-lab/app.tsx 的 3 个符号（openDb 与 telemetry/arena/events/schema 重导出全部死——knip 实测）
export { openReadOnlyOrNull, sharedDbPath, localDbPath } from "./open-db.js";
