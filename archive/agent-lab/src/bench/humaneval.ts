import { gunzipSync } from "node:zlib";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { localConfigDir } from "../config-io.ts";

export interface HumanEvalTask {
  task_id: string;
  prompt: string;
  entry_point: string;
  canonical_solution: string;
  test: string;
}

const URL = "https://raw.githubusercontent.com/openai/human-eval/master/data/HumanEval.jsonl.gz";

export function parseHumanEvalJsonl(text: string): HumanEvalTask[] {
  const out: HumanEvalTask[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o.task_id === "string" && typeof o.prompt === "string") out.push(o as HumanEvalTask);
    } catch { /* 跳过坏行 */ }
  }
  return out;
}

export async function loadHumanEval(n: number, opts?: { cacheDir?: string }): Promise<HumanEvalTask[]> {
  const dir = opts?.cacheDir ?? localConfigDir();
  mkdirSync(dir, { recursive: true });
  const cache = path.join(dir, "humaneval.jsonl");
  let text: string;
  if (existsSync(cache)) {
    text = readFileSync(cache, "utf8");
  } else {
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`HumanEval 下载失败: ${res.status}`);
    const gz = Buffer.from(await res.arrayBuffer());
    text = gunzipSync(gz).toString("utf8");
    writeFileSync(cache, text);
  }
  return parseHumanEvalJsonl(text).slice(0, n);
}
