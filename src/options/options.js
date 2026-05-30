import {
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  clampInterval,
  clampSnooze,
  eventScheduleText,
  formatTimeOfDay,
} from "../common/constants.js";
import {
  getDefaultInterval,
  getKeepAlertsOnScreen,
  getShowBadge,
  getSnoozeMinutes,
  setDefaultInterval,
  setKeepAlertsOnScreen,
  setShowBadge,
  setSnoozeMinutes,
} from "../common/storage.js";

const $ = (sel) => document.querySelector(sel);

function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra });
}

// ---------------------------------------------------------------------------
// Default interval (reloader)
// ---------------------------------------------------------------------------

function showMessage(text, kind) {
  const el = $("#intervalMsg");
  el.textContent = text;
  el.className = `msg msg--${kind}`;
  el.hidden = false;
}

async function saveInterval() {
  const raw = $("#defaultInterval").value;
  const { value, clamped, invalid } = clampInterval(raw, await getDefaultInterval());
  if (invalid) {
    showMessage("Please enter a number of minutes.", "warn");
    return;
  }
  await setDefaultInterval(value);
  $("#defaultInterval").value = value;
  if (clamped) {
    showMessage(
      `Saved. Adjusted to ${value} min (allowed range ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES}).`,
      "warn",
    );
  } else {
    showMessage("Saved.", "ok");
  }
}

$("#saveBtn").addEventListener("click", saveInterval);
$("#defaultInterval").addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveInterval();
});

$("#showBadge").addEventListener("change", async (e) => {
  await setShowBadge(e.target.checked);
});

$("#shortcutsBtn").addEventListener("click", () => {
  // Chromium-standard shortcuts page. Not openable via chrome.tabs from an
  // options page on all builds, so use a plain tab creation.
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

async function showShortcut() {
  try {
    const cmds = await chrome.commands.getAll();
    const reload = cmds.find((c) => c.name === "toggle-current-tab");
    const events = cmds.find((c) => c.name === "toggle-events-tab");
    $("#shortcut").textContent = reload?.shortcut || "(unset)";
    const ev = events?.shortcut || "(unset)";
    $("#eventShortcut").textContent = ev;
    $("#eventShortcut2").textContent = ev;
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Event alert prefs (snooze duration, keep-on-screen)
// ---------------------------------------------------------------------------

$("#snoozeMinutes").addEventListener("change", async (e) => {
  const n = clampSnooze(e.target.value);
  await setSnoozeMinutes(n);
  e.target.value = n;
  const msg = $("#snoozeMsg");
  msg.textContent = "Saved.";
  msg.className = "msg msg--ok";
  msg.hidden = false;
});

$("#keepAlerts").addEventListener("change", async (e) => {
  await setKeepAlertsOnScreen(e.target.checked);
});

// ---------------------------------------------------------------------------
// Event tabs management (§8.2 — all event tabs, full edit controls)
// ---------------------------------------------------------------------------

const DAY_LABELS = [
  { d: 0, short: "S", full: "Sunday" },
  { d: 1, short: "M", full: "Monday" },
  { d: 2, short: "T", full: "Tuesday" },
  { d: 3, short: "W", full: "Wednesday" },
  { d: 4, short: "T", full: "Thursday" },
  { d: 5, short: "F", full: "Friday" },
  { d: 6, short: "S", full: "Saturday" },
];

function buildDayButtons(container) {
  container.textContent = "";
  for (const { d, short, full } of DAY_LABELS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "day";
    b.dataset.day = String(d);
    b.textContent = short;
    b.title = full;
    b.setAttribute("aria-pressed", "false");
    container.appendChild(b);
  }
}

/** Build a fully-wired card for one event tab (its events + add/edit form). */
function buildTabCard(tab) {
  const node = $("#eventTabTemplate").content.firstElementChild.cloneNode(true);
  const url = tab.url;

  node.querySelector(".evtab__title").textContent = tab.title || url;
  node.querySelector(".evtab__url").textContent = url;

  const listEl = node.querySelector(".evtab__list");
  const emptyEl = node.querySelector(".evtab__empty");
  const form = node.querySelector(".evform");
  const addBtn = node.querySelector(".evtab__add");
  const removeBtn = node.querySelector(".evtab__remove");
  const confirm = node.querySelector(".evtab__confirm");
  const daypick = form.querySelector(".daypick");
  const onceCb = form.querySelector(".evonce-cb");
  const timeInput = form.querySelector(".evtime");
  const labelInput = form.querySelector(".evlabel");
  const formMsg = form.querySelector(".evform__msg");
  let editingId = null;

  buildDayButtons(daypick);

  // Event rows.
  const rowTpl = $("#eventRowTemplate");
  for (const ev of tab.events) {
    const row = rowTpl.content.firstElementChild.cloneNode(true);
    row.dataset.id = ev.id;
    row.classList.toggle("is-off", !ev.enabled);
    row.classList.toggle("is-missed", ev.missed);
    row.querySelector(".evrow__enabled").checked = ev.enabled;
    row.querySelector(".evrow__label").textContent = ev.label || formatTimeOfDay(ev.time);
    row.querySelector(".evrow__sub").textContent = eventScheduleText(ev);
    listEl.appendChild(row);
  }
  emptyEl.hidden = tab.events.length > 0;

  // Form helpers (closed over this card's elements).
  const syncOnce = () => {
    const once = onceCb.checked;
    daypick.classList.toggle("is-disabled", once);
    for (const b of daypick.querySelectorAll(".day")) b.disabled = once;
    for (const b of form.querySelectorAll(".chip")) b.disabled = once;
  };
  const getDays = () =>
    [...daypick.querySelectorAll(".day")]
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => Number(b.dataset.day));
  const setDays = (days) => {
    const set = new Set(days);
    for (const b of daypick.querySelectorAll(".day")) {
      b.setAttribute("aria-pressed", set.has(Number(b.dataset.day)) ? "true" : "false");
    }
  };
  const showMsg = (t) => {
    formMsg.textContent = t;
    formMsg.hidden = false;
  };
  const openForm = (ev) => {
    editingId = ev?.id ?? null;
    timeInput.value = ev?.time ?? "";
    labelInput.value = ev?.label ?? "";
    onceCb.checked = ev ? ev.oneTime : false;
    setDays(ev && !ev.oneTime ? ev.days : []);
    syncOnce();
    formMsg.hidden = true;
    form.hidden = false;
    addBtn.hidden = true;
    timeInput.focus();
  };

  addBtn.addEventListener("click", () => openForm());
  form.querySelector(".evform__cancel").addEventListener("click", () => {
    form.hidden = true;
    addBtn.hidden = false;
  });
  onceCb.addEventListener("change", syncOnce);

  daypick.addEventListener("click", (e) => {
    const b = e.target.closest(".day");
    if (!b || b.disabled) return;
    b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true");
  });

  form.querySelector(".evpresets").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    onceCb.checked = false;
    syncOnce();
    const map = { weekdays: [1, 2, 3, 4, 5], weekends: [0, 6], daily: [0, 1, 2, 3, 4, 5, 6] };
    setDays(map[chip.dataset.preset] ?? []);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const oneTime = onceCb.checked;
    const data = {
      time: timeInput.value,
      label: labelInput.value,
      oneTime,
      days: oneTime ? [] : getDays(),
    };
    if (!data.time) return showMsg("Pick a time.");
    if (!oneTime && data.days.length === 0) {
      return showMsg("Pick at least one day, or choose one-time.");
    }
    const res = editingId
      ? await send("updateEvent", { url, id: editingId, patch: data })
      : await send("addEvent", { url, event: data });
    if (!res?.ok) {
      showMsg(
        res?.error === "duplicate"
          ? `There's already an event at that time (“${res.collidesLabel}”).`
          : res?.error || "Couldn't save the event.",
      );
      return;
    }
    await refreshEvents();
  });

  listEl.addEventListener("click", async (e) => {
    const row = e.target.closest(".evrow");
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.closest(".evrow__edit")) {
      const ev = tab.events.find((x) => x.id === id);
      if (ev) openForm(ev);
    } else if (e.target.closest(".evrow__delete")) {
      await send("deleteEvent", { url, id });
      await refreshEvents();
    }
  });

  listEl.addEventListener("change", async (e) => {
    if (!e.target.classList.contains("evrow__enabled")) return;
    const id = e.target.closest(".evrow").dataset.id;
    const res = await send("setEventEnabled", { url, id, enabled: e.target.checked });
    if (!res?.ok && res?.error === "duplicate") e.target.checked = false; // EV-9
    await refreshEvents();
  });

  removeBtn.addEventListener("click", async () => {
    if (tab.events.length === 0) {
      await send("unregisterEventTab", { url });
      await refreshEvents();
      return;
    }
    confirm.hidden = false;
    removeBtn.hidden = true;
  });
  node.querySelector(".evtab__remove-yes").addEventListener("click", async () => {
    await send("unregisterEventTab", { url });
    await refreshEvents();
  });
  node.querySelector(".evtab__remove-no").addEventListener("click", () => {
    confirm.hidden = true;
    removeBtn.hidden = false;
  });

  return node;
}

function renderMissed(tabs) {
  const list = $("#missedList");
  list.textContent = "";
  let count = 0;
  for (const tab of tabs) {
    for (const ev of tab.events) {
      if (!ev.missed) continue;
      count++;
      const li = document.createElement("li");
      const label = ev.label || formatTimeOfDay(ev.time);
      li.textContent = `${label} (${formatTimeOfDay(ev.time)}) — ${tab.title || tab.url}`;
      list.appendChild(li);
    }
  }
  $("#missedSection").hidden = count === 0;
}

function renderEventTabs(state) {
  const container = $("#eventTabs");
  container.textContent = "";
  for (const tab of state.tabs) container.appendChild(buildTabCard(tab));
  $("#noEventTabs").hidden = state.tabs.length > 0;
  renderMissed(state.tabs);
}

async function refreshEvents() {
  const state = await send("getAllEventsState");
  renderEventTabs(state);
}

// Live-refresh when events change elsewhere (a fire in the worker, the popup),
// but don't clobber a form the user is currently filling in on this page.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== "sync" && area !== "local") return;
  if (document.querySelector("#eventTabs .evform:not([hidden])")) return;
  refreshEvents();
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  $("#defaultInterval").value = await getDefaultInterval();
  $("#showBadge").checked = await getShowBadge();
  $("#snoozeMinutes").value = await getSnoozeMinutes();
  $("#keepAlerts").checked = await getKeepAlertsOnScreen();
  await Promise.all([showShortcut(), refreshEvents()]);
}

init();
