// src/bench/judge.ts
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface JudgeResult {
  passed: boolean;
  error?: string;
}

/**
 * 拼装判题脚本：prompt + code + test + check(entry_point) 调用。
 *
 * HumanEval 的 test 字段只含 `def check(candidate): assert ...`，
 * 官方 harness 额外拼接 `check({entry_point})` 来实际调用它。
 * 如果漏掉这个调用，错误解也会 exit 0（check 定义了但从未调用）。
 */
export function buildJudgeScript(
  prompt: string,
  code: string,
  test: string,
  entryPoint: string,
): string {
  return `${prompt}\n${code}\n\n${test}\n\ncheck(${entryPoint})\n`;
}

/**
 * 在临时目录执行 python3 判题，超时 SIGKILL。
 *
 * 只用临时文件 + spawn("python3", [file], { shell: false })；
 * 不用 `python3 -c`（引号/反斜杠 shell 转义脆弱，且 shell:true 有注入面）。
 */
export async function judgePython(
  prompt: string,
  code: string,
  test: string,
  entryPoint: string,
  timeoutMs: number,
): Promise<JudgeResult> {
  const dir = mkdtempSync(path.join(tmpdir(), "bench-judge-"));
  const file = path.join(dir, "t.py");
  try {
    writeFileSync(file, buildJudgeScript(prompt, code, test, entryPoint));
    return await new Promise<JudgeResult>((resolve) => {
      const child = spawn("python3", [file], { shell: false });
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ passed: false, error: "timeout" });
      }, timeoutMs);
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          passed: code === 0,
          error:
            code === 0
              ? undefined
              : code === null
                ? "terminated by signal"
                : stderr.split("\n").slice(-3).join("\n") || `exit ${code}`,
        });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ passed: false, error: e.message });
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
