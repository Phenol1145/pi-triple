import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

/**
 * CommandBar — 层级渐进式命令补全
 *
 * 命令组织为树：
 *   顶层输入只显示顶层命令（template ▸ 表示有子命令）
 *   输入完整一级 + 空格/Tab → 下钻到子命令层
 *   叶子命令 + 空格 → 参数补全（completions prop）
 */

interface CommandBarProps {
  visible: boolean;
  onSubmit: (cmd: string) => void;
  onCancel: () => void;
  /** "完整命令路径" → 参数候选，如 { "stop": [...], "template rm": [...] } */
  completions?: Record<string, string[]>;
  /** 可用宽度（终端列数），用于截断长描述 */
  width?: number;
  /** 自定义命令树（默认 pit 命令树） */
  commands?: CmdNode[];
}

interface CmdNode {
  name: string;
  desc: string;
  children?: CmdNode[];
}

export type { CmdNode };

const COMMAND_TREE: CmdNode[] = [
  { name: "pi", desc: "原生前台启动 pi（无 tmux，离开 TUI）" },
  { name: "start", desc: "后台 tmux 会话 <名称> [模板]" },
  { name: "attach", desc: "接入后台会话 <名称>" },
  { name: "switch", desc: "切换会话（tmux 内瞬移）<名称>" },
  { name: "detach", desc: "脱离当前会话（保持运行）" },
  { name: "stop", desc: "停止会话 <名称|--all>" },
  { name: "ls", desc: "列出后台会话" },
  { name: "status", desc: "健康检查" },
  {
    name: "template", desc: "模板管理 ▸",
    children: [
      { name: "ls", desc: "列出模板" },
      { name: "new", desc: "新建模板 <别名>" },
      { name: "rm", desc: "删除模板 <别名>" },
      { name: "rename", desc: "重命名 <旧别名> <新别名>" },
    ],
  },
  {
    name: "shared", desc: "共享层 ▸",
    children: [
      { name: "status", desc: "共享层状态" },
    ],
  },
  { name: "help", desc: "帮助" },
  {
    name: "hub", desc: "PTH 程序 ▸",
    children: [
      { name: "submit", desc: "提交程序 <目录>" },
      { name: "programs", desc: "列出 PTH 程序" },
      { name: "run", desc: "远端运行 <name> [k=v...]" },
      { name: "dev", desc: "本地调试 <目录>" },
    ],
  },
  {
    name: "tui", desc: "TUI 面板 ▸",
    children: [
      { name: "dashboard", desc: "系统总控面板" },
      { name: "lab", desc: "开发面板" },
    ],
  },
  { name: "quit", desc: "退出 pit tui" },
  { name: "exit", desc: "退出 pit tui（同 quit）" },
  {
    name: "flow", desc: "工作流管理 ▸",
    children: [
      { name: "run", desc: "启动 <flow.json> [k=v...]" },
      { name: "status", desc: "状态 <runId>" },
      { name: "show", desc: "完整输出 <runId>" },
      { name: "ls", desc: "列出全部" },
      { name: "approve", desc: "审批通过 <runId>" },
      { name: "reject", desc: "审批驳回 <runId>" },
      { name: "resume", desc: "继续暂停任务 <runId>" },
      { name: "edit", desc: "编辑图定义 <runId>" },
      { name: "set", desc: "修改图/状态" },
      { name: "graph", desc: "查看图 + 历史" },
      { name: "rm", desc: "删除 <runId>" },
      { name: "validate", desc: "校验定义" },
    ],
  },
];

const VISIBLE = 6;

/** 当前输入所处层级 */
interface Level {
  /** 待展示的条目（命令节点或参数） */
  items: { name: string; desc: string; hasChildren?: boolean }[];
  /** 已完成的路径词 */
  path: string[];
  /** 当前未完成的词 */
  partial: string;
}

function resolveLevel(input: string, completions: Record<string, string[]> | undefined, tree: CmdNode[]): Level {
  const endsWithSpace = input.endsWith(" ");
  const words = input.trim().split(/\s+/).filter(Boolean);

  let level: CmdNode[] = tree;
  const path: string[] = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const isLast = i === words.length - 1;
    const node = level.find((n) => n.name === word);

    if (node && (!isLast || endsWithSpace)) {
      // 完整匹配且后面还有词（或末尾空格）→ 下钻
      path.push(word);
      if (node.children) {
        level = node.children;
        if (isLast && endsWithSpace) {
          return { items: level.map((n) => ({ ...n, hasChildren: !!n.children })), path, partial: "" };
        }
      } else {
        // 叶子 → 参数模式
        level = [];
        if (isLast && endsWithSpace) {
          const args = completions?.[path.join(" ")] ?? [];
          return { items: args.map((a) => ({ name: a, desc: "" })), path, partial: "" };
        }
      }
    } else if (isLast) {
      // 未完成的词 → 过滤当前层
      if (level.length === 0 && path.length > 0) {
        // 参数模式：过滤参数候选
        if (endsWithSpace) return { items: [], path, partial: "" };
        const args = completions?.[path.join(" ")] ?? [];
        return {
          items: args.filter((a) => a.startsWith(word)).map((a) => ({ name: a, desc: "" })),
          path,
          partial: word,
        };
      }
      const filtered = level.filter((n) => n.name.startsWith(word));
      return {
        items: filtered.map((n) => ({ ...n, hasChildren: !!n.children })),
        path,
        partial: word,
      };
    } else {
      // 中间词无法匹配 → 无候选
      return { items: [], path, partial: word };
    }
  }

  // 空输入 → 顶层
  return {
    items: tree.map((n) => ({ ...n, hasChildren: !!n.children })),
    path,
    partial: "",
  };
}

export function CommandBar({ visible, onSubmit, onCancel, completions, width = 80, commands }: CommandBarProps) {
  const [input, setInput] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);

  const lvl = resolveLevel(input, completions, commands ?? COMMAND_TREE);
  const items = lvl.items;
  const selected = Math.min(selectedIdx, Math.max(0, items.length - 1));

  /** Tab：补全选中项并下钻（加空格） */
  function completeSelected() {
    const item = items[selected];
    if (!item) return;
    setInput([...lvl.path, item.name].join(" ") + " ");
    setSelectedIdx(0);
  }

  useInput((char, key) => {
    if (!visible) return;
    const maxIdx = Math.max(0, items.length - 1);

    if (key.tab) { completeSelected(); return; }
    if (key.escape) { onCancel(); setInput(""); setSelectedIdx(0); return; }

    if (key.return) {
      const trimmed = input.trim();
      if (trimmed.length > 0) {
        // 唯一匹配时自动补全：叶子直接提交，有子命令则下钻
        if (items.length === 1 && lvl.partial.length > 0) {
          const only = items[0];
          if (only.hasChildren) {
            setInput([...lvl.path, only.name].join(" ") + " ");
            setSelectedIdx(0);
            return;
          }
          onSubmit([...lvl.path, only.name].join(" "));
        } else {
          onSubmit(trimmed);
        }
        setInput("");
        setSelectedIdx(0);
      } else {
        // 空输入 Enter：有子命令下钻，否则提交选中命令
        const item = items[selected];
        if (item?.hasChildren) {
          completeSelected();
        } else if (item) {
          onSubmit([...lvl.path, item.name].join(" "));
          setInput("");
          setSelectedIdx(0);
        } else {
          onCancel();
        }
      }
      return;
    }

    if (key.upArrow) { setSelectedIdx((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setSelectedIdx((i) => Math.min(maxIdx, i + 1)); return; }
    if (key.pageDown) { setSelectedIdx((i) => Math.min(maxIdx, i + VISIBLE)); return; }
    if (key.pageUp) { setSelectedIdx((i) => Math.max(0, i - VISIBLE)); return; }

    if (key.backspace || key.delete) {
      setInput((s) => s.slice(0, -1));
      setSelectedIdx(0);
      return;
    }

    if (char && !key.ctrl && !key.meta) {
      setInput((s) => s + char);
      setSelectedIdx(0);
    }
  });

  if (!visible) return null;

  // 窗口化渲染
  let winStart = 0;
  if (items.length > VISIBLE) {
    winStart = Math.max(0, Math.min(selected - Math.floor(VISIBLE / 2), items.length - VISIBLE));
  }
  const winEnd = Math.min(winStart + VISIBLE, items.length);
  const slice = items.slice(winStart, winEnd);

  // 名称列宽：最长命令名 + 缩进，描述截断到剩余宽度
  const nameCol = Math.min(18, Math.max(...items.map((i) => i.name.length), 8) + 2);
  const descMax = Math.max(10, width - nameCol - 8);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={width}>
      {/* 输入行 */}
      <Box>
        <Text color="cyan">/ </Text>
        <Text>{input}</Text>
        <Text dimColor>█</Text>
      </Box>

      {/* 当前层级提示 */}
      {lvl.path.length > 0 && (
        <Box marginTop={1}>
          <Text dimColor>{lvl.path.join(" ▸ ")} ▸</Text>
        </Box>
      )}

      {/* 候选列表 */}
      {items.length > 0 && (
        <Box flexDirection="column" marginTop={lvl.path.length > 0 ? 0 : 1}>
          {winStart > 0 && <Text dimColor>    ↑ …{winStart} more</Text>}
          {slice.map((item, i) => {
            const realIdx = winStart + i;
            const isSel = realIdx === selected;
            const marker = isSel ? "❯ " : "  ";
            const namePadded = item.name.padEnd(nameCol);
            return (
              <Box key={`${realIdx}-${item.name}`}>
                <Text color={isSel ? "cyan" : undefined} bold={isSel}>
                  {"  "}{marker}{namePadded}
                </Text>
                {item.desc ? (
                  <Text dimColor wrap="truncate">{item.desc.length > descMax ? item.desc.slice(0, descMax - 1) + "…" : item.desc}</Text>
                ) : null}
              </Box>
            );
          })}
          {winEnd < items.length && <Text dimColor>    ↓ …{items.length - winEnd} more</Text>}
        </Box>
      )}

      {/* 帮助 */}
      <Box marginTop={1}>
        <Text dimColor>↑↓ select · Tab 下钻/补全 · Enter submit · Esc cancel</Text>
      </Box>
    </Box>
  );
}
