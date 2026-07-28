import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface CommandBarProps {
  visible: boolean;
  onSubmit: (cmd: string) => void;
  onCancel: () => void;
}

const COMMANDS = [
  { name: "pi", desc: "启动前台 pi 会话" },
  { name: "start", desc: "启动后台会话" },
  { name: "attach", desc: "接入后台会话" },
  { name: "stop", desc: "停止会话" },
  { name: "ls", desc: "列出后台会话" },
  { name: "status", desc: "健康检查" },
  { name: "tenant ls", desc: "列出租户" },
  { name: "tenant new", desc: "新建租户" },
  { name: "tenant rm", desc: "删除租户" },
  { name: "shared status", desc: "共享层状态" },
  { name: "help", desc: "帮助" },
];

export function CommandBar({ visible, onSubmit, onCancel }: CommandBarProps) {
  const [input, setInput] = useState("");

  const trimmed = input.trim();
  const filtered = trimmed.length === 0
    ? COMMANDS
    : COMMANDS.filter((c) => c.name.startsWith(trimmed) || c.name.includes(trimmed));
  const [selectedTab, setSelectedTab] = useState(0);

  // Reset selection when filter changes
  const selected = Math.min(selectedTab, Math.max(0, filtered.length - 1));

  useInput((char, key) => {
    if (!visible) return;

    // Tab key: autocomplete to selected command
    if (key.tab) {
      if (filtered.length > 0) {
        setInput(filtered[selected].name + " ");
        setSelectedTab(0);
      }
      return;
    }

    // Esc: cancel
    if (key.escape) { onCancel(); setInput(""); return; }

    // Enter: submit
    if (key.return) {
      const cmd = trimmed.length > 0 ? trimmed : (filtered[selected]?.name ?? "");
      if (cmd.length > 0) {
        onSubmit(cmd);
        setInput("");
        setSelectedTab(0);
      } else {
        onCancel();
      }
      return;
    }

    // Up/down: navigate filtered commands
    if (key.upArrow) {
      setSelectedTab((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedTab((i) => Math.min(filtered.length - 1, i + 1));
      return;
    }

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

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {/* Input line */}
      <Box>
        <Text color="cyan">/ </Text>
        <Text>{input}</Text>
        <Text dimColor>█</Text>
      </Box>

      {/* Command list */}
      {filtered.length > 0 && (() => {
        const VISIBLE = 6;
        let winStart = 0;
        if (filtered.length > VISIBLE) {
          // keep selected in view, prefer earlier items
          winStart = Math.max(0, Math.min(selected - Math.floor(VISIBLE / 2), filtered.length - VISIBLE));
        }
        const winEnd = Math.min(winStart + VISIBLE, filtered.length);
        const hasAbove = winStart > 0;
        const hasBelow = winEnd < filtered.length;

        return (
        <Box flexDirection="column" marginTop={1}>
          {hasAbove && <Text dimColor>    ↑ …{winStart} more</Text>}
          {filtered.slice(winStart, winEnd).map((cmd, i) => {
            const realIdx = winStart + i;
            return (
              <Box key={cmd.name}>
                <Text color={realIdx === selected ? "cyan" : undefined} bold={realIdx === selected}>
                  {realIdx === selected ? "  ❯ " : "    "}
                  {cmd.name}
                </Text>
                <Text dimColor>  —  {cmd.desc}</Text>
              </Box>
            );
          })}
          {hasBelow && <Text dimColor>    ↓ …{filtered.length - winEnd} more</Text>}
        </Box>
        );
      })()}

      {/* Help */}
      <Box marginTop={1}>
        <Text dimColor>↑↓ select · Tab autocomplete · Enter submit · Esc cancel</Text>
      </Box>
    </Box>
  );
}
