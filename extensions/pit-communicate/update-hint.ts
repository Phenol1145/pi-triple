/**
 * pit-communicate/update-hint — 会话内更新提示（扩展 notify）
 *
 * factory 在 session_start 时 fire-and-forget 调用；任何异常静默。
 */

import { checkForUpdates, isUpdateAvailable } from "../_shared/version-check.js";

export type UpdateReport = {
  pit?: string;
  piSdk?: string;
  currentPit?: string;
  currentPiSdk?: string;
};

export function formatUpdateHint(report: UpdateReport): string[] {
  const lines: string[] = [];
  if (report.pit && report.currentPit && isUpdateAvailable(report.pit, report.currentPit)) {
    lines.push(`⚠ pit 更新可用: v${report.pit}（当前 v${report.currentPit}）→ 运行 pit update 一次更新全部`);
  }
  if (report.piSdk && report.currentPiSdk && isUpdateAvailable(report.piSdk, report.currentPiSdk)) {
    lines.push(`⚠ pi SDK 更新可用: v${report.piSdk}（当前 v${report.currentPiSdk}）→ 运行 pit update 一并升级`);
  }
  return lines;
}

export async function maybeShowUpdateHint(
  ctx: { ui: { notify: (text: string, level?: string) => void } },
  deps: { checker?: () => Promise<UpdateReport> } = {},
): Promise<void> {
  try {
    const checker = deps.checker ?? checkForUpdates;
    const report = await checker();
    const lines = formatUpdateHint(report);
    for (const line of lines) {
      ctx.ui.notify(line, "warning");
    }
  } catch {
    /* 更新提示失败静默 */
  }
}
