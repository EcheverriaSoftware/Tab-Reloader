// Shared constants and small pure helpers used across the service worker,
// popup, and options page. No chrome.* access here so it can be imported
// anywhere safely.

/** Default global interval on first install, in minutes (FR-5). */
export const DEFAULT_INTERVAL_MINUTES = 20;

/**
 * Minimum interval, in minutes. The chrome.alarms API enforces a ~1 minute
 * floor on periodInMinutes in production builds, so this is the hard floor
 * (FR-8a, §9.2).
 */
export const MIN_INTERVAL_MINUTES = 1;

/** Maximum interval, in minutes (24h). Open question #5 — bound the high end. */
export const MAX_INTERVAL_MINUTES = 1440;

// Storage keys.
export const SESSION_LIST_KEY = "reloadList"; // chrome.storage.session
export const DEFAULT_INTERVAL_KEY = "defaultIntervalMinutes"; // chrome.storage.sync
export const SHOW_BADGE_KEY = "showBadge"; // chrome.storage.sync
export const LAST_USED_INTERVAL_KEY = "lastUsedIntervalMinutes"; // chrome.storage.sync

export const ALARM_PREFIX = "reload-tab-";

/** Build the alarm name for a given tab id. */
export function alarmNameForTab(tabId) {
  return `${ALARM_PREFIX}${tabId}`;
}

/** Parse a tab id out of an alarm name, or null if it isn't ours. */
export function tabIdFromAlarmName(name) {
  if (!name || !name.startsWith(ALARM_PREFIX)) return null;
  const id = Number.parseInt(name.slice(ALARM_PREFIX.length), 10);
  return Number.isNaN(id) ? null : id;
}

/**
 * Clamp a requested interval into the allowed range.
 * Returns { value, clamped } where `clamped` is true if the input was out of
 * range and adjusted (so callers can surface it to the user — FR-8a).
 * Non-numeric / empty input falls back to the supplied default.
 */
export function clampInterval(input, fallback = DEFAULT_INTERVAL_MINUTES) {
  let n = typeof input === "number" ? input : Number.parseFloat(input);
  if (!Number.isFinite(n)) {
    return { value: fallback, clamped: false, invalid: true };
  }
  // Whole minutes only.
  n = Math.round(n);
  if (n < MIN_INTERVAL_MINUTES) return { value: MIN_INTERVAL_MINUTES, clamped: true };
  if (n > MAX_INTERVAL_MINUTES) return { value: MAX_INTERVAL_MINUTES, clamped: true };
  return { value: n, clamped: false };
}
