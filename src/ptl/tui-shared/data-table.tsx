import React from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";

export interface ColumnDef {
  key: string;
  label: string;
  width?: number;
  align?: "left" | "right";
}

export interface DataTableProps {
  columns: ColumnDef[];
  rows: Record<string, unknown>[];
  /** Optional color function per row key */
  rowColor?: (row: Record<string, unknown>) => string | undefined;
  /** Enable row selection highlight */
  selectable?: boolean;
  /** Currently selected row index (controlled) */
  selectedIndex?: number;
  /** Called when the selected row changes */
  onSelectionChange?: (i: number) => void;
}

function pad(str: string, width: number, align: "left" | "right"): string {
  const sw = stringWidth(str);
  const padLen = Math.max(0, width - sw);
  if (align === "right") return " ".repeat(padLen) + str;
  return str + " ".repeat(padLen);
}

function computeWidths(columns: ColumnDef[], rows: Record<string, unknown>[]): number[] {
  return columns.map((col) => {
    if (col.width) return col.width;
    let max = stringWidth(col.label);
    for (const row of rows) {
      const val = String(row[col.key] ?? "");
      max = Math.max(max, stringWidth(val));
    }
    return max + 2; // padding
  });
}

function truncate(str: string, width: number): string {
  if (stringWidth(str) <= width) return str;
  let result = "";
  let w = 0;
  for (const char of str) {
    const cw = stringWidth(char) || 1;
    if (w + cw > width - 1) return result + "…";
    result += char;
    w += cw;
  }
  return result;
}

export function DataTable({ columns, rows, rowColor, selectable, selectedIndex, onSelectionChange }: DataTableProps) {
  const widths = computeWidths(columns, rows);

  // 受控选择变化上报（Task 6 遗留：prop 此前从未触发）。挂载首帧不上报。
  const firstRender = React.useRef(true);
  React.useEffect(() => {
    if (!selectable || selectedIndex == null) return;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    onSelectionChange?.(selectedIndex);
  }, [selectable, selectedIndex, onSelectionChange]);

  return (
    <Box flexDirection="column">
      {/* Header row */}
      <Box gap={1}>
        {columns.map((col, i) => (
          <Box key={col.key} width={widths[i]}>
            <Text bold dimColor>
              {pad(col.label.toUpperCase(), widths[i], col.align ?? "left")}
            </Text>
          </Box>
        ))}
      </Box>
      {/* Separator */}
      <Text dimColor>
        {"─".repeat(widths.reduce((a, b) => a + b, 0) + columns.length - 1)}
      </Text>
      {/* Data rows */}
      {rows.map((row, rowIdx) => {
        const color = rowColor?.(row);
        const isSel = selectable && selectedIndex === rowIdx;
        const cellColor = isSel ? "cyan" : color;
        return (
          <Box key={rowIdx} gap={1}>
            {columns.map((col, i) => {
              const val = String(row[col.key] ?? "");
              return (
                <Box key={col.key} width={widths[i]}>
                  <Text color={cellColor} bold={isSel}>
                    {truncate(pad(val, widths[i], col.align ?? "left"), widths[i])}
                  </Text>
                </Box>
              );
            })}
          </Box>
        );
      })}
    </Box>
  );
}
