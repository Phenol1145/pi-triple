/**
 * PTL Operator Console — 壳 + Overview 只读 N30 同源代理消费。
 *
 * 安全约定：只使用 textContent / DOM createElement 渲染任何运行时值；
 * 绝不使用 innerHTML。URL fragment 中的一次性 bootstrap token 在兑换后立即清除。
 * Overview 只通过同源 /observe/* 消费 N30 观测面；浏览器不接触 N30 凭据/端点。
 */

const PAGES = ["overview", "work", "debug", "memory", "config"];
const N30_EMBED_URL = "/observe/?embed=1&base=/observe";

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

function initOverview() {
  const root = document.getElementById("page-overview");
  if (!root) return;

  const placeholder = root.querySelector(".placeholder");
  if (placeholder) placeholder.remove();

  const status = createEl("div");
  status.id = "overview-degraded";
  status.className = "overview-banner";
  status.hidden = true;

  const statusText = createEl("span", "N30 不可用：只读观测数据源连接失败。");
  status.appendChild(statusText);

  const retry = createEl("button", "重试");
  retry.id = "overview-retry";
  retry.type = "button";
  retry.className = "btn";
  status.appendChild(retry);

  const iframe = document.createElement("iframe");
  iframe.id = "overview-embed";
  iframe.className = "overview-embed";
  iframe.src = N30_EMBED_URL;
  iframe.title = "N30 运行观测台";
  iframe.loading = "lazy";

  const freshness = createEl("span");
  freshness.id = "overview-freshness";
  freshness.className = "overview-freshness";

  root.appendChild(status);
  root.appendChild(iframe);
  root.appendChild(freshness);

  retry.addEventListener("click", () => {
    iframe.src = N30_EMBED_URL;
    void refreshOverview(status, freshness, iframe);
  });

  void refreshOverview(status, freshness, iframe);
}

function formatSourceFreshness(snapshot) {
  if (!snapshot || typeof snapshot.collectedAt !== "number") return "数据时间 —";
  const time = new Date(snapshot.collectedAt).toLocaleTimeString();
  const sources = Array.isArray(snapshot.sources) ? snapshot.sources : [];
  if (sources.length === 0) return `数据时间 ${time}`;
  const fresh = sources.filter((s) => s && s.state === "fresh").length;
  return `数据时间 ${time} · ${fresh}/${sources.length} 来源 fresh`;
}

async function refreshOverview(status, freshness, iframe) {
  status.hidden = true;
  freshness.textContent = "连接 N30…";
  try {
    const res = await fetch("/observe/snapshot", {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const snapshot = await res.json();
    freshness.textContent = formatSourceFreshness(snapshot);
    status.hidden = true;
  } catch {
    status.hidden = false;
    freshness.textContent = "N30 不可用：只读观测数据源连接失败。";
    void iframe;
  }
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
  initOverview();
}

bootstrapFromFragment();
