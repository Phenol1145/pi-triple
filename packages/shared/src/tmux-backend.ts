/**
 * tmux-backend.ts — tmux 会话后端（SessionBackend 实现）
 *
 * 收敛：shared/tmux.ts 的 14 原语（组合复用）+ cli/sessions.ts 泄漏的
 * attach/switch-client/detach-client/has-session + cli/agent.ts 的 send-keys。
 * 命令层经 SessionBackend 接口访问——tmux 方言（前缀/switch-client/提示）收敛于此。
 */

import { spawnSync } from "node:child_process";
import { registerSessionBackend } from "./session-backend.js";
import type { SessionBackend, SessionBackendKind, SessionCreateResult, SessionLaunch } from "./session-backend.js";
import {
  buildTmuxSessionArgs,
  configureTmuxServer,
  formatAge,
  getPanePid,
  hasPtlSession,
  hasTmux,
  killPtlSession,
  listPtlPanes,
  listPtlPanesDetailed,
  listPtlSessions,
  sessionsForTenant,
  tmuxSessionName,
  validateSessionName,
  type PtlPaneInfo,
  type PtlPanes,
  type PtlSession,
} from "./tmux.js";

export class TmuxBackend implements SessionBackend {
  readonly kind: SessionBackendKind = "tmux";

  available(): boolean { return hasTmux(); }
  configure(): void { configureTmuxServer(); }
  sessionName(name: string): string { return tmuxSessionName(name); }
  validateName(name: string): string | null { return validateSessionName(name); }
  has(name: string): boolean { return hasPtlSession(name); }
  kill(name: string): boolean { return killPtlSession(name); }
  list(): PtlSession[] { return listPtlSessions(); }
  panes(): PtlPanes { return listPtlPanes(); }
  panesDetailed(): Map<string, PtlPaneInfo> { return listPtlPanesDetailed(); }
  panePid(sessionName: string): number | null { return getPanePid(sessionName); }
  sessionsForTenant(templateAlias: string): string[] { return sessionsForTenant(templateAlias); }
  formatAge(ms: number): string { return formatAge(ms); }

  create(launch: SessionLaunch, name: string, detach: boolean): SessionCreateResult {
    const session = this.sessionName(name);
    const args = buildTmuxSessionArgs(launch, session, detach);
    const r = spawnSync("tmux", args, { encoding: "utf-8" });
    return { status: r.status ?? 1, stderr: r.stderr ?? "", session };
  }

  /** 前台接入（tmux attach -t =ptl-<name>——精确匹配；TERM 兜底收敛于此） */
  attach(name: string): void {
    spawnSync("tmux", ["attach", "-t", `=${this.sessionName(name)}`], {
      stdio: "inherit",
      env: { ...process.env, TERM: process.env.TERM ?? "xterm-256color" },
    });
  }

  /** 复用器内瞬移（tmux switch-client） */
  switchTo(name: string): void {
    spawnSync("tmux", ["switch-client", "-t", `=${this.sessionName(name)}`], { stdio: "inherit" });
  }

  /** 当前会话脱离（复用器内） */
  detach(): void {
    spawnSync("tmux", ["detach-client"], { stdio: "inherit" });
  }

  /** 向会话注入按键（agent 任务投递） */
  sendKeys(name: string, keys: string): void {
    spawnSync("tmux", ["send-keys", "-t", this.sessionName(name), keys, "Enter"], { encoding: "utf-8" });
  }

  hintText(): string {
    return "tmux 内 Ctrl+B s 选择 · Ctrl+B d 脱离";
  }
}

export function createTmuxBackend(): TmuxBackend {
  return new TmuxBackend();
}

// 模块优化 P0：实现模块自注册（方向 tmux-backend → session-backend；session-backend 不再反向 dynamic import）
registerSessionBackend("tmux", async () => createTmuxBackend());
