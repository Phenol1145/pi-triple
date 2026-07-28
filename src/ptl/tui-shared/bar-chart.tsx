import React from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";

interface BarChartProps {
  data: Array<{ label: string; value: number; color?: string }>;
  width?: number;
}

export function BarChart({ data, width = 40 }: BarChartProps) {
  if (data.length === 0) {
    return <Text dimColor>(no data)</Text>;
  }

  const maxLabel = Math.max(...data.map((d) => stringWidth(d.label)));
  const maxVal = Math.max(...data.map((d) => d.value), 0.01);
  const barArea = Math.max(10, width - maxLabel - 8);

  return (
    <Box flexDirection="column">
      {data.map((item, i) => {
        const barLen = Math.max(0, Math.round((item.value / maxVal) * barArea));
        const bar = "█".repeat(Math.min(barLen, barArea));
        const empty = "░".repeat(Math.max(0, barArea - barLen));
        const pct = ((item.value / maxVal) * 100).toFixed(1);

        return (
          <Box key={i}>
            <Text dimColor>{item.label.padEnd(maxLabel)}</Text>
            <Text> </Text>
            <Text dimColor>│</Text>
            <Text color={item.color ?? "cyan"}>{bar}</Text>
            <Text dimColor>{empty}</Text>
            <Text dimColor>│</Text>
            <Text> {pct}%</Text>
          </Box>
        );
      })}
    </Box>
  );
}
