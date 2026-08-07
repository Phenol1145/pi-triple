/**
 * warnings.ts — 入口级警告过滤（进程启动最早处调用）
 *
 * node:sqlite 在 node 24 仍为实验特性（Stability 1.1），每次实例化
 * DatabaseSync 都会向 stderr 打印 ExperimentalWarning。ptl 大量使用
 * lab-data（只读 agent-lab DB），警告噪音大且无信息量。
 *
 * 策略：移除默认 warning 打印，安装自定义监听——
 *   仅静默 "ExperimentalWarning: SQLite"（精确匹配），其余警告原样输出。
 */

/** 纯判定：是否为 SQLite 实验警告（可单测） */
export function isSqliteExperimentalWarning(w: Error | { name?: string; message?: string }): boolean {
  return w?.name === "ExperimentalWarning" && (w?.message ?? "").includes("SQLite");
}

/** 安装入口级警告过滤（幂等） */
export function installWarningFilter(): void {
  process.removeAllListeners("warning");
  process.on("warning", (w: Error) => {
    if (isSqliteExperimentalWarning(w)) return;
    process.stderr.write(`${w.stack ?? w.message}\n`);
  });
}
