// Tab Reloader — background service worker (MV3).
//
// Owns all scheduling and state. Every handler reads its state from
// chrome.storage.session rather than in-memory globals, so the worker can be
// suspended and re-woken by an alarm at any time without losing the reload
// list (§9.6). The only in-memory state is a best-effort set of reloads we
// triggered ourselves, used to distinguish our reloads from the user's.

import {
  alarmNameForTab,
  anchorActionLabel,
  anchorTimeField,
  clampInterval,
  clampSnooze,
  computeNextOccurrence,
  eventAlarmName,
  formatTimeOfDay,
  genId,
  isSnoozeAlarmName,
  isUnackAlarmName,
  normalizeDays,
  parseEventAlarmName,
  parseTimeOfDay,
  tabIdFromAlarmName,
  ANALYZER_COMMAND,
  ANALYZER_PAGE,
  ANCHORS,
  ANCHOR_IN,
  ANCHOR_OUT,
  CONFIRM_NOTIF_PREFIX,
  DEFAULT_INTERVAL_KEY,
  EVENTS_COMMAND,
  EVENT_NOTIF_PREFIX,
  FIRE_LOG_DISPLAY_MAX,
  FIRE_LOG_TTL_MS,
  FIRE_STATUS,
  RELOAD_COMMAND,
  SHOW_BADGE_KEY,
  SNOOZE_ALARM_PREFIX,
  UNACK_ALARM_PREFIX,
  UNACK_WINDOW_MINUTES,
} from "./common/constants.js";
import {
  addUnackedFiring,
  appendFireLog,
  clearUnackedFirings,
  deleteEntry,
  deleteEventTab,
  deleteNotif,
  deleteSnooze,
  getDefaultInterval,
  getEntry,
  getEventTab,
  getEventTabs,
  getFireLog,
  getKeepAlertsOnScreen,
  getList,
  getNotif,
  getShowBadge,
  getSnooze,
  getSnoozeMinutes,
  getUnackedFirings,
  putEntry,
  putEventTab,
  putNotif,
  putSnooze,
  removeUnackedFiring,
  setLastUsedInterval,
  updateFireLog,
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

// Badge state colors. Unacked + muted are always shown (they're failure
// surfaces — §8.4 highest precedence); the "normal" count respects showBadge.
const BADGE_UNACK_COLOR = "#dc2626"; // red — EV-24
const BADGE_MUTED_COLOR = "#6b7280"; // gray — EV-21
const BADGE_EVENTS_COLOR = "#16a34a"; // green — events tab count

/**
 * Resolve the badge's current state with the §8.4 precedence:
 *   unacked-fires  >  OS-notifications-denied  >  reload-count  >  event-tabs-count.
 * The first two ignore showBadge — they are observability surfaces the user
 * has not opted out of in the same way as the simple count.
 */
async function refreshBadge() {
  // 1. EV-24 — unacknowledged fires (always surfaced).
  const unacked = await getUnackedFirings();
  if (unacked.length > 0) {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_UNACK_COLOR });
    await chrome.action.setBadgeText({ text: String(unacked.length) });
    return;
  }
  // 2. EV-21 — OS notifications denied (always surfaced).
  const permLevel = await getNotificationPermLevel();
  if (permLevel === "denied") {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_MUTED_COLOR });
    await chrome.action.setBadgeText({ text: "!" });
    return;
  }
  // 3 + 4 — counts only if the user opted in.
  const show = await getShowBadge();
  if (!show) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  const reloadCount = Object.keys(await getList()).length;
  if (reloadCount > 0) {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    await chrome.action.setBadgeText({ text: String(reloadCount) });
    return;
  }
  const eventTabCount = Object.keys(await getEventTabs()).length;
  if (eventTabCount > 0) {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_EVENTS_COLOR });
    await chrome.action.setBadgeText({ text: String(eventTabCount) });
    return;
  }
  await chrome.action.setBadgeText({ text: "" });
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
// Tab-bound clock-in/clock-out reminders. Each event has TWO independently-
// scheduled anchors (clock-in and clock-out) — each its own absolute-`when`
// alarm named `event-<id>-in` / `event-<id>-out` (§5, §9.4). State lives in
// storage, so a suspended worker re-armed by an alarm reads everything fresh —
// no in-memory event state.
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

// --- shape helpers ---------------------------------------------------------

function anchorTime(event, anchor) {
  return event[anchorTimeField(anchor)];
}

/** Ensure per-anchor objects exist (defensive — handles partial/legacy records). */
function ensureAnchorShape(event) {
  if (!event.lastFiredAt || typeof event.lastFiredAt !== "object") {
    event.lastFiredAt = { in: null, out: null };
  }
  if (!event.missed || typeof event.missed !== "object") {
    event.missed = { in: false, out: false };
  }
  if (!event.scheduledFor || typeof event.scheduledFor !== "object") {
    event.scheduledFor = { in: null, out: null };
  }
}

/** True once a one-time event has resolved (fired or missed) for an anchor. */
function anchorResolved(event, anchor) {
  return event.lastFiredAt[anchor] != null || event.missed[anchor];
}

// --- scheduling ------------------------------------------------------------

/** Arm one anchor: clear+recreate its alarm, update its `scheduledFor`. */
async function armAnchor(event, anchor, now = Date.now()) {
  ensureAnchorShape(event);
  const alarmName = eventAlarmName(event.id, anchor);
  await chrome.alarms.clear(alarmName);
  if (!event.enabled || (event.oneTime && anchorResolved(event, anchor))) {
    event.scheduledFor[anchor] = null;
    return;
  }
  const next = computeNextOccurrence(anchorTime(event, anchor), event.days, event.oneTime, now);
  event.scheduledFor[anchor] = next;
  if (next != null) await chrome.alarms.create(alarmName, { when: next });
}

/** Arm both anchors. */
async function armEvent(event, now = Date.now()) {
  for (const anchor of ANCHORS) await armAnchor(event, anchor, now);
}

/** Clear both anchor alarms (e.g., on delete or disable). */
async function disarmEvent(eventId) {
  for (const anchor of ANCHORS) await chrome.alarms.clear(eventAlarmName(eventId, anchor));
}

// --- duplicate detection (EV-9) --------------------------------------------

/**
 * Weekday set on which an event will fire — recurring uses its `days`,
 * one-time collapses to the weekday of its anchor's next occurrence. Both of
 * an event's anchors share this set (anchors only differ in time-of-day).
 */
function eventDaySet(ev, time, now) {
  if (!ev.oneTime) return new Set(normalizeDays(ev.days));
  const next = computeNextOccurrence(time, [], true, now);
  return next == null ? new Set() : new Set([new Date(next).getDay()]);
}

/**
 * EV-9: find the first existing firing on the tab that the candidate would
 * collide with — same time-of-day on an overlapping weekday. Compared per
 * firing (clock-in and clock-out are independent anchors). Also rejects the
 * degenerate self-collision (candidate's own clock-in == clock-out on the same
 * day(s)).
 */
function findCollision(events, candidate, excludeId, now = Date.now()) {
  // Self-collision: an event's own two anchors at the same time on the same days.
  if (candidate.clockInTime === candidate.clockOutTime) {
    const selfSet = eventDaySet(candidate, candidate.clockInTime, now);
    if (selfSet.size > 0) return { selfCollision: true };
  }

  for (const ev of events) {
    if (ev.id === excludeId || !ev.enabled) continue;
    for (const candAnchor of ANCHORS) {
      const candTime = candAnchor === ANCHOR_IN ? candidate.clockInTime : candidate.clockOutTime;
      const candSet = eventDaySet(candidate, candTime, now);
      for (const evAnchor of ANCHORS) {
        const evTime = evAnchor === ANCHOR_IN ? ev.clockInTime : ev.clockOutTime;
        if (evTime !== candTime) continue;
        const evSet = eventDaySet(ev, evTime, now);
        for (const d of candSet) {
          if (evSet.has(d)) {
            return { event: ev, evAnchor, candAnchor };
          }
        }
      }
    }
  }
  return null;
}

function collisionResult(clash) {
  if (clash.selfCollision) {
    return {
      ok: false,
      error: "duplicate",
      selfCollision: true,
      message: "Clock-in and clock-out can't be the same time on the same days.",
    };
  }
  const { event, evAnchor, candAnchor } = clash;
  return {
    ok: false,
    error: "duplicate",
    collidesWith: event.id,
    collidesLabel: event.label || formatTimeOfDay(anchorTime(event, evAnchor)),
    collideAnchor: evAnchor, // which existing anchor was hit
    candidateAnchor: candAnchor, // which candidate anchor caused the hit
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
  await refreshBadge(); // §8.4 normal-state count changed
  return { ok: true, url: tab.url };
}

/** Unregister a tab and cancel all its event alarms (EV-2, EV-2a). */
async function unregisterEventTab(url) {
  const record = await getEventTab(url);
  if (record) {
    for (const ev of record.events) await disarmEvent(ev.id);
  }
  await deleteEventTab(url);
  await refreshBadge();
  return { ok: true };
}

// --- event CRUD (EV-5..EV-8a) ----------------------------------------------

function validateEventData(data) {
  if (!parseTimeOfDay(data.clockInTime)) return "Enter a valid clock-in time.";
  if (!parseTimeOfDay(data.clockOutTime)) return "Enter a valid clock-out time.";
  if (!data.oneTime && normalizeDays(data.days).length === 0) {
    return "Pick at least one day, or choose one-time.";
  }
  return null;
}

async function addEvent(url, data) {
  const record = await getEventTab(url);
  if (!record) return { ok: false, error: "This tab isn't registered for events." };
  const err = validateEventData(data);
  if (err) return { ok: false, error: err };

  const oneTime = !!data.oneTime;
  const days = oneTime ? [] : normalizeDays(data.days);
  const candidate = {
    id: null,
    clockInTime: data.clockInTime,
    clockOutTime: data.clockOutTime,
    days,
    oneTime,
    enabled: true,
  };
  const clash = findCollision(record.events, candidate, null);
  if (clash) return collisionResult(clash);

  const event = {
    id: genId(),
    label: (data.label || "").trim(),
    clockInTime: data.clockInTime,
    clockOutTime: data.clockOutTime,
    days,
    oneTime,
    enabled: true,
    lastFiredAt: { in: null, out: null },
    missed: { in: false, out: false },
    scheduledFor: { in: null, out: null },
  };
  await armEvent(event);
  record.events.push(event);
  await putEventTab(record);
  return { ok: true, id: event.id };
}

/**
 * Apply a patch (label/clockInTime/clockOutTime/days/oneTime/enabled) and
 * reschedule per EV-7 — only the changed anchors are re-armed unless recurrence
 * or enabled state changed (then both).
 */
async function updateEvent(url, id, patch) {
  const record = await getEventTab(url);
  if (!record) return { ok: false };
  const event = record.events.find((e) => e.id === id);
  if (!event) return { ok: false };
  ensureAnchorShape(event);

  const next = { ...event, ...patch };
  next.oneTime = !!next.oneTime;
  next.days = next.oneTime ? [] : normalizeDays(next.days);
  next.label = (next.label ?? "").trim();
  const err = validateEventData(next);
  if (err) return { ok: false, error: err };
  if (next.enabled) {
    const clash = findCollision(record.events, next, id);
    if (clash) return collisionResult(clash);
  }

  const inChanged = event.clockInTime !== next.clockInTime;
  const outChanged = event.clockOutTime !== next.clockOutTime;
  const recurrenceChanged =
    event.oneTime !== next.oneTime ||
    event.days.length !== next.days.length ||
    event.days.some((d, i) => d !== next.days[i]);
  const wasEnabled = event.enabled;
  const willBeEnabled = next.enabled;

  // Edits clear missed state and (for changed/recurrence anchors) lastFiredAt:
  // the schedule moved, so any prior firing isn't "this occurrence" anymore.
  next.missed = { in: false, out: false };
  next.lastFiredAt = {
    in: inChanged || recurrenceChanged ? null : event.lastFiredAt.in,
    out: outChanged || recurrenceChanged ? null : event.lastFiredAt.out,
  };
  next.scheduledFor = { in: null, out: null }; // armAnchor below will fill

  Object.assign(event, next);

  if (!willBeEnabled) {
    await disarmEvent(event.id);
    event.scheduledFor = { in: null, out: null };
  } else if (wasEnabled !== willBeEnabled || recurrenceChanged) {
    await armEvent(event); // re-arm both
  } else {
    if (inChanged) await armAnchor(event, ANCHOR_IN);
    if (outChanged) await armAnchor(event, ANCHOR_OUT);
    // If neither changed, leave the existing alarms alone (label-only edits).
  }
  await putEventTab(record);
  return { ok: true };
}

async function deleteEvent(url, id) {
  const record = await getEventTab(url);
  if (!record) return { ok: false };
  const idx = record.events.findIndex((e) => e.id === id);
  if (idx === -1) return { ok: false };
  record.events.splice(idx, 1);
  await disarmEvent(id);
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

// --- firing & notifications (EV-11..EV-15, EV-21..EV-24) -------------------

/** Wrap the callback-style getPermissionLevel; defaults to 'granted' on error. */
function getNotificationPermLevel() {
  return new Promise((resolve) => {
    try {
      chrome.notifications.getPermissionLevel((lvl) => resolve(lvl || "granted"));
    } catch {
      resolve("granted");
    }
  });
}

/**
 * Fire one anchor's notification through the same path used for real fires,
 * tests, and snoozes. Implements EV-21 (skip when OS perm is denied),
 * EV-23 (pending→delivered/muted-perm/create-failed fire-log entries), and
 * EV-24 (schedule a 30s unack alarm on delivery). Returns the notif id on
 * delivery, or null when skipped/failed.
 *
 * `opts`:
 *   - test:  marks the fire-log entry as a test (EV-22)
 *   - snooze: marks the entry as a snooze re-fire (so the log distinguishes it)
 */
async function showEventNotification(url, record, event, anchor, opts = {}) {
  const logId = `flog-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const when = formatTimeOfDay(anchorTime(event, anchor));
  const baseEntry = {
    id: logId,
    ts: Date.now(),
    eventId: event.id,
    anchor,
    label: event.label || when,
    time: anchorTime(event, anchor),
    tabTitle: record.title || url,
    test: !!opts.test,
    snooze: !!opts.snooze,
    status: FIRE_STATUS.PENDING,
  };
  await appendFireLog(baseEntry);

  // EV-21: skip create when the OS has denied notifications. The badge's
  // muted state surfaces the condition; refreshBadge runs below.
  const permLevel = await getNotificationPermLevel();
  if (permLevel === "denied") {
    await updateFireLog(logId, { status: FIRE_STATUS.MUTED_PERM });
    await refreshBadge();
    return null;
  }

  const keep = await getKeepAlertsOnScreen();
  const notifId = `${EVENT_NOTIF_PREFIX}${event.id}:${anchor}:${Date.now()}`;
  await putNotif(notifId, { kind: "event", url, eventId: event.id, anchor, logId });
  const action = anchorActionLabel(anchor); // "Clock in" or "Clock out"
  const titlePrefix = opts.test ? "[Test] " : "";
  const title = event.label
    ? `${titlePrefix}${action} — ${event.label}`
    : `${titlePrefix}${action} at ${when}`;

  try {
    await chrome.notifications.create(notifId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message: `${record.title || url}\n${when}`,
      buttons: [{ title: "Jump to tab" }, { title: "Snooze" }],
      silent: true, // §8.3 — visual only
      requireInteraction: keep, // §8.2 keepAlertsOnScreen
      priority: keep ? 2 : 0,
    });
    await updateFireLog(logId, { status: FIRE_STATUS.DELIVERED });
    // EV-24: schedule an unack alarm; user interaction clears it below.
    await chrome.alarms.create(`${UNACK_ALARM_PREFIX}${notifId}`, {
      delayInMinutes: UNACK_WINDOW_MINUTES,
    });
    return notifId;
  } catch (e) {
    await updateFireLog(logId, {
      status: FIRE_STATUS.CREATE_FAILED,
      error: String(e?.message || e),
    });
    await deleteNotif(notifId);
    await refreshBadge();
    return null;
  }
}

/** Drop the unack alarm + unacked entry for a notif the user just handled. */
async function clearUnackFor(notifId) {
  await chrome.alarms.clear(`${UNACK_ALARM_PREFIX}${notifId}`);
  await removeUnackedFiring(notifId);
  await refreshBadge();
}

/** Unack alarm elapsed → if the notif is still pending in the session, record it. */
async function handleUnackFire(notifId) {
  const info = await getNotif(notifId);
  if (!info) return; // already acked: notif map entry was deleted
  if (info.kind !== "event") return; // confirm/unrelated → ignore
  await addUnackedFiring({
    notifId,
    eventId: info.eventId,
    anchor: info.anchor,
    ts: Date.now(),
  });
  await refreshBadge();
}

/** EV-22: fire a sample alert through the production path against the current tab. */
async function sendTestNotification() {
  const tab = await getCurrentTab();
  const url = tab?.url || "about:blank";
  const record = { title: tab?.title || "Test", url };
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const synthetic = {
    id: `test-${Date.now()}`,
    label: "Test notification",
    clockInTime: `${hh}:${mm}`,
    clockOutTime: `${hh}:${mm}`,
  };
  const notifId = await showEventNotification(url, record, synthetic, ANCHOR_IN, { test: true });
  const permLevel = await getNotificationPermLevel();
  return { ok: true, delivered: notifId != null, permLevel };
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

/**
 * Open the DMP analyzer ready-to-upload, or focus it if already open (DMP §7.8).
 * Find-and-focus uses the existing `tabs` permission — no new perms. We can't
 * guarantee the OS file dialog auto-opens (the command's user activation doesn't
 * carry across the tab open), so we land the user on the page with the upload
 * control focused; an `?focus=1` hint tells the page to do that and, when it's
 * already the active tab, to invoke the picker directly.
 */
async function openAnalyzer() {
  const base = chrome.runtime.getURL(ANALYZER_PAGE);
  const all = await chrome.tabs.query({});
  const matches = all.filter((t) => typeof t.url === "string" && t.url.startsWith(base));
  if (matches.length > 0) {
    matches.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    const target = matches[0];
    if (target.id != null) {
      await chrome.tabs.update(target.id, { active: true });
      // Nudge an already-open analyzer to focus its upload control / picker.
      chrome.tabs.sendMessage(target.id, { type: "analyzer:focus-upload" }).catch(() => {});
    }
    await chrome.windows.update(target.windowId, { focused: true }).catch(() => {});
  } else {
    await chrome.tabs.create({ url: `${base}?focus=1` });
  }
}

/** Defer a fired anchor's reminder by the configured N minutes (EV-13a). */
async function snoozeEvent(url, eventId, anchor) {
  const minutes = clampSnooze(await getSnoozeMinutes());
  const alarmName = `${SNOOZE_ALARM_PREFIX}${eventId}:${anchor}:${Date.now()}`;
  await putSnooze(alarmName, { url, eventId, anchor });
  await chrome.alarms.create(alarmName, { delayInMinutes: minutes });
}

/** Core fire for one anchor: alert, then reschedule or resolve. */
async function fireEvent(eventId, anchor) {
  const located = await findEvent(eventId);
  if (!located) {
    await chrome.alarms.clear(eventAlarmName(eventId, anchor));
    return;
  }
  const { url, record, event } = located;
  if (!event.enabled) return;
  ensureAnchorShape(event);

  await showEventNotification(url, record, event, anchor);
  event.lastFiredAt[anchor] = Date.now();
  event.scheduledFor[anchor] = null;

  if (event.oneTime) {
    // EV-8a: auto-disable when both anchors are resolved (fired or missed).
    if (anchorResolved(event, ANCHOR_IN) && anchorResolved(event, ANCHOR_OUT)) {
      event.enabled = false;
    }
  } else {
    // EV-15: schedule this anchor's next occurrence.
    await armAnchor(event, anchor);
  }
  await putEventTab(record);
}

/** A snooze alarm elapsed — re-show the same anchor's alert if still resolvable. */
async function fireSnooze(alarmName) {
  const info = await getSnooze(alarmName);
  await deleteSnooze(alarmName);
  if (!info) return;
  const located = await findEvent(info.eventId);
  if (located) {
    await showEventNotification(
      located.url,
      located.record,
      located.event,
      info.anchor || ANCHOR_IN,
      { snooze: true },
    );
  }
}

// --- reconciliation on startup / install (§9.6, EV-16, EV-18) --------------

async function reconcileEvents() {
  // Drop every event, snooze, and unack alarm, then re-arm enabled anchors
  // from scratch. Snoozes and unack timers are intentionally not restored
  // (EV-13a, EV-18, EV-24 — the unack window is a per-fire follow-up only).
  const alarms = await chrome.alarms.getAll();
  await Promise.all(
    alarms
      .filter(
        (a) =>
          parseEventAlarmName(a.name) !== null ||
          isSnoozeAlarmName(a.name) ||
          isUnackAlarmName(a.name),
      )
      .map((a) => chrome.alarms.clear(a.name)),
  );
  // Unacked-firings list is also a per-session signal — drop it on launch.
  await clearUnackedFirings();

  const now = Date.now();
  const tabs = await getEventTabs();
  for (const url of Object.keys(tabs)) {
    const record = tabs[url];
    let changed = false;

    // Defensive: drop legacy/invalid events missing both required times.
    const valid = record.events.filter((e) => e.clockInTime && e.clockOutTime);
    if (valid.length !== record.events.length) {
      record.events = valid;
      changed = true;
    }

    for (const event of record.events) {
      ensureAnchorShape(event);

      if (!event.enabled) {
        for (const a of ANCHORS) {
          if (event.scheduledFor[a] != null) {
            event.scheduledFor[a] = null;
            changed = true;
          }
        }
        continue;
      }

      for (const anchor of ANCHORS) {
        if (event.oneTime) {
          if (anchorResolved(event, anchor)) {
            event.scheduledFor[anchor] = null;
            continue;
          }
          // For one-time, prefer the stored armed time; if absent, compute now.
          if (event.scheduledFor[anchor] == null) {
            event.scheduledFor[anchor] = computeNextOccurrence(
              anchorTime(event, anchor),
              event.days,
              true,
              now,
            );
            changed = true;
          }
          if (event.scheduledFor[anchor] != null && event.scheduledFor[anchor] <= now) {
            // Missed while the browser was closed (EV-18).
            event.missed[anchor] = true;
            event.scheduledFor[anchor] = null;
            changed = true;
          } else if (event.scheduledFor[anchor] != null) {
            await chrome.alarms.create(eventAlarmName(event.id, anchor), {
              when: event.scheduledFor[anchor],
            });
          }
        } else {
          // Recurring: always re-arm to the next future occurrence.
          const prev = event.scheduledFor[anchor];
          await armAnchor(event, anchor, now);
          if (event.scheduledFor[anchor] !== prev) changed = true;
        }
      }

      // EV-8a: a one-time event whose both anchors are now resolved → disable.
      if (
        event.oneTime &&
        anchorResolved(event, ANCHOR_IN) &&
        anchorResolved(event, ANCHOR_OUT) &&
        event.enabled
      ) {
        event.enabled = false;
        changed = true;
      }
    }
    if (changed) await putEventTab(record);
  }
}

// --- popup / options state -------------------------------------------------

/** Decorate a stored event with live next-fire info for display. */
async function toEventView(event) {
  ensureAnchorShape(event);
  const scheduledFor = { in: null, out: null };
  if (event.enabled) {
    for (const anchor of ANCHORS) {
      const alarm = await chrome.alarms.get(eventAlarmName(event.id, anchor));
      scheduledFor[anchor] = alarm
        ? alarm.scheduledTime
        : (event.scheduledFor[anchor] ?? null);
    }
  }
  // The next imminent anchor — drives the row's "next in/out today" text.
  let nextFireAt = null;
  let nextFireAnchor = null;
  for (const anchor of ANCHORS) {
    const t = scheduledFor[anchor];
    if (t != null && (nextFireAt == null || t < nextFireAt)) {
      nextFireAt = t;
      nextFireAnchor = anchor;
    }
  }
  return {
    id: event.id,
    label: event.label,
    clockInTime: event.clockInTime,
    clockOutTime: event.clockOutTime,
    days: event.days,
    oneTime: event.oneTime,
    enabled: event.enabled,
    missed: { in: !!event.missed.in, out: !!event.missed.out },
    lastFiredAt: { in: event.lastFiredAt.in, out: event.lastFiredAt.out },
    scheduledFor,
    nextFireAt,
    nextFireAnchor,
  };
}

/**
 * Earliest upcoming firing across all of a tab's events — drives the global
 * roster's "next: today 12:00 — clock out" sub-line (EV-19).
 */
function tabNextFiring(events) {
  let best = null;
  for (const ev of events) {
    if (!ev.enabled) continue;
    for (const anchor of ANCHORS) {
      const t = ev.scheduledFor?.[anchor];
      if (t == null) continue;
      if (best == null || t < best.at) {
        best = {
          at: t,
          anchor,
          eventId: ev.id,
          label: ev.label,
          time: anchorTime(ev, anchor),
        };
      }
    }
  }
  return best;
}

/** Global roster row for one event tab (EV-19). */
async function rosterRow(url, record, openTabsByUrl) {
  const openTab = openTabsByUrl.get(url);
  const events = record.events;
  const enabledCount = events.filter((e) => e.enabled).length;
  return {
    url,
    title: record.title || url,
    favIconUrl: openTab?.favIconUrl || null,
    isOpen: !!openTab,
    eventCount: events.length,
    enabledCount,
    next: tabNextFiring(events),
  };
}

/** Events state for the popup: roster, current tab, perm, log, unacked. */
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

  // EV-19: global roster of every event tab — needs each tab's events shape
  // with `scheduledFor` populated, so reuse the stored records (the `next`
  // computation only looks at `scheduledFor`/`enabled`, no alarm read needed).
  const tabs = await getEventTabs();
  const openTabs = await chrome.tabs.query({});
  const openByUrl = new Map();
  for (const t of openTabs) if (t.url) openByUrl.set(t.url, t);
  const roster = [];
  for (const url of Object.keys(tabs)) {
    roster.push(await rosterRow(url, tabs[url], openByUrl));
  }
  roster.sort((a, b) => (a.title || "").localeCompare(b.title || ""));

  const permLevel = await getNotificationPermLevel();
  const fireLog = await getRecentFireLog();
  const unacked = await getUnackedFirings();

  return {
    current: current
      ? { ...current, isEventTab: !!record, eventCount: record ? record.events.length : 0 }
      : null,
    events,
    roster,
    permLevel,
    fireLog,
    unackedCount: unacked.length,
  };
}

/** Recent activity for the popup: last 24h capped at FIRE_LOG_DISPLAY_MAX (EV-23). */
async function getRecentFireLog() {
  const log = await getFireLog();
  const cutoff = Date.now() - FIRE_LOG_TTL_MS;
  const fresh = log.filter((e) => e?.ts >= cutoff);
  fresh.sort((a, b) => b.ts - a.ts);
  return fresh.slice(0, FIRE_LOG_DISPLAY_MAX);
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

    // --- EV-19/22/24: roster jump, test alert, popup-clears-unacked ---
    case "jumpToEventTab":
      await jumpToUrl(msg.url);
      return { ok: true };
    case "sendTestNotification":
      return sendTestNotification();
    case "popupOpened":
      // EV-24: opening the popup acknowledges any unacked fires.
      await clearUnackedFirings();
      await refreshBadge();
      return { ok: true };

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

// Core refresh / skip logic (FR-9..FR-12), plus event/snooze/unack firing (§9.4).
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Catch any worker-error so a single failure doesn't kill subsequent fires
  // (EV-23: `worker-error` status). Per-alarm branches still log their own
  // delivery status; this is a safety net only.
  try {
    const parsed = parseEventAlarmName(alarm.name);
    if (parsed !== null) {
      await fireEvent(parsed.id, parsed.anchor);
      return;
    }
    if (isSnoozeAlarmName(alarm.name)) {
      await fireSnooze(alarm.name);
      return;
    }
    if (isUnackAlarmName(alarm.name)) {
      const notifId = alarm.name.slice(UNACK_ALARM_PREFIX.length);
      await handleUnackFire(notifId);
      return;
    }
  } catch (e) {
    await appendFireLog({
      id: `flog-err-${Date.now().toString(36)}`,
      ts: Date.now(),
      status: FIRE_STATUS.WORKER_ERROR,
      error: String(e?.message || e),
      alarmName: alarm.name,
    }).catch(() => {});
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
    return;
  }
  if (command === ANALYZER_COMMAND) {
    await openAnalyzer(); // DMP §7.8
  }
});

// Notification actions: Jump / Snooze for alerts (EV-12, EV-13a), Remove /
// Cancel for the unregister confirm (EV-2a). Dismissal is the Ignore path (EV-13).
chrome.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
  const info = await getNotif(notifId);
  if (!info) return;
  if (info.kind === "event") {
    if (btnIdx === 0) await jumpToUrl(info.url);
    else if (btnIdx === 1) await snoozeEvent(info.url, info.eventId, info.anchor || ANCHOR_IN);
    await clearUnackFor(notifId); // EV-24: user acted within the 30s window
  } else if (info.kind === "confirm" && btnIdx === 0) {
    await unregisterEventTab(info.url);
  }
  await deleteNotif(notifId);
  await chrome.notifications.clear(notifId);
});

chrome.notifications.onClicked.addListener(async (notifId) => {
  const info = await getNotif(notifId);
  if (!info) return;
  if (info.kind === "event") {
    await jumpToUrl(info.url); // clicking the body = Jump
    await clearUnackFor(notifId);
  }
  await deleteNotif(notifId);
  await chrome.notifications.clear(notifId);
});

// Dismissing an alert is Ignore (EV-13); for a confirm it's Cancel. Either way
// just drop the mapping — the action (if any) already ran above. EV-24:
// dismissing also acks the fire, so clear the unack alarm/entry.
chrome.notifications.onClosed.addListener(async (notifId) => {
  const info = await getNotif(notifId);
  if (info?.kind === "event") await clearUnackFor(notifId);
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
