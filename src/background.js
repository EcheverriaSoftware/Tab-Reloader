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
  clampSnooze,
  computeNextOccurrence,
  eventAlarmName,
  eventIdFromAlarmName,
  formatTimeOfDay,
  genId,
  isSnoozeAlarmName,
  normalizeDays,
  parseTimeOfDay,
  tabIdFromAlarmName,
  CONFIRM_NOTIF_PREFIX,
  DEFAULT_INTERVAL_KEY,
  EVENTS_COMMAND,
  EVENT_NOTIF_PREFIX,
  RELOAD_COMMAND,
  SHOW_BADGE_KEY,
  SNOOZE_ALARM_PREFIX,
} from "./common/constants.js";
import {
  deleteEntry,
  deleteEventTab,
  deleteNotif,
  deleteSnooze,
  getDefaultInterval,
  getEntry,
  getEventTab,
  getEventTabs,
  getKeepAlertsOnScreen,
  getList,
  getNotif,
  getShowBadge,
  getSnooze,
  getSnoozeMinutes,
  putEntry,
  putEventTab,
  putNotif,
  putSnooze,
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

// ===========================================================================
// Events (docs/EVENTS_PRD.md)
//
// Time-of-day notifications attached to a tab (identified by URL so they
// persist across sessions). Each enabled event owns one absolute-`when` alarm
// named `event-<id>`. State lives in storage, so a suspended worker re-armed by
// an alarm reads everything fresh — no in-memory event state.
// ===========================================================================

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

/** Find an event by id across all event tabs. Returns { url, record, event }. */
async function findEvent(eventId) {
  const tabs = await getEventTabs();
  for (const url of Object.keys(tabs)) {
    const record = tabs[url];
    const event = record.events.find((e) => e.id === eventId);
    if (event) return { url, record, event };
  }
  return null;
}

// --- scheduling ------------------------------------------------------------

/** (Re)arm an event's alarm to its next occurrence; clears it if unschedulable. */
async function armEvent(event, now = Date.now()) {
  await chrome.alarms.clear(eventAlarmName(event.id));
  if (!event.enabled) {
    event.scheduledFor = null;
    return;
  }
  const next = computeNextOccurrence(event.time, event.days, event.oneTime, now);
  event.scheduledFor = next;
  if (next != null) await chrome.alarms.create(eventAlarmName(event.id), { when: next });
}

// --- duplicate detection (EV-9) --------------------------------------------

/**
 * The set of weekdays an event can fire on, for collision comparison: a
 * recurring event's weekday set, or the single weekday of a one-time event's
 * next occurrence.
 */
function eventDaySet(ev, now) {
  if (!ev.oneTime) return new Set(normalizeDays(ev.days));
  const next = computeNextOccurrence(ev.time, [], true, now);
  return next == null ? new Set() : new Set([new Date(next).getDay()]);
}

/**
 * First enabled event on the tab that collides with `candidate` — same time on
 * an overlapping day (EV-9). `excludeId` skips the event being edited.
 */
function findCollision(events, candidate, excludeId, now = Date.now()) {
  const candSet = eventDaySet(candidate, now);
  for (const ev of events) {
    if (ev.id === excludeId || !ev.enabled || ev.time !== candidate.time) continue;
    const set = eventDaySet(ev, now);
    for (const d of candSet) if (set.has(d)) return ev;
  }
  return null;
}

function collisionResult(ev) {
  return {
    ok: false,
    error: "duplicate",
    collidesWith: ev.id,
    collidesLabel: ev.label || formatTimeOfDay(ev.time),
  };
}

// --- tab registration (EV-1..EV-4) -----------------------------------------

async function registerEventTab(tab) {
  if (!tab || !tab.url) return { ok: false };
  const existing = await getEventTab(tab.url);
  if (existing) {
    if (tab.title && existing.title !== tab.title) {
      existing.title = tab.title;
      await putEventTab(existing);
    }
    return { ok: true, url: tab.url, alreadyRegistered: true };
  }
  await putEventTab({
    url: tab.url,
    title: tab.title || tab.url,
    addedAt: Date.now(),
    events: [],
  });
  return { ok: true, url: tab.url };
}

/** Unregister a tab and cancel all its event alarms (EV-2, EV-2a). */
async function unregisterEventTab(url) {
  const record = await getEventTab(url);
  if (record) {
    for (const ev of record.events) await chrome.alarms.clear(eventAlarmName(ev.id));
  }
  await deleteEventTab(url);
  return { ok: true };
}

// --- event CRUD (EV-5..EV-8a) ----------------------------------------------

async function addEvent(url, data) {
  const record = await getEventTab(url);
  if (!record) return { ok: false, error: "This tab isn't registered for events." };
  if (!parseTimeOfDay(data.time)) return { ok: false, error: "Enter a valid time." };
  const oneTime = !!data.oneTime;
  const days = oneTime ? [] : normalizeDays(data.days);
  if (!oneTime && days.length === 0) return { ok: false, error: "Pick at least one day." };

  const candidate = { id: null, time: data.time, days, oneTime, enabled: true };
  const clash = findCollision(record.events, candidate, null);
  if (clash) return collisionResult(clash);

  const event = {
    id: genId(),
    label: (data.label || "").trim(),
    time: data.time,
    days,
    oneTime,
    enabled: true,
    lastFiredAt: null,
    missed: false,
    scheduledFor: null,
  };
  await armEvent(event);
  record.events.push(event);
  await putEventTab(record);
  return { ok: true, id: event.id };
}

/** Apply a patch (label/time/days/oneTime/enabled) and reschedule from now (EV-7). */
async function updateEvent(url, id, patch) {
  const record = await getEventTab(url);
  if (!record) return { ok: false };
  const event = record.events.find((e) => e.id === id);
  if (!event) return { ok: false };

  const next = { ...event, ...patch };
  next.oneTime = !!next.oneTime;
  next.days = next.oneTime ? [] : normalizeDays(next.days);
  next.label = (next.label ?? "").trim();
  if (!parseTimeOfDay(next.time)) return { ok: false, error: "Enter a valid time." };
  if (!next.oneTime && next.days.length === 0) return { ok: false, error: "Pick at least one day." };
  if (next.enabled) {
    const clash = findCollision(record.events, next, id);
    if (clash) return collisionResult(clash);
  }

  // An edit (or re-enable) supersedes a prior missed state (EV-8a).
  next.missed = false;
  Object.assign(event, next);
  await armEvent(event);
  await putEventTab(record);
  return { ok: true };
}

async function deleteEvent(url, id) {
  const record = await getEventTab(url);
  if (!record) return { ok: false };
  const idx = record.events.findIndex((e) => e.id === id);
  if (idx === -1) return { ok: false };
  record.events.splice(idx, 1);
  await chrome.alarms.clear(eventAlarmName(id));
  await putEventTab(record);
  return { ok: true };
}

/** Shortcut toggle (EV-10): register, or unregister with confirmation (EV-2a). */
async function toggleEventsTab() {
  const tab = await getCurrentTab();
  if (!tab || !tab.url) return { ok: false };
  const record = await getEventTab(tab.url);
  if (!record) {
    await registerEventTab(tab);
    return { ok: true, added: true };
  }
  if (record.events.length > 0) {
    await showUnregisterConfirm(tab.url, record.events.length);
    return { ok: true, confirm: true };
  }
  await unregisterEventTab(tab.url);
  return { ok: true, added: false };
}

// --- firing & notifications (EV-11..EV-15) ---------------------------------

/** Show the alert for a firing event and record the id→event mapping. */
async function showEventNotification(url, record, event) {
  const keep = await getKeepAlertsOnScreen();
  const notifId = `${EVENT_NOTIF_PREFIX}${event.id}:${Date.now()}`;
  await putNotif(notifId, { kind: "event", url, eventId: event.id });
  const when = formatTimeOfDay(event.time);
  await chrome.notifications.create(notifId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: event.label || when,
    message: `${record.title || url}\n${when}`,
    buttons: [{ title: "Jump to tab" }, { title: "Snooze" }],
    silent: true, // §8.3 — visual only
    requireInteraction: keep, // §8.2 keepAlertsOnScreen
    priority: keep ? 2 : 0,
  });
}

/** Confirming notification for shortcut-driven unregister (EV-2a, §9.5). */
async function showUnregisterConfirm(url, count) {
  const notifId = `${CONFIRM_NOTIF_PREFIX}${Date.now()}`;
  await putNotif(notifId, { kind: "confirm", url });
  await chrome.notifications.create(notifId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "Remove events from this tab?",
    message: `This tab has ${count} event${count === 1 ? "" : "s"}. Remove ${
      count === 1 ? "it" : "them"
    } and unregister the tab?`,
    buttons: [{ title: "Remove" }, { title: "Cancel" }],
    silent: true,
    requireInteraction: true,
  });
}

/** Jump to the event's tab: focus an exact-URL match, else open it (EV-12). */
async function jumpToUrl(url) {
  const all = await chrome.tabs.query({});
  const matches = all.filter((t) => t.url === url);
  if (matches.length > 0) {
    // Deterministic tie-break: most recently active match where available (§10).
    matches.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    const target = matches[0];
    if (target.id != null) await chrome.tabs.update(target.id, { active: true });
    await chrome.windows.update(target.windowId, { focused: true }).catch(() => {});
  } else {
    await chrome.tabs.create({ url });
  }
}

/** Defer a fired event's reminder by the configured N minutes (EV-13a). */
async function snoozeEvent(url, eventId) {
  const minutes = clampSnooze(await getSnoozeMinutes());
  const alarmName = `${SNOOZE_ALARM_PREFIX}${eventId}:${Date.now()}`;
  await putSnooze(alarmName, { url, eventId });
  await chrome.alarms.create(alarmName, { delayInMinutes: minutes });
}

/** Core fire: alert, then reschedule (recurring) or auto-disable (one-time). */
async function fireEvent(eventId) {
  const located = await findEvent(eventId);
  if (!located) {
    await chrome.alarms.clear(eventAlarmName(eventId));
    return;
  }
  const { url, record, event } = located;
  if (!event.enabled) return; // defensive; disabled events have no alarm

  await showEventNotification(url, record, event);
  event.lastFiredAt = Date.now();
  if (event.oneTime) {
    event.enabled = false; // EV-8a
    event.scheduledFor = null;
  } else {
    await armEvent(event); // EV-15: schedule the next occurrence
  }
  await putEventTab(record);
}

/** A snooze alarm elapsed — re-show the same alert if the event still exists. */
async function fireSnooze(alarmName) {
  const info = await getSnooze(alarmName);
  await deleteSnooze(alarmName);
  if (!info) return;
  const located = await findEvent(info.eventId);
  if (located) await showEventNotification(located.url, located.record, located.event);
}

// --- reconciliation on startup / install (§9.6, EV-16, EV-18) --------------

async function reconcileEvents() {
  // Drop every event & snooze alarm, then re-arm enabled events from scratch.
  // Snoozes are intentionally not restored (EV-13a, EV-18).
  const alarms = await chrome.alarms.getAll();
  await Promise.all(
    alarms
      .filter((a) => eventIdFromAlarmName(a.name) !== null || isSnoozeAlarmName(a.name))
      .map((a) => chrome.alarms.clear(a.name)),
  );

  const now = Date.now();
  const tabs = await getEventTabs();
  for (const url of Object.keys(tabs)) {
    const record = tabs[url];
    let changed = false;
    for (const event of record.events) {
      if (!event.enabled) {
        if (event.scheduledFor != null) {
          event.scheduledFor = null;
          changed = true;
        }
        continue;
      }
      if (event.oneTime) {
        // Use the time we armed before shutdown; if it passed, it's missed
        // (no retroactive fire, EV-18). Newly added/unarmed → compute it.
        if (event.scheduledFor == null) {
          event.scheduledFor = computeNextOccurrence(event.time, event.days, true, now);
          changed = true;
        }
        if (event.scheduledFor != null && event.scheduledFor <= now) {
          event.enabled = false;
          event.missed = true;
          event.scheduledFor = null;
          changed = true;
        } else if (event.scheduledFor != null) {
          await chrome.alarms.create(eventAlarmName(event.id), { when: event.scheduledFor });
        }
      } else {
        // Recurring: always re-arm the next future occurrence.
        const prev = event.scheduledFor;
        await armEvent(event, now);
        if (event.scheduledFor !== prev) changed = true;
      }
    }
    if (changed) await putEventTab(record);
  }
}

// --- popup / options state -------------------------------------------------

/** Decorate a stored event with its live next-fire time for display. */
async function toEventView(event) {
  let nextFireAt = event.scheduledFor ?? null;
  if (event.enabled) {
    const alarm = await chrome.alarms.get(eventAlarmName(event.id));
    if (alarm) nextFireAt = alarm.scheduledTime;
  }
  return {
    id: event.id,
    label: event.label,
    time: event.time,
    days: event.days,
    oneTime: event.oneTime,
    enabled: event.enabled,
    missed: event.missed,
    lastFiredAt: event.lastFiredAt,
    nextFireAt,
  };
}

/** Events state for the popup: current tab + its events. */
async function buildEventsState() {
  const tab = await getCurrentTab();
  const current = tab && tab.url
    ? { url: tab.url, title: tab.title || tab.url, favIconUrl: tab.favIconUrl || null }
    : null;

  let record = null;
  if (current) {
    record = await getEventTab(current.url);
    if (record && current.title && record.title !== current.title) {
      record.title = current.title; // opportunistic title refresh (EV-4)
      await putEventTab(record);
    }
  }
  const events = record ? await Promise.all(record.events.map(toEventView)) : [];
  return {
    current: current
      ? { ...current, isEventTab: !!record, eventCount: record ? record.events.length : 0 }
      : null,
    events,
  };
}

/** Events state for the options page: every event tab and its events. */
async function buildAllEventsState() {
  const tabs = await getEventTabs();
  const out = [];
  for (const url of Object.keys(tabs)) {
    const record = tabs[url];
    out.push({
      url,
      title: record.title,
      addedAt: record.addedAt,
      events: await Promise.all(record.events.map(toEventView)),
    });
  }
  out.sort((a, b) => a.addedAt - b.addedAt);
  return { tabs: out };
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

    // --- events ---
    case "getEventsState":
      return buildEventsState();
    case "getAllEventsState":
      return buildAllEventsState();
    case "registerCurrentEventTab":
      return registerEventTab(await getCurrentTab());
    case "unregisterEventTab":
      return unregisterEventTab(msg.url);
    case "addEvent":
      return addEvent(msg.url, msg.event ?? {});
    case "updateEvent":
      return updateEvent(msg.url, msg.id, msg.patch ?? {});
    case "setEventEnabled":
      return updateEvent(msg.url, msg.id, { enabled: !!msg.enabled });
    case "deleteEvent":
      return deleteEvent(msg.url, msg.id);

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

// Core refresh / skip logic (FR-9..FR-12), plus event & snooze firing (§9.4).
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Event firing takes the alarm if it carries an event id or is a snooze.
  const eventId = eventIdFromAlarmName(alarm.name);
  if (eventId !== null) {
    await fireEvent(eventId);
    return;
  }
  if (isSnoozeAlarmName(alarm.name)) {
    await fireSnooze(alarm.name);
    return;
  }

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

// Keep an event tab's stored title current when a matching tab's title changes
// (EV-4); the URL remains the identity and is never rewritten here.
chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
  if (!changeInfo.title || !tab.url) return;
  const record = await getEventTab(tab.url);
  if (record && record.title !== changeInfo.title) {
    record.title = changeInfo.title;
    await putEventTab(record);
  }
});

// Keyboard quick-add / toggle (FR-9, EV-10).
chrome.commands.onCommand.addListener(async (command) => {
  if (command === RELOAD_COMMAND) {
    const result = await toggleCurrentTab();
    if (!result.ok) return;
    await flashBadge(result.added ? "ON" : "OFF", result.added ? "#16a34a" : "#6b7280");
    return;
  }
  if (command === EVENTS_COMMAND) {
    const result = await toggleEventsTab();
    if (!result.ok || result.confirm) return; // confirm path shows its own prompt
    await flashBadge(result.added ? "+EV" : "−EV", result.added ? "#16a34a" : "#6b7280");
  }
});

// Notification actions: Jump / Snooze for alerts (EV-12, EV-13a), Remove /
// Cancel for the unregister confirm (EV-2a). Dismissal is the Ignore path (EV-13).
chrome.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
  const info = await getNotif(notifId);
  if (!info) return;
  if (info.kind === "event") {
    if (btnIdx === 0) await jumpToUrl(info.url);
    else if (btnIdx === 1) await snoozeEvent(info.url, info.eventId);
  } else if (info.kind === "confirm" && btnIdx === 0) {
    await unregisterEventTab(info.url);
  }
  await deleteNotif(notifId);
  await chrome.notifications.clear(notifId);
});

chrome.notifications.onClicked.addListener(async (notifId) => {
  const info = await getNotif(notifId);
  if (!info) return;
  if (info.kind === "event") await jumpToUrl(info.url); // clicking the body = Jump
  await deleteNotif(notifId);
  await chrome.notifications.clear(notifId);
});

// Dismissing an alert is Ignore (EV-13); for a confirm it's Cancel. Either way
// just drop the mapping — the action (if any) already ran above.
chrome.notifications.onClosed.addListener(async (notifId) => {
  await deleteNotif(notifId);
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
  await reconcileEvents(); // rebuild event alarms cleared on update (§9.6)
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  // New browser session: storage.session is empty (FR-14); drop stray alarms.
  await clearStrayAlarms();
  await reconcileEvents(); // re-arm persisted events; no stale catch-up (EV-18)
  await refreshBadge();
});
