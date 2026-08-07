import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export interface SelectItem {
  label: string;
  value: string;
  hint?: string;
}

interface SelectListProps {
  items: SelectItem[];
  onSelect: (value: string) => void;
  title?: string;
  onCancel?: () => void;
  enabled?: boolean;
}

export function SelectList({ items, onSelect, title, onCancel, enabled = true }: SelectListProps) {
  const [index, setIndex] = useState(0);
  const [filter, setFilter] = useState("");

  const filtered = filter
    ? items.filter(
        (it) =>
          it.label.toLowerCase().includes(filter.toLowerCase()) ||
          it.value.toLowerCase().includes(filter.toLowerCase()),
      )
    : items;

  useInput((input, key) => {
    if (!enabled) return;
    if (key.upArrow) {
      setIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setIndex((i) => Math.min(filtered.length - 1, i + 1));
      return;
    }
    if (key.return) {
      if (filtered[index]) onSelect(filtered[index].value);
      return;
    }
    if (key.escape) {
      if (onCancel) onCancel();
      else process.exit(130);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setFilter((f) => f + input);
      setIndex(0);
    }
    if (key.backspace) {
      setFilter((f) => f.slice(0, -1));
      setIndex(0);
    }
  });

  return (
    <Box flexDirection="column">
      {title ? (
        <Box marginBottom={1}>
          <Text bold>{title}</Text>
          {filter ? <Text dimColor> (filter: {filter})</Text> : null}
        </Box>
      ) : null}

      {filtered.length === 0 ? (
        <Text dimColor>  (no matches)</Text>
      ) : (
        filtered.map((item, i) => (
          <Box key={item.value}>
            <Text color={i === index ? "cyan" : undefined} bold={i === index}>
              {i === index ? "❯ " : "  "}
              {item.label}
            </Text>
            {item.hint ? <Text dimColor>  {item.hint}</Text> : null}
          </Box>
        ))
      )}

      <Box marginTop={1}>
        <Text dimColor>↑↓ select · Enter confirm · Esc cancel · type to filter</Text>
      </Box>
    </Box>
  );
}
