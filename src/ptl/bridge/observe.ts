/**
 * bridge/observe.ts — pit hub observe 命令（F/WP4 Task 21）
 *
 * 远程观测（只读）——数据源为 Redis 会话痕迹（WP5 前先行交付）：
 *
 *   pit hub observe sessions [--json]         会话列表
 *   pit hub observe session <id> [--json]     会话详情（meta）
 *   pit hub observe trace <id> [--json]       trace 时间线
 *   pit hub observe events [--json]           事件查询（EventLog 代理——WP5 Task 28 交付）
 *
 * print/json 双模式：缺省表格打印；--json 输出原样 JSON。
 */
import { PthClient } from "./client.js";
import { printBanner } from "../pit/main.js";

export async function cmdHubObserve(passthrough: string[], flags: Record<string, string>): Promise<void> {
  const what = passthrough[0];
  if (!what || !["sessions", "session", "trace", "events"].includes(what)) {
    console.log("  用法: pit hub observe <sessions|session <id>|trace <id>|events> [--json]");
    process.exit(1);
  }

  const client = PthClient.fromConfig();
  if (!client) {
    console.log("  \x1b[31m❌ 未配置 PTH 连接\x1b[0m");
    console.log("  配置: pit config set pth.url <url>  &&  pit config set pth.token <token>");
    process.exit(1);
  }

  try {
    if (what === "sessions") {
      const sessions = await client.listObserveSessions();
      if (flags.json) {
        console.log(JSON.stringify(sessions, null, 2));
        return;
      }
      printBanner();
      console.log("  \x1b[1m远程会话（Redis 会话痕迹）\x1b[0m");
      if (sessions.length === 0) {
        console.log("\n  暂无会话痕迹。");
      } else {
        console.log("");
        console.log(`  \x1b[2m${"SESSION_ID".padEnd(38)}${"PROJECT".padEnd(16)}${"STATE".padEnd(8)}${"ENTRIES".padEnd(8)}  UPDATED  MODEL\x1b[0m`);
        for (const s of sessions) {
          const id = s.sessionId.slice(0, 36).padEnd(38);
          const project = (s.project || "-").padEnd(16);
          const state = s.status.padEnd(8);
          const entries = String(s.entryCount).padEnd(8);
          const updated = s.updatedAt.slice(0, 16).replace("T", " ");
          console.log(`  \x1b[1m${id}\x1b[0m${project}${state}${entries}  ${updated}  ${s.model}`);
        }
        console.log("\n  详情: \x1b[36mpit hub observe session <id>\x1b[0m   trace: \x1b[36mpit hub observe trace <id>\x1b[0m");
      }
      console.log("");
      return;
    }

    if (what === "session") {
      const id = passthrough[1];
      if (!id) {
        console.log("  用法: pit hub observe session <id>");
        process.exit(1);
      }
      const meta = await client.getObserveSession(id);
      if (flags.json) {
        console.log(JSON.stringify(meta, null, 2));
        return;
      }
      printBanner();
      console.log("  \x1b[1m会话详情\x1b[0m");
      console.log("");
      console.log(`  sessionId:    ${meta.sessionId}`);
      console.log(`  project:      ${meta.project}`);
      console.log(`  state:        ${meta.status}`);
      console.log(`  model:        ${meta.model}`);
      console.log(`  entryCount:   ${meta.entryCount}`);
      console.log(`  lastEntrySeq: ${meta.lastEntrySeq}`);
      console.log(`  createdAt:    ${meta.createdAt}`);
      console.log(`  updatedAt:    ${meta.updatedAt}`);
      console.log("");
      return;
    }

    if (what === "trace") {
      const id = passthrough[1];
      if (!id) {
        console.log("  用法: pit hub observe trace <id>");
        process.exit(1);
      }
      const trace = await client.getObserveTrace(id);
      if (flags.json) {
        console.log(JSON.stringify(trace, null, 2));
        return;
      }
      printBanner();
      console.log(`  \x1b[1mtrace 时间线\x1b[0m  ${trace.sessionId.slice(0, 12)}…  (${trace.entries.length} 条)`);
      console.log("");
      for (const e of trace.entries) {
        const text = (e.content ?? [])
          .map((c) => (typeof c.text === "string" ? c.text : ""))
          .filter((t: string) => t.length > 0)
          .join(" ")
          .replace(/\s+/g, " ")
          .slice(0, 120);
        const role = e.role.padEnd(9);
        const ts = e.createdAt.slice(11, 19);
        console.log(`  \x1b[2m[${e.seq}] ${ts}\x1b[0m ${role}${text}`);
      }
      console.log("");
      return;
    }

    // what === "events"
    if (flags.json) {
      console.log(JSON.stringify({ deferred: true, note: "EventLog query depends on WP5 Task 23/24; delivered with Task 28" }));
      return;
    }
    printBanner();
    console.log("  \x1b[1m事件查询\x1b[0m");
    console.log("");
    console.log("  \x1b[33m⚠ EventLog 查询子项经常驻系统会话代理（依赖 WP5 Task 23/24），\x1b[0m");
    console.log("  \x1b[33m  拆分为 WP5 收尾时交付（并入 Task 28 验收）。\x1b[0m");
    console.log("  Redis 会话痕迹已先行交付: pit hub observe sessions / session <id> / trace <id>");
    console.log("");
    // 仍尝试请求——服务器 501 时透出其返回的说明
    try {
      await client.getObserveEvents();
    } catch (err: any) {
      console.log(`  \x1b[2m${err.message}\x1b[0m`);
      console.log("");
    }
  } catch (err: any) {
    console.log(`\x1b[31m❌ 观测失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}
