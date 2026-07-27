import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";
import { CommandPicker, filterCommands, type CommandInfo } from "./command-picker.js";

interface InputAreaProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  focused?: boolean;
  placeholder?: string;
  commands?: CommandInfo[];
}

export function InputArea({
  onSubmit,
  disabled = false,
  focused = true,
  placeholder,
  commands = [],
}: InputAreaProps) {
  const [lines, setLines] = useState<string[]>([""]);
  const [cursorLine, setCursorLine] = useState(0);
  const [cursorCol, setCursorCol] = useState(0);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerIndex, setPickerIndex] = useState(0);

  const currentText = lines.join("\n");
  const currentLine = lines[cursorLine] ?? "";

  // Determine picker filter from current input
  const pickerFilter = currentLine.startsWith("/") ? currentLine.slice(1) : "";
  const filteredCommands = showPicker ? filterCommands(commands, pickerFilter) : [];

  function updatePickerVisibility(newLine: string) {
    if (newLine.startsWith("/") && commands.length > 0) {
      setShowPicker(true);
      setPickerIndex(0);
    } else {
      setShowPicker(false);
    }
  }

  function completeCommand(cmd: CommandInfo) {
    const newLines = [...lines];
    newLines[cursorLine] = `/${cmd.name} `;
    setLines(newLines);
    setCursorCol(newLines[cursorLine].length);
    setShowPicker(false);
  }

  useInput(
    (input, key) => {
      if (disabled) return;

      // ── Picker mode ──
      if (showPicker && filteredCommands.length > 0) {
        if (key.upArrow) {
          setPickerIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setPickerIndex((i) => Math.min(filteredCommands.length - 1, i + 1));
          return;
        }
        if (key.return) {
          // Confirm selection — complete command but don't submit
          const cmd = filteredCommands[pickerIndex];
          if (cmd) completeCommand(cmd);
          return;
        }
        if (key.escape) {
          setShowPicker(false);
          return;
        }
        if (input === " ") {
          // Space: complete selected + space
          const cmd = filteredCommands[pickerIndex];
          if (cmd) completeCommand(cmd);
          return;
        }
        // Tab: also confirm
        if (key.tab) {
          const cmd = filteredCommands[pickerIndex];
          if (cmd) completeCommand(cmd);
          return;
        }
        // Fall through to normal input handling for typing more filter chars
      }

      // ── Normal mode ──

      // Enter → submit
      if (key.return && !key.meta && !key.ctrl) {
        const text = currentText.trim();
        if (text) {
          onSubmit(text);
          setLines([""]);
          setCursorLine(0);
          setCursorCol(0);
          setShowPicker(false);
        }
        return;
      }

      // Alt+Enter or bare \n → newline
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
        setShowPicker(false);
        return;
      }

      // Backspace
      if (key.backspace || key.delete) {
        const newLines = [...lines];
        const line = newLines[cursorLine];
        if (cursorCol > 0) {
          newLines[cursorLine] = line.slice(0, cursorCol - 1) + line.slice(cursorCol);
          setCursorCol(cursorCol - 1);
          updatePickerVisibility(newLines[cursorLine]);
        } else if (cursorLine > 0) {
          const prevLine = newLines[cursorLine - 1];
          newLines[cursorLine - 1] = prevLine + line;
          newLines.splice(cursorLine, 1);
          setCursorLine(cursorLine - 1);
          setCursorCol(prevLine.length);
          setShowPicker(false);
        }
        setLines(newLines);
        return;
      }

      // Up/Down arrows for multi-line navigation (only when picker is closed)
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

      // Multi-line paste
      if (input.includes("\n") || input.includes("\r")) {
        const pastedLines = input.split(/\r?\n/);
        const line = lines[cursorLine];
        const before = line.slice(0, cursorCol);
        const after = line.slice(cursorCol);
        const newLines = [...lines];
        pastedLines[0] = before + pastedLines[0];
        const lastIdx = pastedLines.length - 1;
        pastedLines[lastIdx] = pastedLines[lastIdx] + after;
        newLines.splice(cursorLine, 1, ...pastedLines);
        setLines(newLines);
        setCursorLine(cursorLine + lastIdx);
        setCursorCol(pastedLines[lastIdx].length - after.length);
        setShowPicker(false);
        return;
      }

      // Regular character input
      if (input && !key.ctrl && !key.meta) {
        const newLines = [...lines];
        const line = newLines[cursorLine];
        newLines[cursorLine] = line.slice(0, cursorCol) + input + line.slice(cursorCol);
        setLines(newLines);
        setCursorCol(cursorCol + input.length);
        updatePickerVisibility(newLines[cursorLine]);
      }
    },
    { isActive: focused },
  );

  const promptIcon = theme.icons.prompt;
  const displayLines =
    lines.length === 1 && !lines[0] ? [placeholder ?? ""] : lines;

  return (
    <Box flexDirection="column">
      {/* Command picker dropdown (above input) */}
      {showPicker && filteredCommands.length > 0 && (
        <CommandPicker
          commands={commands}
          filter={pickerFilter}
          selectedIndex={pickerIndex}
        />
      )}

      {/* Input box */}
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={focused ? theme.colors.primary : theme.colors.border}
      >
        {displayLines.map((line, i) => {
          const isCurrentLine = i === cursorLine && focused && !disabled;
          if (isCurrentLine) {
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
            {"  "}Ln {cursorLine + 1}/{lines.length} · Alt+Enter: newline · Enter: send
          </Text>
        )}
      </Box>
    </Box>
  );
}
