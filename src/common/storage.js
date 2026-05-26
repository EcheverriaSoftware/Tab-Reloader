// Thin wrappers over chrome.storage with the project's split persistence model
// (§9.3):
//   - chrome.storage.session : the active reload list. Survives service-worker
//     suspension within a session, cleared on browser close (FR-14).
//   - chrome.storage.sync     : the persistent default interval + prefs (FR-13),
//     with a graceful fallback to chrome.storage.local if sync is unavailable.

import {
  DEFAULT_INTERVAL_KEY,
  DEFAULT_INTERVAL_MINUTES,
  LAST_USED_INTERVAL_KEY,
  SESSION_LIST_KEY,
  SHOW_BADGE_KEY,
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
