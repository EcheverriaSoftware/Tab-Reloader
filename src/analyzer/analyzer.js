// Crash Dump Analyzer — page controller. The only file in src/analyzer/ that
// touches the DOM / chrome.* APIs; all parsing and report text come from the
// pure modules (dmp-parser.js, report.js). Flow: ingest a .dmp (drag-drop or
// picker) → read the needed byte range via Blob.slice → analyzeDump → render the
// on-screen summary + the paste-ready text report, with Save/Copy delivery.

import { analyzeDump } from "./dmp-parser.js";
import { buildReport } from "./report.js";

const $ = (sel) => document.querySelector(sel);

// Cap how much of a dump we buffer. The small kernel minidump (the in-extension
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
  declined: $("#declined"),
  declinedMsg: $("#declinedMsg"),
  result: $("#result"),
  stopHex: $("#stopHex"),
  stopName: $("#stopName"),
  meaning: $("#meaning"),
  fileMeta: $("#fileMeta"),
  suspectBody: $("#suspectBody"),
  copyBtn: $("#copyBtn"),
  saveBtn: $("#saveBtn"),
  actionMsg: $("#actionMsg"),
  reportText: $("#reportText"),
};

let currentReport = ""; // text backing Copy/Save
let currentBaseName = "dump"; // for the download filename

const extVersion = globalThis.chrome?.runtime?.getManifest?.().version ?? "1.0";

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
  const file = els.fileInput.files[0];
  els.fileInput.value = ""; // allow re-selecting the same file to re-run
  if (file) handleFile(file);
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
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

async function handleFile(file) {
  showOnly(els.loading);
  els.loadingName.textContent = file.name;

  let buffer;
  try {
    const slice = file.slice(0, Math.min(file.size, MAX_READ_BYTES));
    buffer = await slice.arrayBuffer();
  } catch (err) {
    return renderDeclined(`Couldn’t read the file: ${err?.message || err}.`);
  }

  let result;
  try {
    result = analyzeDump(buffer, { fileName: file.name, fileSize: file.size });
  } catch (err) {
    // The parser is built not to throw for recognized dumps; this is a backstop.
    return renderDeclined(`Analysis failed: ${err?.message || err}.`);
  }

  if (!result.ok) return renderDeclined(result.declined);
  renderResult(result, file);
}

// --- rendering -------------------------------------------------------------

function showOnly(el) {
  for (const s of [els.loading, els.declined, els.result]) s.hidden = s !== el;
}

function renderDeclined(message) {
  els.declinedMsg.textContent = message || "This file is not a Windows kernel crash dump.";
  showOnly(els.declined);
}

function renderResult(result, file) {
  const { header, knowledge, modules } = result;

  els.stopHex.textContent = "0x" + (header.bugcheckCode >>> 0).toString(16).toUpperCase().padStart(8, "0");
  els.stopName.textContent = knowledge ? knowledge.name : "(unrecognized stop code)";
  els.meaning.textContent = knowledge
    ? knowledge.meaning
    : "No curated guidance for this stop code yet — see the full report below for everything extracted.";
  els.fileMeta.textContent = `${file.name} · ${header.arch} · ${header.processorCount} CPU${header.processorCount === 1 ? "" : "s"} · build ${header.build}`;

  renderSuspect(modules);

  currentReport = buildReport(result, { toolVersion: extVersion, analyzedAt: Date.now() });
  currentBaseName = file.name.replace(/\.dmp$/i, "") || "dump";
  els.reportText.textContent = currentReport;

  hideActionMsg();
  showOnly(els.result);
}

function renderSuspect(modules) {
  const body = els.suspectBody;
  body.replaceChildren();

  if (modules.suspect) {
    const name = document.createElement("div");
    name.className = "suspect__name";
    const code = document.createElement("code");
    code.textContent = modules.suspect.name;
    name.append(code);
    if (modules.suspect.vendor) name.append(`  ${modules.suspect.vendor}`);
    body.append(name);
  } else if (modules.confidence === "third-party-candidates") {
    const lead = document.createElement("div");
    lead.className = "suspect__name";
    lead.textContent = "Several third-party drivers present:";
    body.append(lead);
    const ul = document.createElement("ul");
    ul.className = "candidates";
    for (const m of modules.thirdParty) {
      const li = document.createElement("li");
      const code = document.createElement("code");
      code.textContent = m.name;
      li.append(code);
      if (m.vendor) li.append(`  ${m.vendor}`);
      ul.append(li);
    }
    body.append(ul);
  } else {
    const none = document.createElement("div");
    none.className = "suspect__name";
    none.textContent = "No third-party driver clearly implicated.";
    body.append(none);
  }

  const why = document.createElement("p");
  why.className = "suspect__why";
  why.textContent = modules.rationale;
  body.append(why);
}

// --- delivery: copy + save -------------------------------------------------

els.copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(currentReport);
    showActionMsg("Copied to clipboard.", "ok");
  } catch {
    showActionMsg("Couldn’t copy — select the report text and copy manually.", "warn");
  }
});

els.saveBtn.addEventListener("click", () => {
  const blob = new Blob([currentReport], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${currentBaseName}-analysis.txt`;
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
