// Tab Reloader — background service worker (MV3).
//
// Owns all scheduling and state. Every handler reads its state from
// chrome.storage.session rather than in-memory globals, so the worker can be
// suspended and re-woken by an alarm at any time without losing the reload
// list (§9.6). The only in-memory state is a best-effort set of reloads we
// triggered ourselves, used to distinguish our reloads from the user's.

import {
  alarmNameForTab,
  clampInterval,
  tabIdFromAlarmName,
  DEFAULT_INTERVAL_KEY,
  SHOW_BADGE_KEY,
} from "./common/constants.js";
import {
  deleteEntry,
  getDefaultInterval,
  getEntry,
  getList,
  getShowBadge,
  putEntry,
  setLastUsedInterval,
} from "./common/storage.js";

const BADGE_COLOR = "#2563eb";

// tabId -> timestamp(ms) of a reload WE initiated. Consumed by the onUpdated
// listener so our own reloads aren't mistaken for user-initiated ones (FR-10a).
const selfReloads = new Map();
const SELF_RELOAD_TTL_MS = 15_000;

function markSelfReload(tabId) {
  selfReloads.set(tabId, Date.now());
}

function consumeSelfReload(tabId) {
  const ts = selfReloads.get(tabId);
  if (ts == null) return false;
  selfReloads.delete(tabId);
  return Date.now() - ts < SELF_RELOAD_TTL_MS;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** Effective interval for an entry given the current global default. */
async function effectiveInterval(entry) {
  if (entry.overrideMinutes != null) return entry.overrideMinutes;
  return getDefaultInterval();
}

/**
 * (Re)create the periodic alarm for a tab so its next fire is one full interval
 * from now. Used on add, resume, interval edit, and manual-reload reset.
 */
async function scheduleTab(tabId) {
  const entry = await getEntry(tabId);
  if (!entry || entry.paused) return;
  const minutes = await effectiveInterval(entry);
  await chrome.alarms.create(alarmNameForTab(tabId), {
    delayInMinutes: minutes,
    periodInMinutes: minutes,
  });
}

async function clearTabAlarm(tabId) {
  await chrome.alarms.clear(alarmNameForTab(tabId));
}

// ---------------------------------------------------------------------------
// List mutations
// ---------------------------------------------------------------------------

async function addTab(tabId, overrideMinutes = null) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return false;
  await putEntry({
    tabId,
    overrideMinutes,
    paused: false,
    url: tab.url ?? "",
    addedAt: Date.now(),
  });
  await scheduleTab(tabId);
  await refreshBadge();
  return true;
}

async function removeTab(tabId) {
  await clearTabAlarm(tabId);
  const existed = await deleteEntry(tabId);
  selfReloads.delete(tabId);
  await refreshBadge();
  return existed;
}

async function pauseTab(tabId) {
  const entry = await getEntry(tabId);
  if (!entry || entry.paused) return;
  entry.paused = true;
  await putEntry(entry);
  await clearTabAlarm(tabId);
}

async function resumeTab(tabId) {
  const entry = await getEntry(tabId);
  if (!entry || !entry.paused) return;
  entry.paused = false;
  await putEntry(entry);
  await scheduleTab(tabId); // fresh schedule from now
}

async function pauseAll() {
  const list = await getList();
  for (const key of Object.keys(list)) await pauseTab(list[key].tabId);
}

async function resumeAll() {
  const list = await getList();
  for (const key of Object.keys(list)) await resumeTab(list[key].tabId);
}

/** Set or clear a per-tab interval override and reschedule from now (FR-8). */
async function setTabInterval(tabId, rawMinutes, useDefault = false) {
  const entry = await getEntry(tabId);
  if (!entry) return { ok: false };
  if (useDefault) {
    entry.overrideMinutes = null;
    await putEntry(entry);
    if (!entry.paused) await scheduleTab(tabId);
    return { ok: true, useDefault: true };
  }
  const def = await getDefaultInterval();
  const { value, clamped, invalid } = clampInterval(rawMinutes, def);
  if (invalid) return { ok: false };
  entry.overrideMinutes = value;
  await putEntry(entry);
  await setLastUsedInterval(value);
  if (!entry.paused) await scheduleTab(tabId);
  return { ok: true, value, clamped };
}

/** Add the current tab, or remove it if already reloading (keyboard + popup). */
async function toggleCurrentTab() {
  // From the service worker there's no "current window"; the focused window is
  // the authority (also correct for the keyboard command path).
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id == null) return { ok: false };
  const existing = await getEntry(tab.id);
  if (existing) {
    await removeTab(tab.id);
    return { ok: true, added: false, tabId: tab.id };
  }
  await addTab(tab.id);
  return { ok: true, added: true, tabId: tab.id };
}

// ---------------------------------------------------------------------------
// Viewing detection (§9.4, FR-11)
//
// The user is "viewing" a tab when it is the active tab in the focused window.
// No idle/input check is applied: a reader produces no input but must not be
// interrupted, so input activity is irrelevant to the skip decision.
// ---------------------------------------------------------------------------

async function isUserViewingTab(tabId, tabHint) {
  const tab = tabHint ?? (await chrome.tabs.get(tabId).catch(() => null));
  if (!tab || !tab.active) return false;
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  return !!win && win.focused;
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

async function refreshBadge() {
  const show = await getShowBadge();
  if (!show) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  const list = await getList();
  const count = Object.keys(list).length;
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
}

/** Briefly flash a confirmation on the toolbar badge, then restore (7.1). */
async function flashBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  setTimeout(() => {
    refreshBadge().catch(() => {});
  }, 1500);
}

// ---------------------------------------------------------------------------
// State snapshot for the popup
// ---------------------------------------------------------------------------

async function buildState() {
  const def = await getDefaultInterval();
  const list = await getList();
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  const items = [];
  for (const key of Object.keys(list)) {
    const entry = list[key];
    const tab = await chrome.tabs.get(entry.tabId).catch(() => null);
    if (!tab) {
      // Tab vanished while the worker was asleep — clean it up (FR-4 backstop).
      await removeTab(entry.tabId);
      continue;
    }
    let nextFireAt = null;
    if (!entry.paused) {
      const alarm = await chrome.alarms.get(alarmNameForTab(entry.tabId));
      nextFireAt = alarm?.scheduledTime ?? null;
    }
    items.push({
      tabId: entry.tabId,
      title: tab.title || tab.url || `Tab ${entry.tabId}`,
      favIconUrl: tab.favIconUrl || null,
      url: tab.url || "",
      effectiveInterval: entry.overrideMinutes ?? def,
      isOverride: entry.overrideMinutes != null,
      paused: entry.paused,
      nextFireAt,
      isCurrent: !!active && tab.id === active.id,
      addedAt: entry.addedAt,
    });
  }

  items.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return a.addedAt - b.addedAt;
  });

  return {
    defaultInterval: def,
    current: active && active.id != null
      ? {
          tabId: active.id,
          title: active.title || active.url || "Current tab",
          favIconUrl: active.favIconUrl || null,
          url: active.url || "",
          isReloading: String(active.id) in list,
        }
      : null,
    items,
    allPaused: items.length > 0 && items.every((i) => i.paused),
  };
}

// ---------------------------------------------------------------------------
// Message API (popup/options -> background)
// ---------------------------------------------------------------------------

async function handleMessage(msg) {
  switch (msg?.type) {
    case "getState":
      return buildState();
    case "toggleCurrentTab":
      return toggleCurrentTab();
    case "addTab":
      return { ok: await addTab(msg.tabId, msg.overrideMinutes ?? null) };
    case "removeTab":
      return { ok: await removeTab(msg.tabId) };
    case "pauseTab":
      await pauseTab(msg.tabId);
      return { ok: true };
    case "resumeTab":
      await resumeTab(msg.tabId);
      return { ok: true };
    case "setTabInterval":
      return setTabInterval(msg.tabId, msg.minutes, !!msg.useDefault);
    case "pauseAll":
      await pauseAll();
      return { ok: true };
    case "resumeAll":
      await resumeAll();
      return { ok: true };
    case "reloadNow": {
      // Manual reload from the popup also resets the timer (FR-10a) via onUpdated.
      markSelfReload(msg.tabId);
      await chrome.tabs.reload(msg.tabId).catch(() => {});
      // Because the popup-initiated reload is a deliberate refresh, reset now too.
      const entry = await getEntry(msg.tabId);
      if (entry && !entry.paused) await scheduleTab(msg.tabId);
      return { ok: true };
    }
    default:
      return { ok: false, error: "unknown message" };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // keep the channel open for the async response
});

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

// Core refresh / skip logic (FR-9..FR-12).
chrome.alarms.onAlarm.addListener(async (alarm) => {
  const tabId = tabIdFromAlarmName(alarm.name);
  if (tabId === null) return;

  const entry = await getEntry(tabId);
  if (!entry) {
    // Stray alarm (e.g. left over from a previous session) — clear it.
    await chrome.alarms.clear(alarm.name);
    return;
  }
  if (entry.paused) return; // defensive; paused tabs have no alarm

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    await removeTab(tabId);
    return;
  }

  if (await isUserViewingTab(tabId, tab)) {
    // FR-11: skip this cycle silently; the periodic alarm retries next interval.
    return;
  }

  markSelfReload(tabId);
  await chrome.tabs.reload(tabId).catch(() => {});
});

// FR-4: when a reloading tab is closed, remove it and cancel its schedule.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const entry = await getEntry(tabId);
  if (entry) await removeTab(tabId);
});

// Manual-reload detection (FR-10a) and navigation tracking (edge cases §10).
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "loading") return;
  const entry = await getEntry(tabId);
  if (!entry) return;

  // A URL change means the user navigated somewhere new: keep the existing
  // schedule (reload is by tab, not URL) and just remember the new URL.
  if (changeInfo.url && changeInfo.url !== entry.url) {
    entry.url = changeInfo.url;
    await putEntry(entry);
    return;
  }

  // No URL change => a reload. If it was ours, ignore it.
  if (consumeSelfReload(tabId)) return;

  // Otherwise the user reloaded manually: reset the interval timer (FR-10a).
  if (!entry.paused) await scheduleTab(tabId);
});

// Keyboard quick-add / toggle (FR-9).
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-current-tab") return;
  const result = await toggleCurrentTab();
  if (!result.ok) return;
  if (result.added) await flashBadge("ON", "#16a34a");
  else await flashBadge("OFF", "#6b7280");
});

// When the global default changes, reschedule tabs that use it (no override).
chrome.storage.onChanged.addListener(async (changes, area) => {
  if ((area === "sync" || area === "local") && changes[DEFAULT_INTERVAL_KEY]) {
    const list = await getList();
    for (const key of Object.keys(list)) {
      const entry = list[key];
      if (entry.overrideMinutes == null && !entry.paused) {
        await scheduleTab(entry.tabId);
      }
    }
  }
  if ((area === "sync" || area === "local") && changes[SHOW_BADGE_KEY]) {
    await refreshBadge();
  }
});

// Clear any alarms left over from a previous session/install so the empty
// session list (FR-14) is never shadowed by a stale alarm.
async function clearStrayAlarms() {
  const alarms = await chrome.alarms.getAll();
  await Promise.all(
    alarms
      .filter((a) => tabIdFromAlarmName(a.name) !== null)
      .map((a) => chrome.alarms.clear(a.name)),
  );
}

chrome.runtime.onInstalled.addListener(async () => {
  // First-run defaults are lazily provided by storage getters; nothing to seed.
  await clearStrayAlarms();
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  // New browser session: storage.session is empty (FR-14); drop stray alarms.
  await clearStrayAlarms();
  await refreshBadge();
});
