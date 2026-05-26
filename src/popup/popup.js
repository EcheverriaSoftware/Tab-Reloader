import {
  DEFAULT_INTERVAL_MINUTES,
  clampInterval,
} from "../common/constants.js";

const $ = (sel) => document.querySelector(sel);

// --- messaging -------------------------------------------------------------

function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra });
}

let state = null;
let tickTimer = null;

// --- formatting ------------------------------------------------------------

function formatCountdown(ms) {
  if (ms <= 0) return "due now";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m <= 0) return `in ${s}s`;
  return `in ${m}m ${String(s).padStart(2, "0")}s`;
}

function intervalLabel(item) {
  return item.isOverride
    ? `every ${item.effectiveInterval}m`
    : `every ${item.effectiveInterval}m (default)`;
}

function statusText(item) {
  if (item.paused) return `Paused · ${intervalLabel(item)}`;
  const next = item.nextFireAt
    ? `Next ${formatCountdown(item.nextFireAt - Date.now())}`
    : "Scheduled";
  return `${next} · ${intervalLabel(item)}`;
}

// --- rendering -------------------------------------------------------------

function renderCurrent() {
  const cur = state.current;
  const card = $("#currentCard");
  if (!cur) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $("#currentTitle").textContent = cur.title;
  $("#currentUrl").textContent = cur.url;
  const fav = $("#currentFavicon");
  fav.src = cur.favIconUrl || "";
  fav.style.visibility = cur.favIconUrl ? "visible" : "hidden";

  const toggle = $("#currentToggle");
  toggle.checked = cur.isReloading;

  const intervalInput = $("#currentInterval");
  const useDefaultBtn = $("#useDefaultBtn");
  if (cur.isReloading) {
    const item = state.items.find((i) => i.tabId === cur.tabId);
    intervalInput.value = item ? item.effectiveInterval : state.defaultInterval;
    useDefaultBtn.hidden = !(item && item.isOverride);
  } else {
    intervalInput.value = state.defaultInterval;
    useDefaultBtn.hidden = true;
  }
  $("#currentHint").textContent = "";
  $("#currentHint").classList.remove("hint--warn");
}

function renderList() {
  const list = $("#list");
  const tpl = $("#rowTemplate");
  list.textContent = "";

  for (const item of state.items) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.classList.toggle("is-current", item.isCurrent);
    node.classList.toggle("is-paused", item.paused);
    node.dataset.tabId = String(item.tabId);

    const fav = node.querySelector(".favicon");
    fav.src = item.favIconUrl || "";
    fav.style.visibility = item.favIconUrl ? "visible" : "hidden";

    node.querySelector(".row__title").textContent = item.title;
    const status = node.querySelector(".row__status");
    status.textContent = statusText(item);

    const intervalInput = node.querySelector(".row__interval");
    intervalInput.value = item.effectiveInterval;

    const pauseBtn = node.querySelector(".row__pause");
    pauseBtn.textContent = item.paused ? "▶" : "⏸";
    pauseBtn.title = item.paused ? "Resume" : "Pause";

    list.appendChild(node);
  }

  $("#count").textContent = String(state.items.length);
  $("#empty").hidden = state.items.length > 0;
  const pauseAllBtn = $("#pauseAllBtn");
  pauseAllBtn.hidden = state.items.length === 0;
  pauseAllBtn.textContent = state.allPaused ? "Resume all" : "Pause all";
}

function render() {
  renderCurrent();
  renderList();
}

// Tick only updates countdown text, cheap and runs only while popup is open.
function tick() {
  if (!state) return;
  const rows = document.querySelectorAll("#list .row");
  for (const row of rows) {
    const tabId = Number(row.dataset.tabId);
    const item = state.items.find((i) => i.tabId === tabId);
    if (item) row.querySelector(".row__status").textContent = statusText(item);
  }
}

async function refresh() {
  state = await send("getState");
  render();
}

// --- events ----------------------------------------------------------------

$("#optionsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());

$("#currentToggle").addEventListener("change", async (e) => {
  const cur = state.current;
  if (!cur) return;
  if (e.target.checked) {
    const { value } = clampInterval($("#currentInterval").value, state.defaultInterval);
    const override = value === state.defaultInterval ? null : value;
    await send("addTab", { tabId: cur.tabId, overrideMinutes: override });
  } else {
    await send("removeTab", { tabId: cur.tabId });
  }
  await refresh();
});

$("#currentInterval").addEventListener("change", async (e) => {
  const cur = state.current;
  if (!cur || !cur.isReloading) return; // value is only applied on toggle-on
  const res = await send("setTabInterval", { tabId: cur.tabId, minutes: e.target.value });
  if (res?.clamped) {
    const hint = $("#currentHint");
    hint.textContent = `Adjusted to ${res.value} min (allowed range 1–1440).`;
    hint.classList.add("hint--warn");
  }
  await refresh();
});

$("#useDefaultBtn").addEventListener("click", async () => {
  const cur = state.current;
  if (!cur) return;
  await send("setTabInterval", { tabId: cur.tabId, useDefault: true });
  await refresh();
});

$("#pauseAllBtn").addEventListener("click", async () => {
  await send(state.allPaused ? "resumeAll" : "pauseAll");
  await refresh();
});

// Delegated handlers for the dynamic list.
$("#list").addEventListener("click", async (e) => {
  const row = e.target.closest(".row");
  if (!row) return;
  const tabId = Number(row.dataset.tabId);
  const item = state.items.find((i) => i.tabId === tabId);
  if (e.target.closest(".row__remove")) {
    await send("removeTab", { tabId });
  } else if (e.target.closest(".row__pause")) {
    await send(item?.paused ? "resumeTab" : "pauseTab", { tabId });
  } else if (e.target.closest(".row__reload")) {
    await send("reloadNow", { tabId });
  } else {
    return;
  }
  await refresh();
});

$("#list").addEventListener("change", async (e) => {
  if (!e.target.classList.contains("row__interval")) return;
  const row = e.target.closest(".row");
  const tabId = Number(row.dataset.tabId);
  await send("setTabInterval", { tabId, minutes: e.target.value });
  await refresh();
});

// --- init ------------------------------------------------------------------

async function showShortcut() {
  try {
    const cmds = await chrome.commands.getAll();
    const cmd = cmds.find((c) => c.name === "toggle-current-tab");
    const el = $("#shortcutHint");
    if (cmd && cmd.shortcut) el.textContent = cmd.shortcut;
    else el.textContent = "(unset — set it in chrome://extensions/shortcuts)";
  } catch {
    /* commands may be unavailable in some Chromium forks */
  }
}

async function init() {
  // Show the configured min/max in placeholders for clarity.
  $("#currentInterval").placeholder = String(DEFAULT_INTERVAL_MINUTES);
  await Promise.all([refresh(), showShortcut()]);
  tickTimer = setInterval(tick, 1000);
}

window.addEventListener("unload", () => clearInterval(tickTimer));

init();
