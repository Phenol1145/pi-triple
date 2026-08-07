// packages/framework/src/tui-ptl/session-menu.tsx — 会话操作菜单（dashboard 与 sessions 面板共用）
//
// 导出：
//   SESSION_MENU            静态菜单规格（叶子 op 由 buildSessionMenu 绑定处理器）
//   sessionMenuCapabilities 会话 → 可执行能力（纯函数，可测）
//   bareTmuxName             tmux 会话名（ptl- 前缀）→ 裸名
//   sessionTmuxName         SessionRecord → tmux 会话名（含前缀；未运行返回 null）
//   buildSessionMenu         规格 + 处理器 → 按能力过滤的 MenuNode 树（可测）
//   SessionMenuPanel         模态菜单组件（菜单/SelectList 对话框/危险确认 一体）
import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { spawnSync } from "node:child_process";
import {
  createMenu,
  menuStep,
  menuBreadcrumb,
  filterMenuByCapabilities,
  SelectList,
  ConfirmDialog,
} from "../tui-shared/index.js";
import type { MenuNode, MenuState, SelectItem } from "../tui-shared/index.js";
import { listTemplates, loadConfig } from "@pi-triple/shared";
import { scanSessionFiles, listNodes } from "../session/pi-scan.js";
import { hasTmux, listPtlPanes } from "@pi-triple/shared";
import type { SessionRecord } from "../session/session-provider.js";

// ─── 菜单规格（静态；叶子 capability 即过滤键）────────────────

export type SessionOp =
  | "attach" | "resume" | "fork" | "clone" | "transfer" | "branch" | "tree" | "details" | "stop";

export interface SessionMenuSpec {
  key: string;
  label: string;
  capability?: string;
  dangerous?: boolean;
  op?: SessionOp;
  children?: SessionMenuSpec[];
}

export const SESSION_MENU: SessionMenuSpec[] = [
  { key: "r", label: "run", children: [
    { key: "a", label: "attach 前台接入", capability: "attach", op: "attach" },
    { key: "r", label: "resume 后台恢复", capability: "resume", op: "resume" },
  ]},
  { key: "c", label: "copy", children: [
    { key: "f", label: "fork 整会话", capability: "fork", op: "fork" },
    { key: "b", label: "branch 节点分支", capability: "branch", op: "branch" },
    { key: "t", label: "transfer 转移所有权", capability: "transfer", op: "transfer" },
    { key: "c", label: "clone 副本", capability: "clone", op: "clone" },
  ]},
  { key: "v", label: "view", children: [
    { key: "t", label: "tree 谱系树", capability: "tree", op: "tree" },
    { key: "d", label: "details 完整详情", op: "details" },
  ]},
  { key: "x", label: "stop 停止", capability: "stop", op: "stop", dangerous: true },
];

/** 会话可执行能力（filterMenuByCapabilities 的 capabilities 语义）：pi 全量；非 pi 仅 view */
export function sessionMenuCapabilities(rec: SessionRecord): string[] {
  if (rec.workloop !== "pi") return ["tree", "details"];
  const caps: string[] = ["attach", "resume", "fork", "clone", "transfer", "branch", "tree", "details"];
  if (rec.status === "running") caps.push("stop");
  return caps;
}

/** tmux 会话名（含 ptl- 前缀）→ 裸名（ptl attach/stop 用） */
export function bareTmuxName(full: string): string {
  return full.startsWith("ptl-") ? full.slice("ptl-".length) : full;
}

/** 由 SessionRecord 解析 tmux 会话名（含 ptl- 前缀）；未运行/无 tmux 返回 null */
export function sessionTmuxName(rec: SessionRecord): string | null {
  if (!hasTmux()) return null;
  const panes = listPtlPanes();
  return (
    Object.keys(panes).find(
      (n) => n === `ptl-${rec.id.slice(0, 8)}` || panes[n]?.includes(rec.id),
    ) ?? null
  );
}

// ─── 操作处理器（SessionMenuPanel 实现）───────────────────────

export interface SessionMenuHandlers {
  /** 直接执行会话命令（app 命令管线：notification/output/handoff） */
  run: (op: string, id: string, extra?: Record<string, string>) => void;
  /** attach：需 tmux 名称解析 + TMUX 内 switch-client */
  attach: (rec: SessionRecord) => void;
  /** fork/clone/transfer：打开模板选择 */
  pickTemplate: (op: "fork" | "clone" | "transfer", id: string) => void;
  /** branch：打开节点选择 */
  pickNode: (id: string) => void;
  /** stop：危险确认 */
  confirmStop: (rec: SessionRecord) => void;
}

/** 静态规格 → 绑定当前会话/处理器的 MenuNode 树，并按能力过滤（纯函数，可测） */
export function buildSessionMenu(rec: SessionRecord, h: SessionMenuHandlers): MenuNode[] {
  const bind = (spec: SessionMenuSpec): MenuNode => {
    const node: MenuNode = { key: spec.key, label: spec.label };
    if (spec.dangerous) node.dangerous = true;
    if (spec.capability) node.capability = spec.capability;
    if (spec.op) {
      node.action = () => {
        switch (spec.op) {
          case "attach": h.attach(rec); break;
          case "resume": h.run("resume", rec.id); break;
          case "fork": h.pickTemplate("fork", rec.id); break;
          case "clone": h.pickTemplate("clone", rec.id); break;
          case "transfer": h.pickTemplate("transfer", rec.id); break;
          case "branch": h.pickNode(rec.id); break;
          case "tree": h.run("tree", rec.id, { template: rec.templateAlias }); break;
          case "details": h.run("show", rec.id); break;
          case "stop": h.confirmStop(rec); break;
        }
      };
    }
    if (spec.children) node.children = spec.children.map(bind);
    return node;
  };
  return filterMenuByCapabilities(SESSION_MENU.map(bind), sessionMenuCapabilities(rec));
}

// ─── 模态菜单面板 ────────────────────────────────────────────

interface SessionMenuPanelProps {
  record: SessionRecord;
  onClose: () => void;
  onNotify?: (msg: string) => void;
  onRefresh?: () => void;
  onCommand?: (cmd: string, args: string[]) => void;
  /** 菜单开/关上报（app 层 gated 用） */
  onMenuChange?: (open: boolean) => void;
  enabled?: boolean;
}

interface DialogState {
  title: string;
  items: SelectItem[];
  onPick: (value: string) => void;
}

export function SessionMenuPanel({
  record,
  onClose,
  onNotify,
  onRefresh,
  onCommand,
  onMenuChange,
  enabled = true,
}: SessionMenuPanelProps) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [confirm, setConfirm] = useState<{ message: string; onConfirm: () => void } | null>(null);

  // 最新回调引用（菜单 action 在首帧闭包中捕获；经 ref 取最新，避免过期 prop）
  const cb = useRef({ onNotify, onRefresh, onCommand, onClose });
  cb.current = { onNotify, onRefresh, onCommand, onClose };
  const menuChangeRef = useRef(onMenuChange);
  menuChangeRef.current = onMenuChange;

  useEffect(() => {
    menuChangeRef.current?.(true);
    return () => menuChangeRef.current?.(false);
  }, []);

  const runOp = (op: string, id: string, extra: Record<string, string> = {}) => {
    const args = [op, id, ...Object.entries(extra).flatMap(([k, v]) => [`--${k}`, v])];
    cb.current.onCommand?.("session", args);
    cb.current.onRefresh?.();
    cb.current.onClose();
  };

  const handlers: SessionMenuHandlers = {
    run: runOp,
    attach: (rec) => {
      const full = sessionTmuxName(rec);
      if (!full) { cb.current.onNotify?.("会话未在运行（tmux 无匹配）"); return; }
      if (process.env.TMUX) {
        spawnSync("tmux", ["switch-client", "-t", `=${full}`]);
        cb.current.onClose();
      } else {
        runOp("attach", bareTmuxName(full));
      }
    },
    pickTemplate: (op, id) => {
      const tpls = listTemplates(loadConfig());
      if (tpls.length === 0) { cb.current.onNotify?.("无模板 — ptl template new <alias> 创建"); cb.current.onClose(); return; }
      setDialog({
        title: `选择目标模板 — ${op}`,
        items: tpls.map((t) => ({
          label: `${t.isDefault ? "★ " : "  "}${t.alias}`,
          value: t.id,
          hint: t.config.model ?? "",
        })),
        onPick: (tplId) => runOp(op, id, { template: tplId }),
      });
    },
    pickNode: (id) => {
      const cfg = loadConfig();
      const file = scanSessionFiles(cfg).find((x) => x.id === id)?.file;
      if (!file) { cb.current.onNotify?.("无法读取会话节点文件"); cb.current.onClose(); return; }
      const nodes = listNodes(file);
      if (nodes.length === 0) { cb.current.onNotify?.("会话无可分支节点"); cb.current.onClose(); return; }
      setDialog({
        title: `分支节点 — ${id.slice(0, 8)}…`,
        items: nodes.map((n) => ({ label: n.summary, value: n.id })),
        onPick: (nodeId) => runOp("branch", id, { at: nodeId }),
      });
    },
    confirmStop: (rec) => {
      const full = sessionTmuxName(rec);
      setConfirm({
        message: `确认停止会话 ${rec.id.slice(0, 8)}…？`,
        onConfirm: () => {
          setConfirm(null);
          runOp("stop", full ? bareTmuxName(full) : rec.id);
        },
      });
    },
  };

  const [menu, setMenu] = useState<MenuState>(() => createMenu(buildSessionMenu(record, handlers)));

  useInput((input, key) => {
    if (!enabled) return;
    if (dialog || confirm) return; // SelectList / ConfirmDialog 自处理输入
    const { state, fired } = menuStep(menu, input);
    if (fired) {
      setMenu(createMenu([]));
      fired();
      return;
    }
    if (state !== menu) setMenu(state);
    if (key.escape) cb.current.onClose();
  });

  if (confirm) {
    return (
      <Box flexDirection="column" gap={1} marginTop={1}>
        <ConfirmDialog
          message={confirm.message}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      </Box>
    );
  }

  if (dialog) {
    return (
      <Box flexDirection="column" gap={1} marginTop={1}>
        <SelectList
          title={dialog.title}
          items={dialog.items}
          onSelect={(v) => { setDialog(null); dialog.onPick(v); }}
          onCancel={() => setDialog(null)}
        />
      </Box>
    );
  }

  const crumbs = menuBreadcrumb(menu);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text bold>会话操作 · {record.workloop} {record.id.slice(0, 8)}…</Text>
      {crumbs ? <Text dimColor>{crumbs}</Text> : null}
      {menu.current.map((n) => (
        <Box key={n.key}>
          <Text color="cyan" bold>[{n.key}]</Text>
          <Text> {n.label}</Text>
          {n.dangerous ? <Text color="yellow"> ⚠危险</Text> : null}
        </Box>
      ))}
      <Text dimColor>字母键选择 · Esc 关闭</Text>
    </Box>
  );
}
