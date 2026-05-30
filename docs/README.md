# Tab Reloader — Documentation

**Tab Reloader** began as a single-purpose auto-reloader and is growing into a
lightweight **tab manager**: a small suite of focused, tab-targeted utilities
that share one Manifest V3 extension (one service worker, one popup, one options
page, one set of permissions). This index is the hub; each feature has its own
product spec.

## Product specs

| Feature | Spec | What it does | Persistence |
|---|---|---|---|
| **Auto-reload** | [PRD.md](PRD.md) | Refresh chosen tabs on a recurring interval, skipping the tab you're viewing. | **Per session** — reload list clears on browser close. |
| **Events** | [EVENTS_PRD.md](EVENTS_PRD.md) | Time-of-day alerts on a chosen tab (lunch, breaks, shift end) that let you jump to the tab or ignore. | **Persistent** — survives restarts, may sync across devices. |

## Shared platform

Both features run in the same extension and reuse common infrastructure
(see each spec's "Technical design" for detail):

- **Manifest V3** background service worker; standard Chromium APIs only
  (Chrome + Brave/Edge/Opera/Vivaldi).
- **`chrome.alarms`** for scheduling — `periodInMinutes` for reload intervals,
  absolute `when` for event times — so timers survive worker suspension.
- **Split storage:** `chrome.storage.session` for the ephemeral reload list;
  `chrome.storage.sync` (with `local` fallback) for persistent prefs and events.
- **`chrome.commands`** keyboard shortcuts: `Alt+Shift+R` toggles auto-reload on
  the current tab; `Alt+Shift+E` toggles the current tab as an event tab.
- **Least-privilege permissions:** `tabs`, `alarms`, `storage`, and
  `notifications` (added for events) — no host permissions.

## ID conventions

Functional-requirement IDs are namespaced per spec so they don't collide:

- `FR-*` — auto-reload ([PRD.md](PRD.md))
- `EV-*` — events ([EVENTS_PRD.md](EVENTS_PRD.md))

## Cross-feature notes

- A tab can be in **both** features at once (auto-reloading *and* holding
  events); they operate independently.
- The auto-reload spec's "scheduled reloads by time of day" idea overlaps with
  Events; a possible future bridge is letting an event also trigger a reload.
  See [PRD.md §13](PRD.md) and [EVENTS_PRD.md §13](EVENTS_PRD.md).
