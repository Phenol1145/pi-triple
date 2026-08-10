// packages/framework/src/tui-ptl/dashboard.tsx — 总览面板（master-detail）
//
// Health 紧凑行 + 三个表（Templates / Sessions / Trace，Tab 切换焦点）+
// 水平聚焦栏 + 详情区（聚焦表选中项）+ 会话操作模态菜单（Enter 打开，Esc 关闭）。
// 仅焦点表渲染 DataTable（非焦点表只显示标题行）；固定开销 10 行预留
// Health 1 + 三标题 3 + 焦点表头 1 + 聚焦栏 1 + Detail 3 + 提示 1。
// 数据源：listAllSessions/listAllTraces（TUI 启动时 providers 已注册）。
import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { spawnSync } from "node:child_process";
import { DataTable, useTableSelection, tableWindow } from "../tui-shared/index.js";
import type { ColumnDef } from "../tui-shared/index.js";
import { SessionMenuPanel } from "./session-menu.js";
import { listAllSessions, listAllTraces } from "../session/session-store.js";
import { loadConfig, listTemplates } from "@away_from/shared";
import type { SessionRecord, TraceRecord } from "../session/session-provider.js";

interface DashPageProps {
  width: number;
  height: number;
  enabled?: boolean;
  onNotify?: (msg: string) => void;
  onCommand?: (cmd: string, args: string[]) => void;
  onMenuChange?: (open: boolean) => void;
}

interface HealthItem {
  name: string;
  status: "ok" | "warn" | "fail";
  message: string;
}

export function DashboardPage({ height, enabled = true, onNotify, onCommand, onMenuChange }: DashPageProps) {
  const [health, setHealth] = useState<HealthItem[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [traces, setTraces] = useState<TraceRecord[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [focus, setFocus] = useState(0); // 0=templates 1=sessions 2=traces
  const [menuRecord, setMenuRecord] = useState<SessionRecord | null>(null);

  // 数据（每次刷新重读，简单可靠）
  useEffect(() => {
    (async () => {
      setSessions(await listAllSessions());
      setTraces(listAllTraces());
      runQuickHealth().then(setHealth);
    })();
  }, [refreshKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const templates = listTemplates(loadConfig());
  const tplSel = useTableSelection(templates.length, enabled);
  const sessSel = useTableSelection(sessions.length, enabled);
  const traceSel = useTableSelection(traces.length, enabled);

  useInput((input, key) => {
    if (!enabled) return;
    if (menuRecord) return; // 模态菜单独占输入
    if (key.upArrow) {
      if (focus === 0) tplSel.move(-1);
      else if (focus === 1) sessSel.move(-1);
      else traceSel.move(-1);
      return;
    }
    if (key.downArrow) {
      if (focus === 0) tplSel.move(1);
      else if (focus === 1) sessSel.move(1);
      else traceSel.move(1);
      return;
    }
    if (key.tab) { setFocus((f) => (f + 1) % 3); return; }
    if (key.return && focus === 1 && sessions[sessSel.index]) {
      setMenuRecord(sessions[sessSel.index]!);
      return;
    }
    if (input === "r" && !key.ctrl) refresh();
  });

  // 仅焦点表渲染列表；固定开销 10 行（Health 1 + 三标题 3 + 焦点表头 1 + 聚焦栏 1 + Detail 3 + 提示 1）
  const cap = Math.max(2, height - 10);
  const tplW = tableWindow(templates, tplSel.index, cap);
  const sessW = tableWindow(sessions, sessSel.index, cap);
  const traceW = tableWindow(traces, traceSel.index, cap);

  // 滚动指示：仅焦点表显示
  const scrollHint = (w: { rows: unknown[]; offset: number }, total: number): string =>
    total > w.rows.length ? `  ▾ ${w.offset + 1}-${w.offset + w.rows.length}/${total}` : "";

  // 窗口相对 ↔ 绝对（Task 7 review 修复）：DataTable 只拿到窗口切片 rows，
  // selectedIndex / onSelectionChange 均为窗口相对索引；回执须加回 offset 还原为绝对索引。

  const tplCols: ColumnDef[] = [
    { key: "alias", label: "TENANT", width: 14 },
    { key: "model", label: "MODEL", width: 18 },
    { key: "id", label: "ID" },
  ];
  const tplRows = tplW.rows.map((t) => ({
    alias: t.alias,
    model: t.config.model ?? "(default)",
    id: t.id.slice(0, 8) + "…",
  }));

  const sessCols: ColumnDef[] = [
    { key: "status", label: "", width: 2 },
    { key: "workloop", label: "LOOP", width: 8 },
    { key: "template", label: "TEMPLATE", width: 14 },
    { key: "id", label: "ID" },
    { key: "summary", label: "摘要" },
  ];
  const sessRows = sessW.rows.map((s) => ({
    status: s.status === "running" ? "●" : "○",
    workloop: s.workloop,
    template: s.templateAlias,
    id: s.id.slice(0, 8) + "…",
    summary: s.summary,
  }));

  const traceCols: ColumnDef[] = [
    { key: "workloop", label: "LOOP", width: 8 },
    { key: "id", label: "ID" },
    { key: "summary", label: "摘要" },
  ];
  const traceRows = traceW.rows.map((t) => ({
    workloop: t.workloop,
    id: t.id.length > 12 ? t.id.slice(0, 12) + "…" : t.id,
    summary: t.summary,
  }));

  // ── 水平聚焦栏（固定 1 行，显示当前聚焦对象）─────────────
  let focusBar: string;
  if (focus === 0 && templates[tplSel.index]) {
    const t = templates[tplSel.index]!;
    focusBar = `模板 ${t.alias}${t.isDefault ? " ★默认" : ""} · workloop: ${t.config.workLoop?.id ?? "(default)"} · model: ${t.config.model ?? "(default)"}`;
  } else if (focus === 1 && sessions[sessSel.index]) {
    const s = sessions[sessSel.index]!;
    focusBar = `会话 ${s.status === "running" ? "●" : "○"} [${s.workloop}] ${s.id} · ${s.templateAlias} · ${s.summary}`;
  } else if (focus === 2 && traces[traceSel.index]) {
    const t = traces[traceSel.index]!;
    focusBar = `追踪 ${t.id} · ${t.summary}`;
  } else {
    focusBar = `（${["模板", "会话", "追踪"][focus] ?? ""} 无可选条目）`;
  }

  // ── 详情区（聚焦表选中项）──────────────────────────────
  const focusName = ["模板", "会话", "追踪"][focus] ?? "";
  let detail: React.ReactNode;
  if (focus === 0 && templates[tplSel.index]) {
    const t = templates[tplSel.index]!;
    const skills = t.config.skills?.length ? t.config.skills.join(", ") : "(none)";
    const inst = t.config.instantiation;
    detail = (
      <>
        <Text bold>模板 · {t.alias}{t.isDefault ? " ★默认" : ""}</Text>
        <Text dimColor>
          ID: {t.id} · workloop: {t.config.workLoop?.id ?? "(default)"} · model: {t.config.model ?? "(default)"} ·
          ext: {t.config.extensions?.length ?? 0}
        </Text>
        <Text dimColor>skills: {skills}{inst ? ` · inst: ${inst.lifecycle ?? "?"}${inst.count ? ` ×${inst.count}` : ""}` : ""}</Text>
      </>
    );
  } else if (focus === 1 && sessions[sessSel.index]) {
    const s = sessions[sessSel.index]!;
    const entries = Object.entries(s.detail);
    const shown = entries.slice(0, 3);
    const rest = entries.length - shown.length;
    detail = (
      <>
        <Text bold>{s.status === "running" ? "●" : "○"} 会话 · {s.id} [{s.workloop}]</Text>
        <Text dimColor>  {s.summary}</Text>
        {shown.map(([k, v]) => (
          <Text key={k} dimColor>  {k}: {v.slice(0, 40)}</Text>
        ))}
        {rest > 0 ? <Text dimColor>  … 另有 {rest} 项</Text> : null}
      </>
    );
  } else if (focus === 2 && traces[traceSel.index]) {
    const t = traces[traceSel.index]!;
    const entries = Object.entries(t.detail);
    const shown = entries.slice(0, 3);
    const rest = entries.length - shown.length;
    detail = (
      <>
        <Text bold>Trace · {t.id} [{t.workloop}]</Text>
        <Text dimColor>  {t.timestamp}</Text>
        <Text dimColor>  {t.summary}</Text>
        {shown.map(([k, v]) => (
          <Text key={k} dimColor>  {k}: {v.slice(0, 40)}</Text>
        ))}
        {rest > 0 ? <Text dimColor>  … 另有 {rest} 项</Text> : null}
      </>
    );
  } else {
    detail = <Text dimColor>  （无可选条目）</Text>;
  }

  const focusColor = focus === 0 ? "green" : focus === 1 ? "cyan" : "magenta";
  const focusMark = (f: number) => (focus === f ? " ❯" : "");

  // 模态菜单：打开时独占面板（全高渲染，不被表格/详情挤裁）
  if (menuRecord) {
    return (
      <SessionMenuPanel
        record={menuRecord}
        onClose={() => setMenuRecord(null)}
        onNotify={onNotify}
        onRefresh={refresh}
        onCommand={onCommand}
        onMenuChange={onMenuChange}
      />
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      {/* Health 紧凑行 */}
      <Box gap={2}>
        {health.length === 0 ? (
          <Text dimColor>Health: checking…</Text>
        ) : (
          health.map((h, i) => (
            <Text key={i} color={h.status === "ok" ? "green" : h.status === "warn" ? "yellow" : "red"}>
              {h.status === "ok" ? "✅" : h.status === "warn" ? "⚠️" : "❌"} {h.name}: {h.message}
            </Text>
          ))
        )}
      </Box>

      {/* Templates */}
      <Box flexDirection="column">
        <Text bold underline color={focus === 0 ? focusColor : undefined}>
          Templates ({templates.length}){focusMark(0)}
          {focus === 0 ? <Text dimColor>{scrollHint(tplW, templates.length)}</Text> : null}
        </Text>
        {focus === 0 && (templates.length === 0 ? (
          <Text dimColor>  无模板 — 创建: ptl template new &lt;alias&gt;</Text>
        ) : templates.length > 0 ? (
          <DataTable
            columns={tplCols}
            rows={tplRows}
            selectable
            selectedIndex={tplSel.index - tplW.offset}
            onSelectionChange={(rel) => tplSel.setIndex(tplW.offset + rel)}
          />
        ) : null)}
      </Box>

      {/* Sessions */}
      <Box flexDirection="column">
        <Text bold underline color={focus === 1 ? focusColor : undefined}>
          Sessions ({sessions.length}){focusMark(1)}
          {focus === 1 ? <Text dimColor>{scrollHint(sessW, sessions.length)}</Text> : null}
        </Text>
        {focus === 1 && (sessions.length === 0 ? (
          <Text dimColor>  无会话 — 启动: ptl start --bg --name &lt;name&gt;</Text>
        ) : sessions.length > 0 ? (
          <DataTable
            columns={sessCols}
            rows={sessRows}
            selectable
            selectedIndex={sessSel.index - sessW.offset}
            onSelectionChange={(rel) => sessSel.setIndex(sessW.offset + rel)}
            rowColor={(r) => (r.status === "●" ? "green" : undefined)}
          />
        ) : null)}
      </Box>

      {/* Trace */}
      <Box flexDirection="column">
        <Text bold underline color={focus === 2 ? focusColor : undefined}>
          Trace ({traces.length}){focusMark(2)}
          {focus === 2 ? <Text dimColor>{scrollHint(traceW, traces.length)}</Text> : null}
        </Text>
        {focus === 2 && (traces.length === 0 ? (
          <Text dimColor>  无追踪 — 运行 ptl hub kernel/submit 任务后显示</Text>
        ) : traces.length > 0 ? (
          <DataTable
            columns={traceCols}
            rows={traceRows}
            selectable
            selectedIndex={traceSel.index - traceW.offset}
            onSelectionChange={(rel) => traceSel.setIndex(traceW.offset + rel)}
          />
        ) : null)}
      </Box>

      {/* 水平聚焦栏（固定 1 行，显示当前聚焦对象） */}
      <Box flexDirection="row" gap={1} minHeight={1}>
        <Text bold color={focusColor}>❯ {["模板", "会话", "追踪"][focus] ?? ""}</Text>
        <Text dimColor wrap="truncate">{focusBar}</Text>
      </Box>

      {/* 详情区 */}
      <Box flexDirection="column">
        <Text bold underline color={focusColor}>Detail · {focusName}</Text>
        {detail}
      </Box>

      <Text dimColor>Tab 切换焦点 · ↑↓ 选择 · Enter 会话菜单 · r 刷新 · / 命令 · /quit 退出</Text>
    </Box>
  );
}

/** Quick health check（同步版供 TUI） */
async function runQuickHealth(): Promise<HealthItem[]> {
  const items: HealthItem[] = [];

  // Node.js
  items.push({ name: "Node.js", status: "ok", message: process.version });

  // pi CLI
  try {
    const piVer = spawnSync("pi", ["--version"], { encoding: "utf-8", timeout: 5000 });
    items.push({
      name: "pi CLI",
      status: piVer.status === 0 ? "ok" : "fail",
      message: piVer.status === 0 ? `v${piVer.stdout.trim()}` : "not installed",
    });
  } catch {
    items.push({ name: "pi CLI", status: "fail", message: "not installed" });
  }

  // Redis
  const net = await import("node:net");
  const redisOk = await new Promise<boolean>((resolve) => {
    const s = net.createConnection({ host: "localhost", port: 6379, timeout: 3000 });
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.on("timeout", () => { s.destroy(); resolve(false); });
  });
  items.push({
    name: "Redis",
    status: redisOk ? "ok" : "fail",
    message: redisOk ? "connected" : "unreachable",
  });

  // Data dir
  try {
    const { mkdirSync, writeFileSync, unlinkSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const cfg = loadConfig();
    const dir = resolve(process.cwd(), process.env.DATA_DIR ?? cfg.dataDir);
    mkdirSync(dir, { recursive: true });
    const test = resolve(dir, ".tui-test");
    writeFileSync(test, "ok");
    unlinkSync(test);
    items.push({ name: "Data Dir", status: "ok", message: "writable" });
  } catch {
    items.push({ name: "Data Dir", status: "fail", message: "not writable" });
  }

  return items;
}
