/**
 * work-mode.ts — canonical WorkMode JSON 协议镜像。
 *
 * 与 PTH `src/pth/contracts/work-mode.ts` 同源镜像（source mirror）：PTL 与浏览器侧
 * 只从 `@away_from/shared` import，禁止 import PTH 源码/契约文件。两侧必须同步修改；
 * 若 PTH 侧新增/删除 mode，需先在此镜像与 PTH 契约中同时更新，再发布协议。
 *
 * 本文件只包含跨进程 JSON 协议所需的“三值 mode + 校验器”，不包含 WorkEnvelope、
 * cross-mode handoff 等服务端专属构造（那些仍以 PTH 契约为准）。
 */

export const WORK_MODES = ["intake", "optimize", "run"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export function isWorkMode(value: unknown): value is WorkMode {
  return typeof value === "string" && (WORK_MODES as readonly string[]).includes(value);
}
