/**
 * PTL Operator Console — 壳与占位（页面逻辑在后续 Task 实现）。
 *
 * 安全约定：只使用 textContent / DOM createElement 渲染任何运行时值；
 * 绝不使用 innerHTML。URL fragment 中的一次性 bootstrap token 在兑换后立即清除。
 */

const PAGES = ["overview", "work", "debug", "memory", "config"];

const state = {
  csrfToken: null,
  operatorPrincipalId: null,
};

function createEl(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function setSessionState(text) {
  const node = document.getElementById("session-state");
  if (!node) return;
  node.textContent = text;
}

function switchPage(pageId) {
  for (const id of PAGES) {
    const root = document.querySelector(`[data-page-root="${id}"]`);
    if (root) root.hidden = id !== pageId;
    const nav = document.querySelector(`[data-page="${id}"]`);
    if (nav) nav.classList.toggle("active", id === pageId);
  }
}

function bindNav() {
  for (const button of document.querySelectorAll(".nav-item")) {
    button.addEventListener("click", () => {
      const pageId = button.getAttribute("data-page");
      if (pageId && PAGES.includes(pageId)) {
        history.replaceState(null, "", `/#/${pageId}`);
        switchPage(pageId);
      }
    });
  }
}

function renderBootstrapError(message) {
  setSessionState("未连接");
  const root = document.getElementById("page-overview");
  if (!root) return;
  const notice = createEl("p", message);
  notice.className = "placeholder";
  root.appendChild(notice);
}

async function bootstrapFromFragment() {
  bindNav();

  const match = /^#([0-9a-f]{64})$/.exec(window.location.hash);
  if (!match) {
    renderBootstrapError("缺少或无效的一次性 bootstrap token，请从 ptl operator 打印的链接重新打开。");
    return;
  }
  const token = match[1];

  let res;
  try {
    res = await fetch("/api/session/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  } catch (err) {
    renderBootstrapError(`bootstrap 请求失败：${String(err)}`);
    return;
  }

  if (!res.ok) {
    renderBootstrapError(`bootstrap 被拒绝（HTTP ${res.status}）：一次性 token 可能已使用或过期。`);
    return;
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    renderBootstrapError("bootstrap 响应不是有效 JSON。");
    return;
  }

  state.csrfToken = payload.csrfToken ?? null;
  state.operatorPrincipalId = payload.operatorPrincipalId ?? null;

  // 兑换成功后立即清除 URL fragment 中的一次性 token
  history.replaceState(null, "", "/#/overview");
  setSessionState(`已连接：${state.operatorPrincipalId}`);
  switchPage("overview");
}

bootstrapFromFragment();
