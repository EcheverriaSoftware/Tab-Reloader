# IT Workflow Plugin — Documentation

This project began as a single-purpose auto-reloader (**Tab Reloader**, still the
repository name) and has grown into the **IT Workflow Plugin**: a small suite of
focused, tab-targeted utilities that remove recurring frictions from a day in
browser-based IT and support tools. They share one Manifest V3 extension (one
service worker, one popup, one options page, one set of permissions). This index
is the hub: the umbrella PRD captures the three pillars at a glance, and the
deeper features each have their own spec.

The umbrella spec is **[PRD.md](PRD.md)** — the IT Workflow Plugin PRD, with the
three pillars in §6 (Tab Reloading §6.1, Clock In/Out §6.2, DMP File Analyzer
§6.3).

## Product specs

| Pillar | Spec | What it does | Persistence |
|---|---|---|---|
| **Tab Reloading** | [PRD.md §6.1](PRD.md) | Refresh chosen tabs on a recurring interval, skipping the tab you're viewing. | **Per session** — reload list clears on browser close. |
| **Clock In/Out & shift events** | [EVENTS_PRD.md](EVENTS_PRD.md) | Time-of-day alerts on a chosen tab (lunch, breaks, clock-in/clock-out) that let you jump to the tab or ignore. | **Persistent** — survives restarts, may sync across devices. |
| **DMP File Analyzer** | [PRD-DMP-Analysis.md](PRD-DMP-Analysis.md) | Read a Windows crash dump (`.dmp`) locally in the browser — stop code, suspect module, and fix steps; nothing uploaded. | **None** — stateless; each dump is parsed on the spot. |

## Shared platform

The features run in the same extension and reuse common infrastructure
(see each spec's "Technical design" for detail):

- **Manifest V3** background service worker; standard Chromium APIs only
  (Chrome + Brave/Edge/Opera/Vivaldi). There is no build step — plain ES modules.
- **`chrome.alarms`** for scheduling — `periodInMinutes` for reload intervals,
  absolute `when` for event times — so timers survive worker suspension.
- **Split storage:** `chrome.storage.session` for the ephemeral reload list;
  `chrome.storage.sync` (with `local` fallback) for persistent prefs and events.
- **`chrome.commands`** keyboard shortcuts: `Alt+Shift+R` toggles auto-reload on
  the current tab; `Alt+Shift+E` toggles the current tab as an event tab;
  `Alt+Shift+D` opens the DMP analyzer with its upload control focused.
- **Least-privilege permissions:** `tabs`, `alarms`, `storage`, and
  `notifications` (added for events) — no host permissions.

The **DMP File Analyzer** is the odd one out: it lives on its own extension page
([`src/analyzer/`](../src/analyzer/)) and parses the dump **fully client-side**
(`DataView`/`ArrayBuffer` + `Blob.slice`), so it uses neither the alarm scheduler
nor the storage split — nothing is persisted and nothing leaves the tab. It
shares only the extension shell, the `tabs` permission (to focus an already-open
analyzer tab), and the `chrome.commands` shortcut.

## ID conventions

Functional-requirement IDs are namespaced per spec so they don't collide:

- `EV-*` — events / clock-in-out ([EVENTS_PRD.md](EVENTS_PRD.md))
- Tab Reloading and the DMP File Analyzer are specced by **section reference**
  (e.g. [PRD.md §6.1](PRD.md), [PRD-DMP-Analysis.md §7](PRD-DMP-Analysis.md))
  rather than namespaced IDs.

## Cross-feature notes

- A tab can be in **both** the reload and events features at once
  (auto-reloading *and* holding events); they operate independently.
- The auto-reload "scheduled reloads by time of day" idea overlaps with Events; a
  possible future bridge is letting an event also trigger a reload. See the
  umbrella [PRD.md §11](PRD.md) and [EVENTS_PRD.md §13](EVENTS_PRD.md).
- The **DMP File Analyzer is independent** of the other two — it neither reloads
  tabs nor schedules anything. The cross-pillar tie is a future **"ticket pack"**
  (PRD §11): bundle a dump summary with the reloading-tab list and a recent shift
  summary into one paste-able artifact.
