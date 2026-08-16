/**
 * session-backend.ts — 会话服务抽象（2026-08-09 审计后落地）
 *
 * 终端复用器统一契约：tmux / zellij / screen 各自实现。
 * 与容器抽象（containers/backend.ts getBackend 模式）同构——架构一致性。
 *
 * 迁移背景：原 tmux 操作散在 shared/tmux.ts（14 原语）+ cli/sessions.ts
 * （12 处直接 spawnSync）+ cli/agent.ts（send-keys）——本接口收敛全部原语，
 * 命令层只面对 SessionBackend，切换复用器零命令层改动。
 *
 * 选择：kind 字符串（"tmux" | "zellij" | "screen"）→ getSessionBackend(kind)
 * 工厂——v1 仅 tmux 实现（zellij/screen 为扩展点）。
 * 配置：config `session.backend`（缺省 tmux）。
 */

import type { PtlPaneInfo, PtlPanes, PtlSession } from "./tmux.js";

export type SessionBackendKind = "tmux" | "zellij" | "screen";

export interface SessionLaunch {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface SessionCreateResult {
  status: number;
  stderr: string;
  session: string;
}

export interface SessionBackend {
  readonly kind: SessionBackendKind;
  /** 终端复用器可达（已安装） */
  available(): boolean;
  /** 复用器 server 全局配置（tmux extended-keys——best-effort） */
  configure(): void;
  /** 用户命名 → 复用器会话名（前缀规则收敛进实现——ptl- 是 tmux 细节） */
  sessionName(name: string): string;
  /** 会话名消毒（合法返回 null，非法返回错误消息） */
  validateName(name: string): string | null;
  /** 会话存在（精确匹配） */
  has(name: string): boolean;
  /** 创建会话（detach=true 后台 / false 前台接入） */
  create(launch: SessionLaunch, name: string, detach: boolean): SessionCreateResult;
  /** 前台接入会话 */
  attach(name: string): void;
  /** 复用器内瞬移切换（tmux switch-client） */
  switchTo(name: string): void;
  /** 当前会话脱离（复用器内） */
  detach(): void;
  /** 终止会话 */
  kill(name: string): boolean;
  /** 列出全部本工具会话（前缀过滤收敛进实现） */
  list(): PtlSession[];
  /** pane 启动命令映射 */
  panes(): PtlPanes;
  /** pane pid + 当前命令 */
  panesDetailed(): Map<string, PtlPaneInfo>;
  /** 会话 pane 主进程 pid */
  panePid(sessionName: string): number | null;
  /** 向会话注入按键（agent 任务投递） */
  sendKeys(name: string, keys: string): void;
  /** 按模板别名列出运行中会话 */
  sessionsForTenant(templateAlias: string): string[];
  /** 复用器特定交互提示（tmux Ctrl+B / zellij Ctrl+o） */
  hintText(): string;
  /** 年龄格式化（复用器无关——展示层） */
  formatAge(ms: number): string;
}

/** 后端注册表：实现模块（tmux-backend）import 时注册——断 session-backend↔tmux-backend 文件级环 */
const registry = new Map<SessionBackendKind, () => Promise<SessionBackend>>();

export function registerSessionBackend(kind: SessionBackendKind, factory: () => Promise<SessionBackend>): void {
  registry.set(kind, factory);
}

/** 后端选择：kind → 实现（tmux 已实现；zellij/screen 扩展点） */
export async function getSessionBackend(kind?: SessionBackendKind): Promise<SessionBackend> {
  const resolved = kind ?? readBackendConfig();
  const factory = registry.get(resolved);
  if (!factory) {
    const hint = resolved === "tmux" ? "（tmux 实现未注册——请 import @away_from/shared 全 barrel）" : "";
    throw new Error(`会话后端 "${resolved}" 尚未实现（v1 仅 tmux；zellij/screen 为扩展点）${hint}`);
  }
  return factory();
}

/** 配置读取：config `session.backend`（缺省 tmux）——惰性 import 防循环 */
function readBackendConfig(): SessionBackendKind {
  try {
    // 读取 shared config（ptl config get session.backend 同源）
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadConfig } = require("./config.js") as { loadConfig: () => { session?: { backend?: string } } };
    const backend = loadConfig()?.session?.backend;
    if (backend === "tmux" || backend === "zellij" || backend === "screen") return backend;
  } catch { /* config 不可读——缺省 tmux */ }
  return "tmux";
}
