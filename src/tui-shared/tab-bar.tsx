import React from "react";
import { Box, Text } from "ink";

interface TabBarProps {
  tabs: string[];
  activeTab: string;
  onSelect: (tab: string) => void;
}

export function TabBar({ tabs, activeTab }: TabBarProps) {
  return (
    <Box gap={1} marginY={1}>
      {tabs.map((tab, idx) => {
        const isActive = tab === activeTab;
        return (
          <Box key={tab}>
            <Text dimColor={!isActive} color={isActive ? "cyan" : undefined} bold={isActive}>
              {isActive ? "▎" : " "}
            </Text>
            <Text
              dimColor={idx > 8}
              color={isActive ? "cyan" : undefined}
              bold={isActive}
              underline={isActive}
            >
              {tab}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
