# Tab Reloader

A lightweight Manifest V3 browser extension that auto-refreshes the tabs you
choose, on an interval you choose. The reload list is **per session** (it clears
when the browser closes) and refreshes are **skipped while you're viewing the
tab** (it's the active tab in the focused window).

See [docs/PRD.md](docs/PRD.md) for the full product spec.

## Features

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

## Load it in Chrome (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this repository's root folder (the one
   containing `manifest.json`).
4. Pin **Tab Reloader** to the toolbar.

Works the same on other Chromium browsers (Brave, Edge, Opera, Vivaldi) via
their equivalent extensions page. There is no build step — it's plain
ES-module JavaScript loaded directly.

### Change the keyboard shortcut

Visit `chrome://extensions/shortcuts` (linked from the options page) to rebind
the quick-add command.

## Project layout

```
manifest.json            MV3 manifest (service worker, command, permissions)
src/
  background.js          Service worker: scheduling, viewing-skip, lifecycle, badge
  common/
    constants.js         Shared constants + pure helpers (clamp, alarm names)
    storage.js           chrome.storage wrappers (session list + synced prefs)
  popup/                 Toolbar popup: current-tab toggle, list, countdowns
  options/               Options page: default interval, badge, shortcut link
icons/                   16 / 48 / 128 px icons (generated via tools/gen_icons.py)
docs/PRD.md              Product requirements
```

## How it works (technical)

- **Scheduling** uses `chrome.alarms` (one periodic alarm per tab), so timers
  survive the MV3 service worker being suspended. The alarms API floor of
  ~1 minute is the minimum interval.
- **State** lives in `chrome.storage.session` (the active list — cleared on
  browser close) and `chrome.storage.sync` with a `local` fallback (the default
  interval and preferences).
- **Viewing detection** uses `chrome.tabs`/`chrome.windows` focus state only
  (active tab + focused window). No idle/input check — a reader producing no
  input must not be interrupted.
- **Permissions** are kept minimal: `tabs`, `alarms`, `storage` — no host
  permissions.

## Regenerating icons

```
python3 tools/gen_icons.py
```

Requires Python with Pillow installed.
