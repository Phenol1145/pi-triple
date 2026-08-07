# TUI 模板规范

所有 Pi-Triple TUI 必须使用 `Screen` 布局模板，保证结构一致。

## 布局结构

```
┌──────────────────────────────┐
│ Head   = TopBar + TabBar     │  ← 固定顶部
├──────────────────────────────┤
│ Content = children           │  ← 填充剩余空间（溢出裁剪）
├──────────────────────────────┤
│ Tips   = StatusBar           │  ← 固定底部
└──────────────────────────────┘
```

## 用法

```tsx
import { Screen, useTabs, useTerminalSize } from "../tui-shared/index.js";

const TABS = ["Page1", "Page2"];

export function MyApp() {
  const { activeTab, tabIndex } = useTabs(TABS);

  return (
    <Screen
      title="My Tool"                    // Head 左：标题
      version="0.1.0"                    // Head 左：版本（可选）
      status="template: local | DB: ok"    // Head 右：状态（可选）
      tabs={TABS}                        // Head 下：Tab 栏（可选）
      activeTab={activeTab}
      hints="[1-2] Tab  [q] Quit"        // Tips：快捷键提示
    >
      {/* Content：当前 Tab 页面 */}
      {tabIndex === 0 && <Page1 />}
      {tabIndex === 1 && <Page2 />}
    </Screen>
  );
}
```

## 规则

1. **Head 只放** 标题/版本/状态/Tab——不放交互组件
2. **Content 只放** 当前激活页面——页面组件接收 `{ width, height, enabled }`
3. **Tips 只放** 一行快捷键提示——格式 `[key] action · [key] action`
4. 输入处理：`useTabs` 管 Tab 切换，页面自己管 `useInput`，弹层打开时传 `enabled={false}` 门控页面输入
5. 终端切换（attach 等）：先 `unmountInk()` → `stdin.pause()` → `spawnSync(stdio: "inherit")` → `process.exit(status)`

## 共享组件（tui-shared/）

| 组件 | 用途 |
|------|------|
| `Screen` | 布局模板（Head/Content/Tips） |
| `DataTable` | 表格 |
| `SelectList` | 列表选择 |
| `ConfirmDialog` | 确认框 |
| `SparkLine` / `BarChart` | 图表 |
| `useTabs` / `useRefresh` / `useTerminalSize` | 通用 hooks |
| `theme` | 配色常量 |
