import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface CommandBarProps {
  visible: boolean;
  onSubmit: (cmd: string) => void;
  onCancel: () => void;
}

const COMMANDS = [
  { name: "start", desc: "启动后台会话" },
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

    // Tab key: autocomplete to first matching command
    if (key.tab) {
      if (filtered.length > 0) {
        setInput(filtered[0].name + " ");
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
    if (char && !key.ctrl && !key.meta && !key.shift) {
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
      {filtered.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {filtered.slice(0, 6).map((cmd, i) => (
            <Box key={cmd.name}>
              <Text color={i === selected ? "cyan" : undefined} bold={i === selected}>
                {i === selected ? "  ❯ " : "    "}
                {cmd.name}
              </Text>
              <Text dimColor>  —  {cmd.desc}</Text>
            </Box>
          ))}
          {filtered.length > 6 && (
            <Text dimColor>  …and {filtered.length - 6} more</Text>
          )}
        </Box>
      )}

      {/* Help */}
      <Box marginTop={1}>
        <Text dimColor>↑↓ select · Tab autocomplete · Enter submit · Esc cancel</Text>
      </Box>
    </Box>
  );
}
