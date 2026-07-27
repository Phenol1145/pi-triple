import React from "react";
import { Box, Text } from "ink";

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

interface SparkLineProps {
  data: number[];
  width?: number;
}

export function SparkLine({ data, width = 40 }: SparkLineProps) {
  if (data.length === 0) {
    return <Text dimColor>(no data)</Text>;
  }

  if (data.length === 1) {
    // Single point — show single bar
    return (
      <Box>
        <Text dimColor>│</Text>
        <Text color="cyan">█</Text>
        <Text dimColor>│</Text>
        <Text> {data[0].toFixed(1)}</Text>
      </Box>
    );
  }

  const hasNegative = data.some((d) => d < 0);
  const min = Math.min(...data);
  const max = Math.max(...data);

  if (hasNegative) {
    // Split at zero line
    const absMax = Math.max(Math.abs(min), Math.abs(max), 0.01);
    const chars: string[] = [];
    for (const val of data) {
      chars.push(normalizeChar(val, -absMax, absMax));
    }
    return (
      <Box>
        <Text dimColor>┤</Text>
        <Text color="cyan">{chars.join("")}</Text>
        <Text dimColor>├</Text>
        <Text> </Text>
        <Text dimColor>{min.toFixed(1)}</Text>
        <Text> </Text>
        <Text color="cyan">{max.toFixed(1)}</Text>
      </Box>
    );
  }

  // All non-negative
  const range = max - min || 0.01;
  const chars: string[] = [];
  for (const val of data) {
    chars.push(normalizeChar(val, min, max));
  }

  return (
    <Box>
      <Text dimColor>┤</Text>
      <Text color="cyan">{chars.join("").slice(0, width)}</Text>
      <Text dimColor>├</Text>
      <Text> </Text>
      <Text dimColor>{min.toFixed(1)}</Text>
      <Text> </Text>
      <Text color="cyan">{max.toFixed(1)}</Text>
    </Box>
  );
}

function normalizeChar(val: number, min: number, max: number): string {
  const range = max - min || 0.01;
  const pct = Math.max(0, Math.min(1, (val - min) / range));
  const idx = Math.round(pct * (SPARK_CHARS.length - 1));
  return SPARK_CHARS[idx] ?? "▁";
}
