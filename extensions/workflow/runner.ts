import { spawn, spawnSync } from "node:child_process";

export interface SyncResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface AsyncResult {
  ok: boolean;
  runId: string;
  error?: string;
}

const PIT_BIN = process.env.PIT_BIN ?? "pit";

/** 检查 pit CLI 是否可用 */
export function hasPitCli(): boolean {
  const r = spawnSync(PIT_BIN, ["--version"], { encoding: "utf-8", timeout: 5000 });
  return r.status === 0;
}

/** 同步短命令（ls/status/show/graph/validate/rm） */
export function syncRun(args: string[], cwd?: string): SyncResult {
  const r = spawnSync(PIT_BIN, args, {
    encoding: "utf-8",
    cwd,
    timeout: 15000,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status ?? -1,
  };
}

/**
 * 异步长命令（run/approve/reject/resume）：
 * spawn args 数组（不走 shell），pipe stdout 读「启动」行捕获 runId 前缀。
 * onStart 回调立即通知 runId；进程结束 onFinish 通知最终状态。
 */
export function asyncRun(
  args: string[],
  cwd: string,
  onStart: (runId: string) => void,
  onFinish: (ok: boolean, stderr: string) => void,
): void {
  const child = spawn(PIT_BIN, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf-8",
  });

  let capturedRunId = "";
  const stderrChunks: string[] = [];

  child.stdout?.on("data", (chunk: string) => {
    // 捕获「启动: name (runId…)」行
    const match = chunk.match(/启动:\s*\S+\s+\(([0-9a-f]{8})…/);
    if (match && !capturedRunId) {
      capturedRunId = match[1]!;
      onStart(capturedRunId);
    }
  });

  child.stderr?.on("data", (chunk: string) => {
    stderrChunks.push(chunk);
  });

  child.on("error", (err) => {
    if (!capturedRunId) onStart(""); // signal failure
    onFinish(false, err.message);
  });

  child.on("close", (code) => {
    const stderr = stderrChunks.join("");
    if (!capturedRunId && stderr.trim()) {
      // 启动即失败（如 flow.json 校验错误）→ 立即通知
      onFinish(false, stderr);
      return;
    }
    onFinish(code === 0, stderr);
  });
}
