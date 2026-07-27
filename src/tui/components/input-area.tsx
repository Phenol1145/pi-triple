// src/tui/components/input-area.tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";

interface InputAreaProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  focused?: boolean;
  placeholder?: string;
}

export function InputArea({
  onSubmit,
  disabled = false,
  focused = true,
  placeholder,
}: InputAreaProps) {
  const [lines, setLines] = useState<string[]>([""]);
  const [cursorLine, setCursorLine] = useState(0);
  const [cursorCol, setCursorCol] = useState(0);

  const currentText = lines.join("\n");

  useInput(
    (input, key) => {
      if (disabled) return;

      // Enter (no modifiers) → submit
      if (key.return && !key.meta && !key.ctrl) {
        const text = currentText.trim();
        if (text) {
          onSubmit(text);
          setLines([""]);
          setCursorLine(0);
          setCursorCol(0);
        }
        return;
      }

      // Alt+Enter → newline (Ink delivers input="\n" with key.meta)
      // Ctrl+J → Ink also delivers input="\n" without meta (not ctrl+j key combo)
      if ((key.return && key.meta) || input === "\n") {
        const line = lines[cursorLine];
        const before = line.slice(0, cursorCol);
        const after = line.slice(cursorCol);
        const newLines = [...lines];
        newLines[cursorLine] = before;
        newLines.splice(cursorLine + 1, 0, after);
        setLines(newLines);
        setCursorLine(cursorLine + 1);
        setCursorCol(0);
        return;
      }

      // Backspace
      if (key.backspace || key.delete) {
        const newLines = [...lines];
        const line = newLines[cursorLine];
        if (cursorCol > 0) {
          newLines[cursorLine] = line.slice(0, cursorCol - 1) + line.slice(cursorCol);
          setCursorCol(cursorCol - 1);
        } else if (cursorLine > 0) {
          // Merge with previous line
          const prevLine = newLines[cursorLine - 1];
          newLines[cursorLine - 1] = prevLine + line;
          newLines.splice(cursorLine, 1);
          setCursorLine(cursorLine - 1);
          setCursorCol(prevLine.length);
        }
        setLines(newLines);
        return;
      }

      // Up/Down arrows for multi-line navigation
      if (key.upArrow && cursorLine > 0) {
        setCursorLine(cursorLine - 1);
        setCursorCol(lines[cursorLine - 1].length);
        return;
      }
      if (key.downArrow && cursorLine < lines.length - 1) {
        setCursorLine(cursorLine + 1);
        setCursorCol(lines[cursorLine + 1].length);
        return;
      }

      // Multi-line paste: insert at cursor position, not replace
      if (input.includes("\n") || input.includes("\r")) {
        const pastedLines = input.split(/\r?\n/);
        const line = lines[cursorLine];
        const before = line.slice(0, cursorCol);
        const after = line.slice(cursorCol);
        const newLines = [...lines];
        // First pasted line prepended with before
        pastedLines[0] = before + pastedLines[0];
        // Last pasted line appended with after
        const lastIdx = pastedLines.length - 1;
        pastedLines[lastIdx] = pastedLines[lastIdx] + after;
        newLines.splice(cursorLine, 1, ...pastedLines);
        setLines(newLines);
        setCursorLine(cursorLine + lastIdx);
        setCursorCol(pastedLines[lastIdx].length - after.length);
        return;
      }

      // Regular character input — insert at cursor position
      if (input && !key.ctrl && !key.meta) {
        const newLines = [...lines];
        const line = newLines[cursorLine];
        newLines[cursorLine] = line.slice(0, cursorCol) + input + line.slice(cursorCol);
        setLines(newLines);
        setCursorCol(cursorCol + input.length);
      }
    },
    { isActive: focused },
  );

  const promptIcon = theme.icons.prompt;
  const displayLines =
    lines.length === 1 && !lines[0] ? [placeholder ?? ""] : lines;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? theme.colors.primary : theme.colors.border}
    >
      {displayLines.map((line, i) => {
        const isCurrentLine = i === cursorLine && focused && !disabled;
        if (isCurrentLine) {
          // Show cursor by splitting at cursorCol
          const beforeCursor = line.slice(0, cursorCol);
          const cursorChar = line[cursorCol] || " ";
          const afterCursor = line.slice(cursorCol + 1);
          return (
            <Box key={i}>
              <Text color={theme.colors.primary}>
                {i === 0 ? `${promptIcon} ` : "  "}
              </Text>
              <Text>{beforeCursor}</Text>
              <Text inverse>{cursorChar}</Text>
              <Text>{afterCursor}</Text>
            </Box>
          );
        }
        return (
          <Box key={i}>
            <Text color={theme.colors.primary} dimColor={!focused}>
              {i === 0 ? `${promptIcon} ` : "  "}
            </Text>
            <Text dimColor={!focused}>{line || " "}</Text>
          </Box>
        );
      })}
      {lines.length > 1 && focused && (
        <Text dimColor>
          {"  "}Ln {cursorLine + 1}/{lines.length} (Alt+Enter: newline, Enter:
          send)
        </Text>
      )}
    </Box>
  );
}
