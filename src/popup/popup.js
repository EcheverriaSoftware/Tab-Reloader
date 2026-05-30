import {
  DEFAULT_INTERVAL_MINUTES,
  clampInterval,
  eventScheduleText,
  formatTimeOfDay,
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

// ===========================================================================
// Events (current-tab control — docs/EVENTS_PRD.md §8.1)
// ===========================================================================

const DAY_LABELS = [
  { d: 0, short: "S", full: "Sunday" },
  { d: 1, short: "M", full: "Monday" },
  { d: 2, short: "T", full: "Tuesday" },
  { d: 3, short: "W", full: "Wednesday" },
  { d: 4, short: "T", full: "Thursday" },
  { d: 5, short: "F", full: "Friday" },
  { d: 6, short: "S", full: "Saturday" },
];

let eventsState = null;
let editingId = null; // null while adding a new event

// --- rendering ---

function renderEventList() {
  const list = $("#eventList");
  const tpl = $("#eventRowTemplate");
  list.textContent = "";
  for (const ev of eventsState.events) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = ev.id;
    node.classList.toggle("is-off", !ev.enabled);
    node.classList.toggle("is-missed", ev.missed);
    node.querySelector(".evrow__enabled").checked = ev.enabled;
    node.querySelector(".evrow__label").textContent = ev.label || formatTimeOfDay(ev.time);
    node.querySelector(".evrow__sub").textContent = eventScheduleText(ev);
    list.appendChild(node);
  }
  $("#eventEmpty").hidden = eventsState.events.length > 0;
}

function renderEvents() {
  const cur = eventsState?.current;
  const noTab = $("#eventNoTab");
  const reg = $("#eventReg");
  const panel = $("#eventPanel");
  const countBadge = $("#eventCount");

  if (!cur || !cur.url) {
    noTab.hidden = false;
    reg.hidden = true;
    panel.hidden = true;
    countBadge.hidden = true;
    return;
  }
  noTab.hidden = true;

  if (!cur.isEventTab) {
    reg.hidden = false;
    panel.hidden = true;
    countBadge.hidden = true;
    closeEventForm();
    return;
  }

  reg.hidden = true;
  panel.hidden = false;
  countBadge.hidden = false;
  countBadge.textContent = String(eventsState.events.length);
  renderEventList();
  $("#eventUnregConfirm").hidden = true;
  $("#eventUnregBtn").hidden = false;
}

async function refreshEvents() {
  eventsState = await send("getEventsState");
  renderEvents();
}

// --- add/edit form ---

function buildDayButtons() {
  const wrap = $("#evDays");
  wrap.textContent = "";
  for (const { d, short, full } of DAY_LABELS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "day";
    b.dataset.day = String(d);
    b.textContent = short;
    b.title = full;
    b.setAttribute("aria-pressed", "false");
    wrap.appendChild(b);
  }
}

function getFormDays() {
  return [...$("#evDays").querySelectorAll(".day")]
    .filter((b) => b.getAttribute("aria-pressed") === "true")
    .map((b) => Number(b.dataset.day));
}

function setFormDays(days) {
  const set = new Set(days);
  for (const b of $("#evDays").querySelectorAll(".day")) {
    b.setAttribute("aria-pressed", set.has(Number(b.dataset.day)) ? "true" : "false");
  }
}

/** Reflect the one-time checkbox: disable day/preset pickers when it's on. */
function syncOnceState() {
  const once = $("#evOnce").checked;
  $("#evDays").classList.toggle("is-disabled", once);
  for (const b of $("#evDays").querySelectorAll(".day")) b.disabled = once;
  for (const b of document.querySelectorAll(".evpresets .chip")) b.disabled = once;
}

function showFormMsg(text) {
  const m = $("#evFormMsg");
  m.textContent = text;
  m.hidden = false;
}
function hideFormMsg() {
  const m = $("#evFormMsg");
  m.hidden = true;
  m.textContent = "";
}

function openEventForm(ev) {
  editingId = ev?.id ?? null;
  $("#evTime").value = ev?.time ?? "";
  $("#evLabel").value = ev?.label ?? "";
  $("#evOnce").checked = ev ? ev.oneTime : false;
  setFormDays(ev && !ev.oneTime ? ev.days : []);
  syncOnceState();
  hideFormMsg();
  $("#eventForm").hidden = false;
  $("#eventAddBtn").hidden = true;
  $("#evTime").focus();
}

function closeEventForm() {
  editingId = null;
  $("#eventForm").hidden = true;
  $("#eventAddBtn").hidden = false;
  hideFormMsg();
}

// --- events wiring ---

$("#eventRegBtn").addEventListener("click", async () => {
  await send("registerCurrentEventTab");
  await refreshEvents();
  openEventForm(); // jump straight to adding the first event (flow 7.1)
});

$("#eventAddBtn").addEventListener("click", () => openEventForm());
$("#evCancel").addEventListener("click", closeEventForm);
$("#evOnce").addEventListener("change", syncOnceState);

$("#evDays").addEventListener("click", (e) => {
  const b = e.target.closest(".day");
  if (!b || b.disabled) return;
  b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true");
});

document.querySelector(".evpresets").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  $("#evOnce").checked = false;
  syncOnceState();
  const days = { weekdays: [1, 2, 3, 4, 5], weekends: [0, 6], daily: [0, 1, 2, 3, 4, 5, 6] };
  setFormDays(days[chip.dataset.preset] ?? []);
});

$("#eventForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const cur = eventsState?.current;
  if (!cur) return;
  const oneTime = $("#evOnce").checked;
  const data = {
    time: $("#evTime").value,
    label: $("#evLabel").value,
    oneTime,
    days: oneTime ? [] : getFormDays(),
  };
  if (!data.time) return showFormMsg("Pick a time.");
  if (!oneTime && data.days.length === 0) {
    return showFormMsg("Pick at least one day, or choose one-time.");
  }
  const res = editingId
    ? await send("updateEvent", { url: cur.url, id: editingId, patch: data })
    : await send("addEvent", { url: cur.url, event: data });
  if (!res?.ok) {
    if (res?.error === "duplicate") {
      showFormMsg(`There's already an event at that time (“${res.collidesLabel}”).`);
    } else {
      showFormMsg(res?.error || "Couldn't save the event.");
    }
    return;
  }
  closeEventForm();
  await refreshEvents();
});

$("#eventList").addEventListener("click", async (e) => {
  const row = e.target.closest(".evrow");
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.closest(".evrow__edit")) {
    const ev = eventsState.events.find((x) => x.id === id);
    if (ev) openEventForm(ev);
  } else if (e.target.closest(".evrow__delete")) {
    await send("deleteEvent", { url: eventsState.current.url, id });
    if (editingId === id) closeEventForm();
    await refreshEvents();
  }
});

$("#eventList").addEventListener("change", async (e) => {
  if (!e.target.classList.contains("evrow__enabled")) return;
  const id = e.target.closest(".evrow").dataset.id;
  const res = await send("setEventEnabled", {
    url: eventsState.current.url,
    id,
    enabled: e.target.checked,
  });
  if (!res?.ok && res?.error === "duplicate") {
    e.target.checked = false; // re-enabling would collide (EV-9)
  }
  await refreshEvents();
});

$("#eventUnregBtn").addEventListener("click", async () => {
  // Empty tab: remove outright. Otherwise inline-confirm (EV-2a popup path).
  if (!eventsState.events.length) {
    await send("unregisterEventTab", { url: eventsState.current.url });
    await refreshEvents();
    return;
  }
  $("#eventUnregConfirm").hidden = false;
  $("#eventUnregBtn").hidden = true;
});

$("#eventUnregYes").addEventListener("click", async () => {
  await send("unregisterEventTab", { url: eventsState.current.url });
  closeEventForm();
  await refreshEvents();
});

$("#eventUnregNo").addEventListener("click", () => {
  $("#eventUnregConfirm").hidden = true;
  $("#eventUnregBtn").hidden = false;
});

async function showEventShortcut() {
  try {
    const cmds = await chrome.commands.getAll();
    const cmd = cmds.find((c) => c.name === "toggle-events-tab");
    const el = $("#eventShortcutHint");
    if (cmd && cmd.shortcut) el.textContent = cmd.shortcut;
    else el.textContent = "(unset — set it in chrome://extensions/shortcuts)";
  } catch {
    /* commands may be unavailable in some Chromium forks */
  }
}

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

// Re-render live when event data changes from another context (a fire in the
// worker, or edits on the options page) — EV-16 / §9.6.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "sync" || area === "local") refreshEvents();
});

async function init() {
  // Show the configured min/max in placeholders for clarity.
  $("#currentInterval").placeholder = String(DEFAULT_INTERVAL_MINUTES);
  buildDayButtons();
  await Promise.all([refresh(), refreshEvents(), showShortcut(), showEventShortcut()]);
  tickTimer = setInterval(tick, 1000);
}

window.addEventListener("unload", () => clearInterval(tickTimer));

init();
