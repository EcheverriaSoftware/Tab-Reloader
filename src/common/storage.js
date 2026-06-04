// Thin wrappers over chrome.storage with the project's split persistence model
// (§9.3):
//   - chrome.storage.session : the active reload list. Survives service-worker
//     suspension within a session, cleared on browser close (FR-14).
//   - chrome.storage.sync     : the persistent default interval + prefs (FR-13),
//     with a graceful fallback to chrome.storage.local if sync is unavailable.

import {
  DEFAULT_INTERVAL_KEY,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_SNOOZE_MINUTES,
  EVENT_TAB_PREFIX,
  KEEP_ALERTS_KEY,
  LAST_USED_INTERVAL_KEY,
  NOTIF_MAP_KEY,
  SESSION_LIST_KEY,
  SHOW_BADGE_KEY,
  SNOOZE_MAP_KEY,
  SNOOZE_MINUTES_KEY,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Persistent preferences (chrome.storage.sync, falling back to local).
// ---------------------------------------------------------------------------

/** Returns the sync area, or local if sync isn't present in this browser. */
function prefArea() {
  return chrome.storage.sync ?? chrome.storage.local;
}

async function getPref(key, fallback) {
  try {
    const res = await prefArea().get(key);
    return key in res ? res[key] : fallback;
  } catch {
    // If sync errors (e.g. quota / disabled), fall back to local.
    try {
      const res = await chrome.storage.local.get(key);
      return key in res ? res[key] : fallback;
    } catch {
      return fallback;
    }
  }
}

async function setPref(key, value) {
  try {
    await prefArea().set({ [key]: value });
  } catch {
    await chrome.storage.local.set({ [key]: value });
  }
}

export async function getDefaultInterval() {
  return getPref(DEFAULT_INTERVAL_KEY, DEFAULT_INTERVAL_MINUTES);
}

export async function setDefaultInterval(minutes) {
  await setPref(DEFAULT_INTERVAL_KEY, minutes);
}

export async function getShowBadge() {
  return getPref(SHOW_BADGE_KEY, true);
}

export async function setShowBadge(value) {
  await setPref(SHOW_BADGE_KEY, !!value);
}

export async function getLastUsedInterval() {
  return getPref(LAST_USED_INTERVAL_KEY, null);
}

export async function setLastUsedInterval(minutes) {
  await setPref(LAST_USED_INTERVAL_KEY, minutes);
}

// Events prefs (EV-13a, §8.2). Stored alongside the reloader's synced prefs.
export async function getSnoozeMinutes() {
  return getPref(SNOOZE_MINUTES_KEY, DEFAULT_SNOOZE_MINUTES);
}

export async function setSnoozeMinutes(minutes) {
  await setPref(SNOOZE_MINUTES_KEY, minutes);
}

export async function getKeepAlertsOnScreen() {
  return getPref(KEEP_ALERTS_KEY, true);
}

export async function setKeepAlertsOnScreen(value) {
  await setPref(KEEP_ALERTS_KEY, !!value);
}

// ---------------------------------------------------------------------------
// Event tabs (persistent — §9.3). One storage item per event tab, keyed by URL
// as `eventtab:<url>`, so each item stays small under the sync per-item quota.
// Items live in sync (with device sync, EV-17); a write that exceeds the sync
// quota falls back to local for that one tab. Reads merge both areas with the
// local copy winning, since that's the fallback location.
//
// Record shape (§9.3, extended with `scheduledFor` for armed next-occurrence):
//   { url, title, addedAt, events: [Event] }
//   Event = { id, label, time:"HH:MM", days:number[], oneTime, enabled,
//             lastFiredAt:number|null, missed:boolean, scheduledFor:number|null }
// ---------------------------------------------------------------------------

function eventTabKey(url) {
  return `${EVENT_TAB_PREFIX}${url}`;
}

async function readAll(area) {
  try {
    return await area.get(null);
  } catch {
    return {};
  }
}

/** All event tabs as { [url]: record }. */
export async function getEventTabs() {
  const out = {};
  const sync = chrome.storage.sync ? await readAll(chrome.storage.sync) : {};
  const local = await readAll(chrome.storage.local);
  for (const [k, v] of Object.entries(sync)) {
    if (k.startsWith(EVENT_TAB_PREFIX) && v?.url) out[v.url] = v;
  }
  // Local copies are the per-item fallback for oversized tabs — they win.
  for (const [k, v] of Object.entries(local)) {
    if (k.startsWith(EVENT_TAB_PREFIX) && v?.url) out[v.url] = v;
  }
  return out;
}

export async function getEventTab(url) {
  const key = eventTabKey(url);
  const local = await chrome.storage.local.get(key).catch(() => ({}));
  if (key in local) return local[key];
  if (chrome.storage.sync) {
    const sync = await chrome.storage.sync.get(key).catch(() => ({}));
    if (key in sync) return sync[key];
  }
  return null;
}

export async function putEventTab(record) {
  const key = eventTabKey(record.url);
  if (chrome.storage.sync) {
    try {
      await chrome.storage.sync.set({ [key]: record });
      // Drop any stale local fallback copy for this tab.
      await chrome.storage.local.remove(key).catch(() => {});
      return;
    } catch {
      // Sync quota exceeded / unavailable — fall back to local for this item.
    }
  }
  await chrome.storage.local.set({ [key]: record });
}

export async function deleteEventTab(url) {
  const key = eventTabKey(url);
  await Promise.allSettled([
    chrome.storage.sync?.remove(key),
    chrome.storage.local.remove(key),
  ]);
}

// ---------------------------------------------------------------------------
// Ephemeral notification / snooze bookkeeping (chrome.storage.session).
//
// A notification id maps to the firing event so a later click/dismiss — which
// may arrive after the worker was suspended — can resolve the right event/URL.
// Snooze entries map a one-off snooze alarm to its event. Both are session-only
// and intentionally not restored on restart (EV-18, EV-13a).
// ---------------------------------------------------------------------------

async function getSessionMap(key) {
  const res = await chrome.storage.session.get(key).catch(() => ({}));
  return res[key] ?? {};
}

async function setSessionMapEntry(mapKey, entryKey, value) {
  const map = await getSessionMap(mapKey);
  map[entryKey] = value;
  await chrome.storage.session.set({ [mapKey]: map });
}

async function deleteSessionMapEntry(mapKey, entryKey) {
  const map = await getSessionMap(mapKey);
  if (entryKey in map) {
    delete map[entryKey];
    await chrome.storage.session.set({ [mapKey]: map });
  }
}

export async function putNotif(notifId, info) {
  await setSessionMapEntry(NOTIF_MAP_KEY, notifId, info);
}
export async function getNotif(notifId) {
  return (await getSessionMap(NOTIF_MAP_KEY))[notifId] ?? null;
}
export async function deleteNotif(notifId) {
  await deleteSessionMapEntry(NOTIF_MAP_KEY, notifId);
}

export async function putSnooze(alarmName, info) {
  await setSessionMapEntry(SNOOZE_MAP_KEY, alarmName, info);
}
export async function getSnooze(alarmName) {
  return (await getSessionMap(SNOOZE_MAP_KEY))[alarmName] ?? null;
}
export async function deleteSnooze(alarmName) {
  await deleteSessionMapEntry(SNOOZE_MAP_KEY, alarmName);
}

// ---------------------------------------------------------------------------
// Active reload list (chrome.storage.session).
//
// Shape: { [tabId: string]: TabEntry }
//   TabEntry = {
//     tabId:           number
//     overrideMinutes: number | null   // per-tab override, null => use default
//     paused:          boolean
//     url:             string          // last known URL (for manual-reload detection)
//     addedAt:         number          // epoch ms
//   }
// The *effective* interval is overrideMinutes ?? defaultInterval.
// ---------------------------------------------------------------------------

export async function getList() {
  const res = await chrome.storage.session.get(SESSION_LIST_KEY);
  return res[SESSION_LIST_KEY] ?? {};
}

export async function setList(list) {
  await chrome.storage.session.set({ [SESSION_LIST_KEY]: list });
}

export async function getEntry(tabId) {
  const list = await getList();
  return list[String(tabId)] ?? null;
}

export async function putEntry(entry) {
  const list = await getList();
  list[String(entry.tabId)] = entry;
  await setList(list);
}

export async function deleteEntry(tabId) {
  const list = await getList();
  const key = String(tabId);
  if (key in list) {
    delete list[key];
    await setList(list);
    return true;
  }
  return false;
}
