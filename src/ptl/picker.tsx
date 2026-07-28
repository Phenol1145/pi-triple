/**
 * Pi-Triple 交互式选择器 — 缺参数时的极简 TUI 导引
 *
 * 用 Ink 渲染选择列表，支持 ↑↓ 选择、Enter 确认、输入过滤。
 */

import React, { useState } from "react";
import { Box, Text, useInput, render } from "ink";

// ─── Select 组件 ─────────────────────────────────────────────

interface SelectItem {
  label: string;
  value: string;
  hint?: string;
}

interface SelectProps {
  title: string;
  items: SelectItem[];
  onSelect: (value: string) => void;
  allowCustom?: boolean;
}

function Select({ title, items, onSelect, allowCustom = true }: SelectProps) {
  const [index, setIndex] = useState(0);
  const [filter, setFilter] = useState("");
  const [customInput, setCustomInput] = useState("");
  const [customMode, setCustomMode] = useState(false);

  const filtered = filter
    ? items.filter((i) => i.label.toLowerCase().includes(filter.toLowerCase()) || i.value.toLowerCase().includes(filter.toLowerCase()))
    : items;

  useInput((input, key) => {
    if (customMode) {
      if (key.return) {
        if (customInput.trim()) onSelect(customInput.trim());
        return;
      }
      if (key.escape) { setCustomMode(false); setCustomInput(""); return;
      }
      if (key.backspace) { setCustomInput((s) => s.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) { setCustomInput((s) => s + input); return; }
      return;
    }

    if (key.upArrow) { setIndex((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setIndex((i) => Math.min(filtered.length - 1, i + 1)); return; }
    if (key.return) {
      if (filtered[index]) onSelect(filtered[index].value);
      return;
    }
    if (key.escape || (key.ctrl && input === "c")) { process.exit(130); return; }
    // 输入过滤
    if (input && !key.ctrl && !key.meta && input !== " ") {
      setFilter((f) => f + input);
      setIndex(0);
    }
    if (key.backspace) { setFilter((f) => f.slice(0, -1)); setIndex(0); }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">? </Text>
        <Text bold>{title}</Text>
        {filter ? <Text dimColor> (filter: {filter})</Text> : null}
      </Box>

      {filtered.map((item, i) => (
        <Box key={item.value}>
          <Text color={i === index ? "cyan" : undefined} bold={i === index}>
            {i === index ? "  ❯ " : "    "}
          </Text>
          <Text color={i === index ? "cyan" : undefined} bold={i === index}>
            {item.label}
          </Text>
          {item.hint ? <Text dimColor>  {item.hint}</Text> : null}
        </Box>
      ))}

      {filtered.length === 0 && <Text dimColor>  (无匹配)</Text>}

      {allowCustom && (
        <Box marginTop={1}>
          <Text dimColor>  输入过滤 · ↑↓ 选择 · Enter 确认 · Esc 退出</Text>
        </Box>
      )}
    </Box>
  );
}

// ─── 交互式命令导引 ──────────────────────────────────────────

interface PickerOptions {
  tenants: Array<{ id: string; alias: string; isDefault: boolean }>;
  models?: string[];
}

export async function interactiveStart(options: PickerOptions): Promise<{
  tenant: string;
  name: string;
  model?: string;
  bg: boolean;
}> {
  return new Promise((resolve) => {
    const tenantItems: SelectItem[] = [
      ...options.tenants.map((t) => ({
        label: t.alias + (t.isDefault ? " (default)" : ""),
        value: t.id,
        hint: t.isDefault ? "★" : undefined,
      })),
    ];

    const modeItems: SelectItem[] = [
      { label: "接入", value: "fg", hint: "tmux 会话，立即接入（Ctrl+B d 脱离）" },
      { label: "后台", value: "bg", hint: "tmux 后台运行，pit attach 接入" },
    ];

    function Wizard() {
      const [step, setStep] = useState(0);
      const [tenant, setTenant] = useState("");

      if (step === 0) {
        return (
          <Select
            title="选择租户"
            items={tenantItems}
            onSelect={(v) => { setTenant(v); setStep(1); }}
          />
        );
      }
      return (
        <Select
          title="启动模式"
          items={modeItems}
          onSelect={(v) => {
            resolve({ tenant, name: `session-${Date.now().toString(36)}`, bg: v === "bg" });
            unmount();
          }}
        />
      );
    }

    const { unmount } = render(<Wizard />, { exitOnCtrlC: false });
  });
}

/** 简单的确认选择器 */
export async function interactiveSelect(title: string, items: SelectItem[]): Promise<string> {
  return new Promise((resolve) => {
    const { unmount } = render(
      <Select
        title={title}
        items={items}
        onSelect={(v) => { resolve(v); unmount(); }}
      />,
      { exitOnCtrlC: false },
    );
  });
}
