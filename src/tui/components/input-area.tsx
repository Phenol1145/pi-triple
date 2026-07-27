// src/tui/components/input-area.tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";

interface InputAreaProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function InputArea({ onSubmit, disabled = false, placeholder }: InputAreaProps) {
  const [lines, setLines] = useState<string[]>([""]);
  const [cursorLine, setCursorLine] = useState(0);

  const currentText = lines.join("\n");

  useInput((input, key) => {
    if (disabled) return;

    // Enter (no modifiers) → submit
    if (key.return && !key.meta && !key.ctrl) {
      const text = currentText.trim();
      if (text) {
        onSubmit(text);
        setLines([""]);
        setCursorLine(0);
      }
      return;
    }

    // Alt+Enter or Ctrl+J → newline
    if ((key.return && key.meta) || (key.ctrl && input === "j")) {
      const newLines = [...lines];
      newLines.splice(cursorLine + 1, 0, "");
      setLines(newLines);
      setCursorLine(cursorLine + 1);
      return;
    }

    // Backspace
    if (key.backspace || key.delete) {
      const newLines = [...lines];
      const line = newLines[cursorLine];
      if (line.length > 0) {
        newLines[cursorLine] = line.slice(0, -1);
      } else if (cursorLine > 0) {
        newLines.splice(cursorLine, 1);
        setCursorLine(cursorLine - 1);
      }
      setLines(newLines);
      return;
    }

    // Up/Down arrows for multi-line navigation
    if (key.upArrow && cursorLine > 0) {
      setCursorLine(cursorLine - 1);
      return;
    }
    if (key.downArrow && cursorLine < lines.length - 1) {
      setCursorLine(cursorLine + 1);
      return;
    }

    // Bracketed paste: input may contain newlines
    if (input.includes("\n") || input.includes("\r")) {
      const pastedLines = input.split(/\r?\n/);
      const newLines = [...lines];
      newLines.splice(cursorLine, 1, ...pastedLines);
      setLines(newLines);
      setCursorLine(cursorLine + pastedLines.length - 1);
      return;
    }

    // Regular character input
    if (input && !key.ctrl && !key.meta) {
      const newLines = [...lines];
      newLines[cursorLine] += input;
      setLines(newLines);
    }
  });

  const promptIcon = theme.icons.prompt;
  const displayLines = lines.length === 1 && !lines[0]
    ? [placeholder ?? ""]
    : lines;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.colors.border}>
      {displayLines.map((line, i) => (
        <Box key={i}>
          <Text color={theme.colors.primary}>
            {i === 0 ? `${promptIcon} ` : "  "}
          </Text>
          <Text inverse={i === cursorLine && !disabled}>
            {line || (i === cursorLine ? " " : "")}
          </Text>
        </Box>
      ))}
      {lines.length > 1 && (
        <Text dimColor>  Ln {cursorLine + 1}/{lines.length} (Alt+Enter: newline, Enter: send)</Text>
      )}
    </Box>
  );
}
