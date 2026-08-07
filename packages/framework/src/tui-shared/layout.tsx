import React from "react";
import { Box } from "ink";
import { TopBar } from "./top-bar.js";
import { TabBar } from "./tab-bar.js";
import { StatusBar } from "./status-bar.js";
import { useTerminalSize } from "./hooks.js";

/**
 * Screen — 统一 TUI 布局模板
 *
 * ┌──────────────────────────────┐
 * │ Head   (TopBar + TabBar)     │  ← 固定顶部
 * ├──────────────────────────────┤
 * │                              │
 * │ Content (children)           │  ← 填充剩余空间
 * │                              │
 * ├──────────────────────────────┤
 * │ Tips   (StatusBar)           │  ← 固定底部
 * └──────────────────────────────┘
 *
 * 所有 TUI app 都应该用这个组件保证布局一致。
 */
interface ScreenProps {
  /** 标题（TopBar 左侧） */
  title: string;
  /** 版本号（可选） */
  version?: string;
  /** 状态文本（TopBar 右侧，如 "template: local | DB: connected"） */
  status?: string;
  /** Tab 列表（可选，不传则无 TabBar） */
  tabs?: readonly string[];
  /** 当前激活的 Tab */
  activeTab?: string;
  /** Tab 选择回调（键盘切换由 useTabs 处理，此回调用于未来鼠标支持） */
  onTabSelect?: (tab: string) => void;
  /** 底部提示文本，如 "[1-5] Tab  [r] Refresh  [q] Quit" */
  hints: string;
  /** 页面内容 */
  children: React.ReactNode;
}

export function Screen({
  title,
  version,
  status,
  tabs,
  activeTab,
  onTabSelect,
  hints,
  children,
}: ScreenProps) {
  const { rows } = useTerminalSize();

  return (
    <Box flexDirection="column" height={rows}>
      {/* Head */}
      <TopBar title={title} version={version} status={status} />
      {tabs && tabs.length > 0 && (
        <TabBar
          tabs={[...tabs]}
          activeTab={activeTab ?? tabs[0]}
          onSelect={onTabSelect ?? (() => {})}
        />
      )}

      {/* Content — 填充剩余空间，溢出裁剪 */}
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        {children}
      </Box>

      {/* Tips */}
      <StatusBar hints={hints} />
    </Box>
  );
}
