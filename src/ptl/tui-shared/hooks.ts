import React, { useState, useCallback, useEffect } from "react";
import { useInput, useStdout } from "ink";

export function useTabs(tabs: string[], enabled = true) {
  const [tabIndex, setTabIndex] = useState(0);
  const activeTab = tabs[tabIndex] ?? tabs[0];

  useInput((input, key) => {
    if (!enabled) return;
    if (key.ctrl) return;
    const digit = parseInt(input, 10);
    if (digit >= 1 && digit <= Math.min(tabs.length, 9)) {
      setTabIndex(digit - 1);
    }
  });

  const setActiveTab = useCallback(
    (name: string) => {
      const idx = tabs.indexOf(name);
      if (idx >= 0) setTabIndex(idx);
    },
    [tabs],
  );

  return { activeTab, setActiveTab, tabIndex };
}

export function useRefresh(intervalMs: number, callback: () => void) {
  useEffect(() => {
    const timer = setInterval(callback, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, callback]);
}

export function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({
    columns: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  }));

  useEffect(() => {
    const check = () => {
      const cols = stdout.columns ?? 80;
      const rows = stdout.rows ?? 24;
      setSize((prev) => (prev.columns !== cols || prev.rows !== rows ? { columns: cols, rows } : prev));
    };
    const timer = setInterval(check, 500);
    return () => clearInterval(timer);
  }, [stdout]);

  return size;
}
