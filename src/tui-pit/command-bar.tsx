import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface CommandBarProps {
  visible: boolean;
  onSubmit: (cmd: string) => void;
  onCancel: () => void;
  /** 命令名 → 参数候选列表（用于参数补全） */
  completions?: Record<string, string[]>;
}

interface CmdItem {
  name: string;
  desc: string;
}

const COMMANDS: CmdItem[] = [
  { name: "pi", desc: "启动前台 pi 会话" },
  { name: "start", desc: "启动后台会话" },
  { name: "attach", desc: "接入后台会话" },
  { name: "stop", desc: "停止会话" },
  { name: "ls", desc: "列出后台会话" },
  { name: "status", desc: "健康检查" },
  { name: "tenant ls", desc: "列出租户" },
  { name: "tenant new", desc: "新建租户" },
  { name: "tenant rm", desc: "删除租户" },
  { name: "tenant rename", desc: "重命名租户别名" },
  { name: "shared status", desc: "共享层状态" },
  { name: "help", desc: "帮助" },
];

const VISIBLE = 6;

export function CommandBar({ visible, onSubmit, onCancel, completions }: CommandBarProps) {
  const [input, setInput] = useState("");

  const trimmed = input.trim();
  const parts = trimmed.split(/\s+/);
  const cmdName = parts[0] ?? "";

  // Parameter mode: user has typed a command name followed by space or a partial arg
  const isArgMode = (parts.length >= 2) || (parts.length === 1 && trimmed !== cmdName && input.endsWith(" "));
  const argPrefix = isArgMode ? (parts[parts.length - 1] ?? "") : "";

  // Resolve arg candidates
  const argCandidates: string[] = [];
  if (isArgMode && completions) {
    const keys = [cmdName];
    // also try multi-word command like "tenant rm"
    if (parts.length >= 2) {
      keys.push(`${cmdName} ${parts[1]}`);
    }
    for (const k of keys) {
      const cands = completions[k];
      if (cands && cands.length > 0) {
        for (const c of cands) {
          if (!argCandidates.includes(c)) argCandidates.push(c);
        }
        break; // first match wins
      }
    }
  }
  const filteredArgs = argPrefix.length > 0
    ? argCandidates.filter((c) => c.startsWith(argPrefix))
    : argCandidates;

  // Command-mode: 逐层披露 — 空输入不展示，输入后才过滤
  const filteredCmds = trimmed.length === 0
    ? []
    : COMMANDS.filter((c) => c.name.startsWith(trimmed) || c.name.includes(trimmed));

  const [selectedTab, setSelectedTab] = useState(0);

  // Determine which list is active
  const activeList = isArgMode && filteredArgs.length > 0 ? filteredArgs : filteredCmds;
  const isArgList = isArgMode && filteredArgs.length > 0;
  const selected = Math.min(selectedTab, Math.max(0, activeList.length - 1));

  useInput((char, key) => {
    if (!visible) return;

    const maxIdx = Math.max(0, activeList.length - 1);

    // Tab key: autocomplete selected item
    if (key.tab) {
      if (isArgList && filteredArgs.length > 0) {
        // Insert selected arg value + space
        const prefix = trimmed.slice(0, -argPrefix.length);
        setInput(prefix + filteredArgs[selected] + " ");
        setSelectedTab(0);
      } else if (!isArgList && filteredCmds.length > 0 && typeof filteredCmds[0] === "object") {
        const cmd = (filteredCmds[selected] as CmdItem).name;
        setInput(cmd + " ");
        setSelectedTab(0);
      }
      return;
    }

    // Esc: cancel
    if (key.escape) { onCancel(); setInput(""); return; }

    // Enter: submit
    if (key.return) {
      const cmd = trimmed.length > 0 ? trimmed : (typeof activeList[selected] === "object" ? (activeList[selected] as CmdItem).name : String(activeList[selected]));
      if (cmd.length > 0) {
        onSubmit(cmd);
        setInput("");
        setSelectedTab(0);
      } else {
        onCancel();
      }
      return;
    }

    // Up/down: navigate list
    if (key.upArrow) { setSelectedTab((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setSelectedTab((i) => Math.min(maxIdx, i + 1)); return; }

    // PageUp/PageDown: faster scrolling
    if (key.pageDown) { setSelectedTab((i) => Math.min(maxIdx, i + VISIBLE)); return; }
    if (key.pageUp) { setSelectedTab((i) => Math.max(0, i - VISIBLE)); return; }

    // Backspace
    if (key.backspace || key.delete) {
      setInput((s) => s.slice(0, -1));
      setSelectedTab(0);
      return;
    }

    // Text input
    if (char && !key.ctrl && !key.meta) {
      setInput((s) => s + char);
      setSelectedTab(0);
    }
  });

  if (!visible) return null;

  // Render the active list with windowed scrolling
  function renderList<T>(items: T[], renderItem: (item: T, i: number) => React.ReactNode): React.ReactNode {
    if (items.length === 0) return null;

    let winStart = 0;
    if (items.length > VISIBLE) {
      winStart = Math.max(0, Math.min(selected - Math.floor(VISIBLE / 2), items.length - VISIBLE));
    }
    const winEnd = Math.min(winStart + VISIBLE, items.length);
    const hasAbove = winStart > 0;
    const hasBelow = winEnd < items.length;
    const slice = items.slice(winStart, winEnd);

    return (
      <Box flexDirection="column" marginTop={1}>
        {hasAbove && <Text dimColor>    ↑ …{winStart} more</Text>}
        {slice.map((item, i) => renderItem(item, winStart + i))}
        {hasBelow && <Text dimColor>    ↓ …{items.length - winEnd} more</Text>}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {/* Input line */}
      <Box>
        <Text color="cyan">/ </Text>
        <Text>{input}</Text>
        <Text dimColor>█</Text>
      </Box>

      {/* Argument completions */}
      {isArgList && argCandidates.length > 0 && (
        <>
          <Box marginTop={1}>
            <Text dimColor>{cmdName} 参数：</Text>
          </Box>
          {renderList<string>(argCandidates, (c, realIdx) => (
            <Box key={c}>
              <Text color={realIdx === selected ? "cyan" : undefined} bold={realIdx === selected}>
                {realIdx === selected ? "  ❯ " : "    "}
                {c}
              </Text>
            </Box>
          ))}
        </>
      )}

      {/* Command completions (only when not in arg mode or no args match) */}
      {!isArgList && (
        renderList<CmdItem>(filteredCmds, (cmd, realIdx) => (
          <Box key={cmd.name}>
            <Text color={realIdx === selected ? "cyan" : undefined} bold={realIdx === selected}>
              {realIdx === selected ? "  ❯ " : "    "}
              {cmd.name}
            </Text>
            <Text dimColor>  —  {cmd.desc}</Text>
          </Box>
        ))
      )}

      {/* Help */}
      <Box marginTop={1}>
        <Text dimColor>↑↓ select · PgUp/PgDn · Tab autocomplete · Enter submit · Esc cancel</Text>
      </Box>
    </Box>
  );
}
