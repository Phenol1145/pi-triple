import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface CommandBarProps {
  visible: boolean;
  onSubmit: (cmd: string) => void;
  onCancel: () => void;
}

export function CommandBar({ visible, onSubmit, onCancel }: CommandBarProps) {
  const [input, setInput] = useState("");

  useInput((char, key) => {
    if (!visible) return;
    if (key.escape) { onCancel(); setInput(""); return; }
    if (key.return) {
      const trimmed = input.trim();
      if (trimmed.length > 0) onSubmit(trimmed);
      else onCancel();
      setInput("");
      return;
    }
    if (key.backspace || key.delete) { setInput((s) => s.slice(0, -1)); return; }
    if (char && !key.ctrl && !key.meta && !key.tab && !key.shift) {
      setInput((s) => s + char);
    }
  });

  if (!visible) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        <Text color="cyan">/ </Text>
        <Text>{input}</Text>
        <Text dimColor>█</Text>
      </Box>
      <Text dimColor> Esc 取消 · Enter 执行</Text>
    </Box>
  );
}
