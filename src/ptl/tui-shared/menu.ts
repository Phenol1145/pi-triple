// src/ptl/tui-shared/menu.ts

export interface MenuNode {
  key: string;
  label: string;
  capability?: string;      // capabilities 匹配名（叶子 action 需声明；无则始终保留）
  action?: () => void;
  children?: MenuNode[];
  dangerous?: boolean;
}

export interface MenuState {
  path: MenuNode[];
  current: MenuNode[];
}

export function createMenu(root: MenuNode[]): MenuState {
  return { path: [], current: root };
}

export function menuStep(state: MenuState, key: string): { state: MenuState; fired?: () => void } {
  const node = state.current.find((n) => n.key === key);
  if (!node) return { state }; // 未知键忽略
  if (node.children && node.children.length > 0) {
    return { state: { path: [...state.path, node], current: node.children } };
  }
  if (node.action) {
    return { state, fired: node.action };
  }
  return { state };
}

export function menuBreadcrumb(state: MenuState): string {
  if (state.path.length === 0) return "";
  return ["nav", ...state.path.map((n) => n.label)].join(" › ");
}

/** 按 capabilities 过滤：action 叶子需 capabilities 含其 capability（未声明则保留）；无 children 且无 action（纯视图）保留 */
export function filterMenuByCapabilities(root: MenuNode[], capabilities: string[]): MenuNode[] {
  return root
    .filter((n) => {
      if (n.children && n.children.length > 0) {
        return filterMenuByCapabilities(n.children, capabilities).length > 0;
      }
      if (!n.action) return true; // 纯视图（details 等）始终保留
      return !n.capability || capabilities.includes(n.capability);
    })
    .map((n) => (n.children ? { ...n, children: filterMenuByCapabilities(n.children, capabilities) } : n));
}
