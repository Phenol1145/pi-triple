export const KEYS = {
  ENTER: "return",
  NEWLINE: "j",        // Ctrl+J for newline (Alt+Enter also handled)
  TAB: "tab",
  CTRL_C: "c",
  CTRL_D: "d",
  CTRL_N: "n",
  CTRL_T: "t",         // toggle thinking
  CTRL_G: "g",         // toggle statusbar
  UP: "upArrow",
  DOWN: "downArrow",
} as const;

export function isCtrl(key: { ctrl: boolean }, _target: string): boolean {
  return key.ctrl;
}
