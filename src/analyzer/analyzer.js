// Crash Dump Analyzer — page controller. The only file in src/analyzer/ that
// touches the DOM / chrome.* APIs; all parsing, report text, and the on-screen
// view model come from the pure modules (dmp-parser.js, report.js). Flow: ingest
// one or many .dmp files (drag-drop or multi-select picker) → read the needed
// byte range of each via Blob.slice → analyzeDump → render a per-file card +,
// for a batch, an overview with recurring-suspect correlation (§7.1/§7.6/§8).

import { analyzeDump } from "./dmp-parser.js";
import {
  buildBatchReport,
  buildDetails,
  rowFields,
  summarizeBatch,
  viewModel,
} from "./report.js";

const $ = (sel) => document.querySelector(sel);

// Cap how much of each dump we buffer. The small kernel minidump (the in-extension
// sweet spot, ≤ ~2 MB) fits entirely; for a multi-GB MEMORY.DMP we read only the
// head — enough for the fixed-offset headline + an early triage scan — and the
// parser flags the module list as possibly incomplete (PRD §7.1).
const MAX_READ_BYTES = 16 * 1024 * 1024;

const els = {
  drop: $("#drop"),
  fileInput: $("#fileInput"),
  browseBtn: $("#browseBtn"),
  loading: $("#loading"),
  loadingName: $("#loadingName"),
  results: $("#results"),
  overview: $("#overview"),
  overviewHead: $("#overviewHead"),
  overviewRecurring: $("#overviewRecurring"),
  advAll: $("#advAll"),
  copyBtn: $("#copyBtn"),
  saveBtn: $("#saveBtn"),
  actionMsg: $("#actionMsg"),
  cards: $("#cards"),
  cardTemplate: $("#cardTemplate"),
};

const CONF_LABEL = { high: "high", medium: "medium", low: "low", none: "none" };

const extVersion = globalThis.chrome?.runtime?.getManifest?.().version ?? "1.0";

// Entries for the current batch: { file, result }. Drives copy/save + the toggle.
let entries = [];

// --- ingest ----------------------------------------------------------------

els.browseBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  els.fileInput.click();
});
els.drop.addEventListener("click", () => els.fileInput.click());
els.drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    els.fileInput.click();
  }
});
els.fileInput.addEventListener("change", () => {
  const files = [...els.fileInput.files];
  els.fileInput.value = ""; // allow re-selecting the same file(s) to re-run
  if (files.length) handleFiles(files);
});

["dragenter", "dragover"].forEach((evt) =>
  els.drop.addEventListener(evt, (e) => {
    e.preventDefault();
    els.drop.classList.add("is-drag");
  }),
);
["dragleave", "dragend", "drop"].forEach((evt) =>
  els.drop.addEventListener(evt, (e) => {
    e.preventDefault();
    els.drop.classList.remove("is-drag");
  }),
);
els.drop.addEventListener("drop", (e) => {
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) handleFiles(files);
});

// --- quick-upload focus (DMP §7.8) -----------------------------------------
// The Alt+Shift+D command lands the user ready to upload. We can't guarantee the
// OS file dialog auto-opens (the command's user activation doesn't reliably carry
// across the tab open), so we focus + highlight the drop zone — the next
// Enter/Space/click starts the pick. The drop zone is role="button", tabindex=0.

function focusUpload() {
  els.drop.classList.add("is-drag"); // reuse the highlight style as an attract cue
  els.drop.focus({ preventScroll: false });
  els.drop.scrollIntoView({ block: "center", behavior: "smooth" });
  // Fade the cue so it reads as a hint, not a stuck drag state.
  setTimeout(() => els.drop.classList.remove("is-drag"), 1500);
}

// Background opens new analyzer tabs with ?focus=1 (it can't message a tab that
// isn't loaded yet); an already-open tab is nudged via a runtime message.
if (new URLSearchParams(location.search).get("focus") === "1") {
  // Defer to after first paint so the element is focusable and scrolled into view.
  requestAnimationFrame(focusUpload);
  // Tidy the URL so a reload/bookmark doesn't keep re-triggering the cue.
  history.replaceState(null, "", location.pathname);
}

chrome.runtime?.onMessage?.addListener((msg) => {
  if (msg?.type === "analyzer:focus-upload") {
    // Already the active tab: try the picker directly (still subject to the
    // browser's user-activation rules), then fall back to focusing the control.
    try {
      els.fileInput.click();
    } catch {
      /* activation may be unavailable; focus is the guaranteed-safe fallback */
    }
    focusUpload();
  }
});

async function handleFiles(files) {
  els.loadingName.textContent =
    files.length === 1 ? files[0].name : `${files.length} files`;
  showLoading();

  // Parse each file independently — one bad file never blocks the rest (§7.1).
  entries = await Promise.all(files.map(analyzeFile));
  render();
}

async function analyzeFile(file) {
  try {
    const slice = file.slice(0, Math.min(file.size, MAX_READ_BYTES));
    const buffer = await slice.arrayBuffer();
    const result = analyzeDump(buffer, { fileName: file.name, fileSize: file.size });
    return { file, result };
  } catch (err) {
    // Surface read/parse failures as a declined result so they get an honest row.
    return {
      file,
      result: { ok: false, fileName: file.name, declined: `Couldn’t read this file: ${err?.message || err}.` },
    };
  }
}

// --- rendering -------------------------------------------------------------

function showLoading() {
  els.loading.hidden = false;
  els.results.hidden = true;
}

function render() {
  els.loading.hidden = true;
  els.results.hidden = false;
  hideActionMsg();

  renderOverview();
  els.cards.replaceChildren();
  entries.forEach((entry, i) => els.cards.append(buildCard(entry, entries.length > 1, i)));
  applyAdvanced();
}

function renderOverview() {
  if (entries.length < 2) {
    els.overview.hidden = true;
    return;
  }
  const s = summarizeBatch(entries);
  const bits = [`${s.crashes} crash${s.crashes === 1 ? "" : "es"}`, `${s.liveCount} live`];
  if (s.unreadable) bits.push(`${s.unreadable} unreadable`);
  els.overviewHead.textContent = `${s.total} dumps analyzed — ${bits.join(", ")}`;

  if (s.recurring) {
    const label = s.recurring.vendor ? `${s.recurring.name} (${s.recurring.vendor})` : s.recurring.name;
    els.overviewRecurring.textContent = `Recurring suspect: ${label} — in ${s.recurring.count} of ${s.readable}`;
    els.overviewRecurring.hidden = false;
  } else {
    els.overviewRecurring.hidden = true;
  }
  els.overview.hidden = false;
}

function buildCard(entry, isBatch, index) {
  const node = els.cardTemplate.content.firstElementChild.cloneNode(true);
  const q = (sel) => node.querySelector(sel);
  const row = rowFields(entry);

  // Collapsed bar (always visible).
  q(".filecard__name").textContent = row.fileName;
  if (row.ok) {
    q(".filecard__code").textContent = `${row.codeName} (${row.codeHex})`;
    q(".filecard__suspect").textContent = row.suspect;
    const badge = q(".badge--conf");
    badge.textContent = CONF_LABEL[row.confidence] || row.confidence;
    badge.classList.add(`badge--${row.confidence}`);
  } else {
    q(".filecard__code").textContent = "could not analyze";
    q(".filecard__suspect").textContent = "";
    const badge = q(".badge--conf");
    badge.textContent = "error";
    badge.classList.add("badge--error");
  }

  // Expand/collapse. A single file starts open; batch rows start collapsed.
  const bar = q(".filecard__bar");
  const body = q(".filecard__body");
  const open = !isBatch;
  body.hidden = !open;
  node.classList.toggle("is-open", open);
  bar.addEventListener("click", () => {
    const nowOpen = body.hidden;
    body.hidden = !nowOpen;
    node.classList.toggle("is-open", nowOpen);
  });

  // Body.
  if (!row.ok) {
    const err = q(".filecard__error");
    err.textContent = entry.result?.declined || "Unrecognized or unreadable file.";
    err.hidden = false;
    q(".filecard__simple").hidden = true;
    return node;
  }

  const vm = viewModel(entry.result);
  q(".filecard__live").hidden = !vm.isLive;
  q(".filecard__what").textContent = vm.whatHappened;
  q(".block__conf").textContent = `(${vm.confidenceLabel})`;

  const source = q(".filecard__source");
  for (const line of vm.sourceLines) {
    const div = document.createElement("div");
    div.textContent = line;
    source.append(div);
  }

  q(".filecard__machine").textContent = vm.machine;

  const fix = q(".filecard__fix");
  for (const step of vm.fixSteps) {
    const li = document.createElement("li");
    li.textContent = step;
    fix.append(li);
  }

  q(".filecard__details").textContent = buildDetails(entry.result);
  node.dataset.index = index;
  return node;
}

// Show/hide each card's Advanced expander per the batch toggle (§7.6).
function applyAdvanced() {
  const show = els.advAll.checked;
  for (const adv of els.cards.querySelectorAll(".filecard__advanced")) {
    adv.hidden = !show;
  }
}

els.advAll.addEventListener("change", applyAdvanced);

// --- delivery: combined copy + save ----------------------------------------

function currentReportText() {
  return buildBatchReport(entries, {
    toolVersion: extVersion,
    analyzedAt: Date.now(),
    includeAdvanced: els.advAll.checked,
  });
}

function downloadBaseName() {
  if (entries.length === 1) {
    return (entries[0].file?.name || "dump").replace(/\.dmp$/i, "") || "dump";
  }
  return `crash-dumps-${entries.length}`;
}

els.copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(currentReportText());
    showActionMsg("Copied to clipboard.", "ok");
  } catch {
    showActionMsg("Couldn’t copy — open a report’s Advanced view and copy manually.", "warn");
  }
});

els.saveBtn.addEventListener("click", () => {
  const blob = new Blob([currentReportText()], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${downloadBaseName()}-analysis.txt`;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showActionMsg("Report saved.", "ok");
});

let msgTimer = null;
function showActionMsg(text, kind) {
  els.actionMsg.textContent = text;
  els.actionMsg.className = `msg msg--${kind}`;
  els.actionMsg.hidden = false;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(hideActionMsg, 4000);
}
function hideActionMsg() {
  els.actionMsg.hidden = true;
}
