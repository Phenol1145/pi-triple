export * from "./config.js";
export * from "./work-mode.js";
export * from "./tmux.js";
export * from "./session-backend.js";
export * from "./tmux-backend.js";
export * from "./output.js";
export * from "./warnings.js";
export * from "./session-registry.js";
export * from "./session-state.js";
export * from "./version-check.js";
export * from "./template-agents.js";

// mailbox（原 pit-communicate）迁移：_shared 的 presence/registry/paths 上收为共享包导出
// 注意：RegistryEntry 与 session-registry.ts 的 RegistryEntry（ptl 会话注册表，framework 在用）
// 同名不同形——此处别名导出避免 barrel 歧义，mailbox 侧用 MailboxRegistryEntry。
export * from "./paths.js";
export * from "./presence.js";
export { Registry } from "./registry.js";
export type { RegistryEntry as MailboxRegistryEntry } from "./registry.js";

export * from "./program-manifest.js";
