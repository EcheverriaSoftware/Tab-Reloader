# IT Workflow Plugin

A lightweight Manifest V3 browser extension that removes small, recurring
frictions from a day spent in browser-based IT and support tools. It bundles
three loosely related, tab-targeted utilities behind one service worker, one
popup, and one set of least-privilege permissions:

- **Tab Reloading** — refresh chosen tabs on an interval to keep web sessions
  warm, skipping the tab you're viewing. Per-session.
- **Clock In/Out & shift events** — time-of-day alerts on a chosen tab (lunch,
  breaks, clock-in/clock-out) that let you jump to the tab or ignore.
  Persistent.
- **DMP File Analyzer** — drop in a Windows crash dump (`.dmp`) and get a short,
  plain-English read of what crashed and where to start — parsed entirely in the
  browser, nothing uploaded.

> **Note on the name.** The repository is still called `Tab-Reloader` for
> historical reasons — it began life as a single-purpose auto-reloader. It has
> since grown into the broader IT Workflow Plugin described here; a rename is
> pending.

## Specs

[`docs/PRD.md`](docs/PRD.md) is the umbrella PRD — all three pillars at a
glance, in §6. The two deeper features have their own spec:

| Pillar | Spec | Persistence |
|---|---|---|
| **Tab Reloading** | [PRD.md §6.1](docs/PRD.md) | **Per session** — the reload list clears on browser close. |
| **Clock In/Out & shift events** | [EVENTS_PRD.md](docs/EVENTS_PRD.md) | **Persistent** — survives restarts, may sync across devices. |
| **DMP File Analyzer** | [PRD-DMP-Analysis.md](docs/PRD-DMP-Analysis.md) | **None** — stateless; each dump is parsed on the spot. |

Requirement IDs are namespaced per spec: `EV-*` for events. Tab Reloading and
the analyzer are cited by section reference instead. Note that the reloader code
still carries `FR-*` comments that trace to the pre-rebrand auto-reload spec —
those IDs no longer resolve to anything in `docs/`.

## Features

### Tab Reloading

Keeps web tools from signing you out by periodically refreshing designated tabs.
The motivating problem is *re-login fatigue*, not stale content — though
dashboards and queues benefit too.

- **Quick add** the current tab with a keyboard shortcut (default `Alt+Shift+R`)
  or the toolbar popup — the shortcut toggles a tab on/off.
- **Per-tab schedules**: multiple tabs reload independently, each on its own
  interval, with a global default (20 min) and optional per-tab overrides.
- **Viewing-skip**: if a refresh comes due while you're viewing that tab (it's
  the active tab in the focused window), the cycle is skipped silently and
  retried next interval — you might be reading it.
- **Pause/resume** any tab individually, or pause/resume all at once.
- **Manual reload resets the timer** — reloading a tab yourself reschedules its
  next auto-refresh a full interval out.
- The **default interval persists** (and may sync across devices); the **active
  reload list is never persisted** across sessions.

### Clock In/Out & shift events

Helps you stay aligned with break and lunch policies by attaching wall-clock
alerts to a tab — start, stop, break, and lunch boundaries.

- **Attach time-of-day alerts to a tab** — one or many per tab (e.g. break,
  lunch, clock-in, clock-out), each at a wall-clock time.
- **One-time or recurring** on chosen weekdays.
- **Jump or ignore**: when an event fires, a notification lets you jump straight
  to the tab (opening it if it isn't already open), snooze it for a
  configurable few minutes, or dismiss it.
- **Add/remove a tab** for events with a keyboard shortcut (default
  `Alt+Shift+E`) or the popup.
- **Events persist** across sessions and may sync across devices.

### DMP File Analyzer

Reads a Windows crash dump (`.dmp`) **right in the browser** — no Windows VM, no
WinDbg, and no uploading the dump to a third-party service. Because parsing is
**fully client-side**, it runs **anywhere Chrome runs, including macOS** — the
motivating case being a Mac-based support engineer who gets a `.dmp` attached to
a ticket.

- **Drop in one or many `.dmp` files** (drag-and-drop or a multi-select picker).
  Each is parsed independently — one bad file never blocks the rest.
- **Plain-English report**: what happened, the most likely source (with a
  confidence level), the machine, and concrete fix steps — paste-ready into a
  ticket via **Copy report** or **Save report (.txt)**.
- **Bugcheck decoding**: the stop code is decoded to its symbolic name (e.g.
  `0xD1 → DRIVER_IRQL_NOT_LESS_OR_EQUAL`), with a curated cause-and-fix knowledge
  base for the 14 most common codes and a symbolic name for 260+ published codes.
- **Suspect module**: names the probable culprit driver and translates it to a
  human label where known (e.g. `nvlddmkm.sys` → NVIDIA display driver).
  Attribution is calibrated and hedged — because v1 recovers module names
  without load addresses, one third-party driver caps at *medium* confidence and
  several at *low*. It never manufactures a suspect when none stands out.
- **Live-dump aware**: detects kernel *live* dumps (a recoverable subsystem reset
  like a GPU TDR) and reframes them as "not a crash — the PC kept running,"
  never as a bluescreen.
- **Batch overview** for multiple files: per-file rows, crash/live/unreadable
  counts, and any **suspect that recurs across dumps** (a stronger signal than
  any single dump).
- **Simple / Advanced views**: the default Simple card is jargon-light; an
  Advanced toggle reveals the raw parameters and the full detected-module list.
- **Local and private**: the dump never leaves the browser sandbox, and the
  report summarizes — it never copies raw memory into the output.
- **Quick-open shortcut** (default `Alt+Shift+D`) jumps straight to the analyzer
  with the upload control focused.

**Deliberate tradeoff.** With no native tooling, analysis is **module-level, not
function-level** — it names the stop code, parameters, and implicated driver, but
does **not** symbolicate call stacks (that needs Windows-side symbol tooling).
For the full stack, open the dump in WinDbg. See the
[DMP analysis spec](docs/PRD-DMP-Analysis.md) for the accuracy model and roadmap.

## Load it in Chrome (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this repository's root folder (the one
   containing `manifest.json`).
4. Pin **Tab Reloader** to the toolbar.

Works the same on other Chromium browsers (Brave, Edge, Opera, Vivaldi) via
their equivalent extensions page. There is no build step — it's plain
ES-module JavaScript loaded directly.

## Keyboard shortcuts

| Action | Default | Pillar |
|---|---|---|
| Toggle auto-reload for the current tab | `Alt+Shift+R` | Tab Reloading |
| Add/remove the current tab as an events tab | `Alt+Shift+E` | Clock In/Out & shift events |
| Open the crash dump analyzer, ready to upload | `Alt+Shift+D` | DMP File Analyzer |

Rebind or clear any of these at `chrome://extensions/shortcuts` (linked from the
options page). The extension can't set bindings programmatically — that page is
the system of record.

## Project layout

```
manifest.json            MV3 manifest (service worker, commands, permissions)
src/
  background.js          Service worker: scheduling, viewing-skip, lifecycle, badge, analyzer launch
  common/
    constants.js         Shared constants + pure helpers (clamp, alarm names)
    storage.js           chrome.storage wrappers (session list + synced prefs)
  popup/                 Toolbar popup: current-tab toggle, list, countdowns, events
  options/               Options page: default interval, badge, events, shortcut links
  analyzer/              DMP File Analyzer (its own page)
    analyzer.html/.css   Upload surface, batch overview, per-file Simple/Advanced cards
    analyzer.js          Ingest, drive parsing, render cards, copy/save report
    dmp-parser.js        Hand-rolled JS dump parser (header headline + module name-scan)
    bugcheck-kb.js       Bugcheck code → name + curated cause/fix knowledge base
    module-vendors.js    module filename → vendor/product label + generic-OS-module set
    report.js            Builds the concise text report + batch combined report
icons/                   16 / 48 / 128 px icons (generated via tools/gen_icons.py)
docs/
  PRD.md                 IT Workflow Plugin PRD (the three pillars)
  EVENTS_PRD.md          Events / clock-in-out spec
  PRD-DMP-Analysis.md    DMP File Analyzer spec
```

## How it works (technical)

- **Scheduling** uses `chrome.alarms` (one periodic alarm per reload tab,
  absolute `when` for event times), so timers survive the MV3 service worker
  being suspended. The alarms API floor of ~1 minute is the minimum reload
  interval.
- **State** lives in `chrome.storage.session` (the active reload list — cleared
  on browser close) and `chrome.storage.sync` with a `local` fallback (the
  default interval, preferences, and persistent events).
- **Viewing detection** uses `chrome.tabs`/`chrome.windows` focus state only
  (active tab + focused window). No idle/input check — a reader producing no
  input must not be interrupted.
- **The analyzer parses fully client-side** via `DataView`/`ArrayBuffer` (and
  `Blob.slice` for large dumps), reading the bugcheck headline from fixed header
  offsets and scanning the triage region for module names. No native code, no
  network, no symbol server — the dump never leaves the tab. Opening the analyzer
  reuses the existing `tabs` permission to focus an already-open tab rather than
  duplicating it.
- **Permissions** are kept minimal: `tabs`, `alarms`, `storage`, and
  `notifications` (for event alerts) — no host permissions.

## Regenerating icons

```
python3 tools/gen_icons.py
```

Requires Python with Pillow installed.
