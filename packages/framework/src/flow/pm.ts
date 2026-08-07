/**
 * ptl-flow process manager — spawnAgent 实现
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import type { NodeDef } from "./schema.js";
import type { SpawnAgent, SpawnResult } from "./engine.js";

/**
 * 真实 spawnAgent：spawn pi --print --mode json --no-session，
 * prompt 经 stdin 传入，只聚合 text_delta。
 */
export function makeSpawnAgent(): SpawnAgent {
  return async function spawnAgent(
    node: NodeDef,
    renderedPrompt: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): Promise<SpawnResult> {
    const piBin = process.env.PI_BIN ?? "pi";
    const args = ["--print", "--mode", "json", "--no-session"];

    if (node.model) args.push("--model", node.model);
    if (node.tools && node.tools.length > 0) args.push("--tools", node.tools.join(","));
    // 注意：pi 无 --timeout 选项；超时由本进程 setTimeout 杀进程组实现

    const child = spawn(piBin, args, {
      cwd,
      env: { ...process.env, ...env },  // flow 环境覆盖宿主
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,  // 独立进程组，超时可整组杀
    });

    const outputChunks: string[] = [];
    let exitCode = 0;
    let signal: string | null = null;

    // stdout → 逐行解析 JSON 事件，聚合 text_delta
    const decoder = new StringDecoder("utf-8");
    let stdoutBuf = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += decoder.write(chunk);
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          // pi --mode json 是扁平结构：assistantMessageEvent 在事件顶层
          if (event.type === "message_update") {
            const ame = (event as any).assistantMessageEvent
              ?? (event.data as any)?.assistantMessageEvent
              ?? event.data;
            if (ame?.type === "text_delta" && typeof ame.delta === "string") {
              outputChunks.push(ame.delta);
            }
          }
        } catch { /* 忽略非 JSON 行 */ }
      }
    });

    return new Promise((resolve, reject) => {
      // 超时控制：杀掉整个进程组
      let timedOut = false;
      const timeoutMs = (node.timeoutSec ?? 120) * 1000;
      const timer = setTimeout(() => {
        timedOut = true;
        try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* 已退出 */ }
      }, timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on("close", (code, sig) => {
        clearTimeout(timer);
        exitCode = timedOut ? 124 : (code ?? 0);
        signal = sig;

        // flush 剩余 stdout
        if (stdoutBuf.trim()) {
          try {
            const event = JSON.parse(stdoutBuf.trim()) as Record<string, unknown>;
            if (event.type === "message_update") {
              const ame = (event.data as any)?.assistantMessageEvent ?? event.data;
              if (ame?.type === "text_delta" && typeof ame.delta === "string") {
                outputChunks.push(ame.delta);
              }
            }
          } catch { /* ignore */ }
        }

        resolve({
          output: outputChunks.join(""),
          exitCode,
          signal,
        });
      });

      // stdin: 写入 prompt 后关闭
      child.stdin?.write(renderedPrompt);
      child.stdin?.end();
    });
  };
}
