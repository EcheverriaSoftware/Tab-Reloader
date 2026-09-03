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

// Command names (manifest `commands`).
export const RELOAD_COMMAND = "toggle-current-tab";
export const EVENTS_COMMAND = "toggle-events-tab"; // EV-10
export const ANALYZER_COMMAND = "open-dmp-analyzer"; // DMP §7.8 (Alt+Shift+D)

/** Extension-relative path to the DMP analyzer page (DMP §7.8). */
export const ANALYZER_PAGE = "src/analyzer/analyzer.html";

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

// ===========================================================================
// Events feature (see docs/EVENTS_PRD.md). Time-of-day notifications attached
// to a tab, identified by URL, persisted across sessions.
// ===========================================================================

// Storage.
export const EVENT_TAB_PREFIX = "eventtab:"; // one storage item per event tab (§9.3)
export const SNOOZE_MINUTES_KEY = "snoozeMinutes"; // chrome.storage.sync (EV-13a)
export const KEEP_ALERTS_KEY = "keepAlertsOnScreen"; // chrome.storage.sync (§8.2)
export const NOTIF_MAP_KEY = "eventNotifMap"; // chrome.storage.session
export const SNOOZE_MAP_KEY = "eventSnoozeMap"; // chrome.storage.session

// Alarm / notification name prefixes (kept distinct from the reloader's).
export const EVENT_ALARM_PREFIX = "event-"; // §9.4
export const SNOOZE_ALARM_PREFIX = "snooze-";
export const EVENT_NOTIF_PREFIX = "evnotif-";
export const CONFIRM_NOTIF_PREFIX = "evconfirm-";

// Snooze duration ("remind me in N minutes"), bounded to a sane range (EV-13a).
export const DEFAULT_SNOOZE_MINUTES = 5;
export const MIN_SNOOZE_MINUTES = 1;
export const MAX_SNOOZE_MINUTES = 120;

const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// An event has two independently-scheduled anchors (§5, §9.4).
export const ANCHORS = ["in", "out"];
export const ANCHOR_IN = "in";
export const ANCHOR_OUT = "out";

/** Storage field name on the event record for an anchor's time-of-day. */
export function anchorTimeField(anchor) {
  return anchor === ANCHOR_IN ? "clockInTime" : "clockOutTime";
}

/** "Clock in" / "Clock out" — used in notification titles (EV-11). */
export function anchorActionLabel(anchor) {
  return anchor === ANCHOR_IN ? "Clock in" : "Clock out";
}

/** Build the alarm name for an event/anchor pair (§9.4: `event-<id>-in|out`). */
export function eventAlarmName(id, anchor) {
  return `${EVENT_ALARM_PREFIX}${id}-${anchor}`;
}

/**
 * Parse an event alarm name into `{ id, anchor }`, or null if it isn't ours.
 * The id can contain dashes (uuids do), so we split on the final dash.
 */
export function parseEventAlarmName(name) {
  if (!name || !name.startsWith(EVENT_ALARM_PREFIX)) return null;
  const rest = name.slice(EVENT_ALARM_PREFIX.length);
  const lastDash = rest.lastIndexOf("-");
  if (lastDash < 1) return null;
  const anchor = rest.slice(lastDash + 1);
  if (anchor !== ANCHOR_IN && anchor !== ANCHOR_OUT) return null;
  return { id: rest.slice(0, lastDash), anchor };
}

export function isSnoozeAlarmName(name) {
  return !!name && name.startsWith(SNOOZE_ALARM_PREFIX);
}

/** A stable id for a new event. */
export function genId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Parse "HH:MM" (24h) into {h, m}, or null if malformed/out of range. */
export function parseTimeOfDay(time) {
  if (typeof time !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}

/** Format "HH:MM" for display in the user's locale (e.g. "12:00 PM"). */
export function formatTimeOfDay(time) {
  const p = parseTimeOfDay(time);
  if (!p) return time;
  const d = new Date();
  d.setHours(p.h, p.m, 0, 0);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Coerce arbitrary input into a sorted, de-duped set of weekday ints (0..6). */
export function normalizeDays(days) {
  if (!Array.isArray(days)) return [];
  const set = new Set();
  for (const d of days) {
    const n = Number(d);
    if (Number.isInteger(n) && n >= 0 && n <= 6) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/** Human recurrence summary for a weekday set (§8.1): "Daily", "Weekdays", … */
export function daysSummary(days) {
  const d = normalizeDays(days);
  if (d.length === 0) return "";
  if (d.length === 7) return "Daily";
  if (d.length === 5 && [1, 2, 3, 4, 5].every((x) => d.includes(x))) return "Weekdays";
  if (d.length === 2 && d.includes(0) && d.includes(6)) return "Weekends";
  return d.map((x) => DAY_ABBR[x]).join(", ");
}

/**
 * Soonest future timestamp (epoch ms) matching an event's time + recurrence in
 * local time, strictly after `now` (§9.4). Returns null if unschedulable
 * (bad time, or recurring with no days).
 *   - one-time: today at HH:MM if still ahead, else tomorrow.
 *   - recurring: next of the selected weekdays at HH:MM.
 */
export function computeNextOccurrence(time, days, oneTime, now = Date.now()) {
  const parsed = parseTimeOfDay(time);
  if (!parsed) return null;
  const { h, m } = parsed;

  if (oneTime) {
    const c = new Date(now);
    c.setHours(h, m, 0, 0);
    if (c.getTime() <= now) c.setDate(c.getDate() + 1);
    return c.getTime();
  }

  const set = normalizeDays(days);
  if (set.length === 0) return null;
  // Scan up to 8 days out so we always cross a matching weekday.
  for (let offset = 0; offset < 8; offset++) {
    const c = new Date(now);
    c.setDate(c.getDate() + offset);
    c.setHours(h, m, 0, 0);
    if (set.includes(c.getDay()) && c.getTime() > now) return c.getTime();
  }
  return null;
}

/** "today" / "tomorrow" / a short weekday name for a future timestamp. */
export function relativeDay(ts) {
  const startOf = (t) => {
    const x = new Date(t);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  };
  const days = Math.round((startOf(ts) - startOf(Date.now())) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return new Date(ts).toLocaleDateString([], { weekday: "short" });
}

/**
 * Compact "Out 12:00 PM · In 12:30 PM" string for a list row's times (§8.1).
 * Clock-out is shown first to match the form field order — for the primary
 * break/lunch case the user leaves work (clock-out) before returning (clock-in).
 */
export function eventTimesText(ev) {
  return `Out ${formatTimeOfDay(ev.clockOutTime)} · In ${formatTimeOfDay(ev.clockInTime)}`;
}

/**
 * One-line schedule summary for an event view in a list row (§8.1): the times
 * (when a label takes the title slot), recurrence, and either its state or the
 * next imminent anchor.
 */
export function eventScheduleText(ev) {
  const bits = [];
  if (ev.label) bits.push(eventTimesText(ev)); // else the times are the title
  bits.push(ev.oneTime ? "Once" : daysSummary(ev.days));
  const missed = ev.missed || {};
  if (!ev.enabled) {
    if (ev.oneTime && (missed.in || missed.out)) {
      bits.push(missed.in && missed.out ? "missed" : `missed ${missed.in ? "in" : "out"}`);
    } else {
      bits.push("disabled");
    }
  } else if (ev.nextFireAt && ev.nextFireAnchor) {
    bits.push(`next ${ev.nextFireAnchor} ${relativeDay(ev.nextFireAt)}`);
  }
  return bits.filter(Boolean).join(" · ");
}

/**
 * Clamp a snooze duration into [MIN, MAX] minutes (whole minutes), falling back
 * to `fallback` for non-numeric input.
 */
export function clampSnooze(input, fallback = DEFAULT_SNOOZE_MINUTES) {
  let n = typeof input === "number" ? input : Number.parseFloat(input);
  if (!Number.isFinite(n)) return fallback;
  n = Math.round(n);
  if (n < MIN_SNOOZE_MINUTES) return MIN_SNOOZE_MINUTES;
  if (n > MAX_SNOOZE_MINUTES) return MAX_SNOOZE_MINUTES;
  return n;
}

// ===========================================================================
// Auto-reload rules (PRD §6.1.1)
//
// A rule is the user saying "this site, always": any tab whose URL matches an
// enabled rule joins the reload list on its own, with no shortcut press and no
// popup visit. Rules persist across sessions; the reload list does not — rules
// are what rebuild it each morning.
//
// Pattern syntax is deliberately tiny: a host with an optional `*.` subdomain
// wildcard, plus an optional path prefix — `portal.example.com`,
// `*.example.com`, `example.com/admin/*`. No regex, and query strings never
// participate (open question #7 — both deferred past v1).
// ===========================================================================

/** Persistent rule list (chrome.storage.sync, falling back to local). */
export const RULES_KEY = "autoReloadRules";

/**
 * Tabs the user took off the list, excused from re-enrollment for the rest of
 * the session (chrome.storage.session) so a rule can never immediately re-add
 * what was just dismissed (§6.1.1).
 */
export const SUPPRESSED_KEY = "autoSuppressedTabs";

/** Soft cap on saved rules — storage-quota safety (open question #7). */
export const MAX_RULES = 50;

/** Why a tab is on the reload list — the list always states its source. */
export const SOURCE_MANUAL = "manual";
export const SOURCE_RULE = "rule";

const HOST_LABEL_RE = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/;

function isValidHost(host) {
  if (!host || host.length > 253) return false;
  return host.split(".").every((label) => HOST_LABEL_RE.test(label));
}

/**
 * Parse and canonicalize a user-typed pattern.
 *
 * Accepts what people naturally paste — a full URL, a bare host, a leading
 * `*.`, a trailing `/*` — and reduces it to the v1 grammar. Scheme, port,
 * query, and hash are stripped rather than rejected: they carry no meaning in
 * a host+path-prefix match, and silently failing on a pasted URL would be
 * worse than quietly narrowing it.
 *
 * Returns { ok: true, pattern, host, wildcard, path } where `pattern` is the
 * canonical form to store and compare, or { ok: false, error, message }.
 */
export function normalizeRulePattern(input) {
  const fail = (error, message) => ({ ok: false, error, message });
  if (typeof input !== "string") return fail("empty", "Enter a site to match.");

  let raw = input.trim();
  if (!raw) return fail("empty", "Enter a site to match.");

  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // scheme
  raw = raw.replace(/^\/\//, ""); // protocol-relative
  raw = raw.split("#")[0].split("?")[0]; // hash + query never participate (v1)
  if (!raw) return fail("empty", "Enter a site to match.");

  const slash = raw.indexOf("/");
  let hostPart = slash === -1 ? raw : raw.slice(0, slash);
  let path = slash === -1 ? "" : raw.slice(slash);

  hostPart = hostPart.trim().toLowerCase().replace(/^\.+/, "");
  hostPart = hostPart.replace(/@.*$/, ""); // userinfo, if a URL was pasted
  hostPart = hostPart.replace(/:\d*$/, ""); // port plays no part in matching

  let wildcard = false;
  if (hostPart.startsWith("*.")) {
    wildcard = true;
    hostPart = hostPart.slice(2);
  }
  if (hostPart === "*" || hostPart === "") {
    return fail("host", "Name a site — a bare * would match every page you open.");
  }
  if (hostPart.includes("*")) {
    return fail("wildcard", "Only a leading “*.” wildcard is supported (e.g. *.example.com).");
  }
  if (!isValidHost(hostPart)) {
    return fail("host", `“${hostPart}” isn't a valid host name.`);
  }

  path = path.replace(/\*+$/, ""); // trailing /* is implied — it's a prefix
  if (path === "/") path = ""; // whole-site
  if (path && !path.startsWith("/")) path = `/${path}`;

  return {
    ok: true,
    pattern: `${wildcard ? "*." : ""}${hostPart}${path}`,
    host: hostPart,
    wildcard,
    path,
  };
}

/**
 * How a pattern is shown to the user. Storage keeps the canonical prefix
 * (`example.com/admin/`); the UI appends the `*` so the prefix nature is
 * visible and round-trips back through normalizeRulePattern() unchanged.
 */
export function displayRulePattern(rule) {
  if (!rule) return "";
  const pattern = typeof rule === "string" ? rule : rule.pattern;
  if (!pattern) return "";
  return pattern.includes("/") ? `${pattern}*` : pattern;
}

/** True if `url` is a page a rule can match at all (http/https only). */
export function isMatchableUrl(url) {
  if (typeof url !== "string") return false;
  return /^https?:\/\//i.test(url);
}

/** Does this rule's pattern match `url`? Enabled state is NOT considered here. */
export function ruleMatchesUrl(rule, url) {
  if (!rule || !isMatchableUrl(url)) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  if (rule.wildcard) {
    // `*.example.com` covers the apex too — "all of example.com" is what the
    // user means when they type it.
    if (host !== rule.host && !host.endsWith(`.${rule.host}`)) return false;
  } else if (host !== rule.host) {
    return false;
  }

  if (rule.path) {
    const p = parsed.pathname;
    // `/admin` satisfies the prefix `/admin/` — same section of the site.
    if (!p.startsWith(rule.path) && `${p}/` !== rule.path) return false;
  }
  return true;
}

/**
 * Specificity ranking for "if several rules match one tab, the most specific
 * match supplies the interval" (§6.1.1).
 *
 * The PRD glosses this as "longest pattern", which is right in the ordinary
 * cases but inverts for an apex host: `*.example.com` is *longer* than
 * `example.com` while being strictly broader. So an exact host outranks a
 * wildcard first, then a longer path prefix, then pattern length as the
 * tiebreak the PRD names.
 */
export function compareRuleSpecificity(a, b) {
  if (a.wildcard !== b.wildcard) return a.wildcard ? 1 : -1;
  if (a.path.length !== b.path.length) return b.path.length - a.path.length;
  return b.pattern.length - a.pattern.length;
}

/** The enabled rule that should enroll `url`, or null if none matches. */
export function bestRuleForUrl(rules, url) {
  if (!Array.isArray(rules) || !isMatchableUrl(url)) return null;
  const hits = rules.filter((r) => r.enabled && ruleMatchesUrl(r, url));
  if (hits.length === 0) return null;
  return hits.sort(compareRuleSpecificity)[0];
}

/**
 * The pattern the popup pre-fills for "Always reload this site" (§6.1.1): the
 * tab's origin plus its current path as a prefix. A page at the site root
 * proposes the bare host, which is the common case (flow 7.2).
 */
export function proposeRulePattern(url) {
  if (!isMatchableUrl(url)) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname || "/";
  // Directory portion of the current path — the page itself is not the unit
  // the user is nominating, the section it lives in is.
  const dir = path.slice(0, path.lastIndexOf("/") + 1);
  return dir === "/" ? host : `${host}${dir}`;
}

/** The whole-site form of a proposal — backs the popup's "Whole site" shortcut. */
export function hostOnlyPattern(url) {
  if (!isMatchableUrl(url)) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
