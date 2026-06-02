// Plain-text report builder for the DMP File Analyzer (PRD-DMP-Analysis §7.5/§8).
// Pure: takes the structured result from `analyzeDump()` and returns text. The UI
// owns delivery (download + clipboard).
//
// `buildReport()` is the PRIMARY, concise five-part report (§8): What happened →
// Most likely source (with a confidence tag) → Machine → How to fix → Technical
// details. It deliberately leads with the answer and keeps hex/parameters/module
// lists OUT of the default view. `buildDetails()` produces the verbose
// parameter+module breakdown for the in-app "Advanced" expander only (§7.6).

import { KB_VERSION } from "./bugcheck-kb.js";
import { formatHex64 } from "./dmp-parser.js";

const TOOL_NAME = "DMP Analyzer";

// Known OS build numbers → friendly version (§7.2). Build is the dump header's
// minor version; unknown builds fall back to a generic, never-guessed label.
const OS_BUILDS = {
  26100: "Windows 11, version 24H2",
  22631: "Windows 11, version 23H2",
  22621: "Windows 11, version 22H2",
  22000: "Windows 11, version 21H2",
  19045: "Windows 10, version 22H2",
  19044: "Windows 10, version 21H2",
  19043: "Windows 10, version 21H1",
  19042: "Windows 10, version 20H2",
  19041: "Windows 10, version 2004",
  18363: "Windows 10, version 1909",
  17763: "Windows 10, version 1809 / Server 2019",
  14393: "Windows 10, version 1607 / Server 2016",
  10240: "Windows 10, version 1507",
  9600: "Windows 8.1",
  7601: "Windows 7 SP1",
};

function osName(build) {
  if (OS_BUILDS[build]) return OS_BUILDS[build];
  if (build >= 22000) return "Windows 11";
  if (build >= 10240) return "Windows 10";
  if (build > 0) return "Windows";
  return "Windows (unknown version)";
}

// Architecture as a lay reader expects it.
function archLabel(arch) {
  if (arch === "x64") return "64-bit";
  if (arch === "x86") return "32-bit";
  return arch || "unknown architecture";
}

function formatBytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "size unknown";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 8-digit zero-padded stop-code hex (for the Advanced view): 0x000000D1. */
function formatStopCode(code) {
  return "0x" + (code >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

function lowerFirst(s) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

// Map the parser's name-level confidence onto the report's calibrated scale
// (§7.4). v1 recovers module names without load addresses, so a single
// third-party driver caps at *medium*; several at *low*; none at *none*.
function confidenceOf(modules) {
  switch (modules.confidence) {
    case "third-party-present":
      return "medium";
    case "third-party-candidates":
      return "low";
    default:
      return "none";
  }
}

function moduleLabel(m) {
  return m.vendor ? `${m.vendor} (${m.name})` : m.name;
}

// The one-line Machine summary (§7.5 part 3), shared by the text report and the
// on-screen view model so they never drift.
function machineLine(header) {
  return `${osName(header.build)} (build ${header.build}) · ${archLabel(header.arch)} · ${header.processorCount} core${header.processorCount === 1 ? "" : "s"}`;
}

// Section header + dashed underline, matching the §8 template's title style.
function titleBlock(line) {
  return [line, "-".repeat(line.length)];
}

/**
 * The concise, paste-ready report (§8). `opts.toolVersion` (extension version)
 * and `opts.analyzedAt` (epoch ms) are injected by the UI so this stays pure.
 * `opts.includeAdvanced` appends the detected-driver list + raw parameters for
 * users who explicitly want them (§7.5) — off by default (Simple view).
 */
export function buildReport(result, { toolVersion = "1.0", analyzedAt = Date.now(), includeAdvanced = false } = {}) {
  if (!result || !result.ok) return result?.declined || "No analysis available.";

  const { header, knowledge, modules, isLive } = result;
  const name = knowledge?.name || "(unrecognized stop code)";
  const conf = confidenceOf(modules);
  const L = [];

  // Title.
  L.push(
    ...titleBlock(
      `${isLive ? "Windows Live Diagnostic Snapshot" : "Windows Crash Analysis"} — ${result.fileName || "(unnamed dump)"}`,
    ),
  );
  L.push("");

  // 1) What happened.
  L.push("What happened");
  L.push(wrapIndent(whatHappened(knowledge, isLive)));
  L.push("");

  // 2) Most likely source (+ confidence tag).
  const confTag =
    conf === "none" ? "(no specific driver)" : `(${conf} confidence)`;
  L.push(`Most likely source  ${confTag}`);
  for (const line of sourceLines(modules, knowledge, conf, isLive)) {
    // Hang the "→ …" continuation under its text, matching the §8 template.
    if (line.startsWith("→ ")) L.push(wrapIndent(line, "  ", "    "));
    else L.push(wrapIndent(line));
  }
  L.push("");

  // 3) Machine.
  L.push("Machine");
  L.push(`  ${machineLine(header)}`);
  L.push("");

  // 4) How to fix.
  L.push("How to fix");
  fixSteps(knowledge, isLive).forEach((step, i) => L.push(wrapIndent(step, `  ${i + 1}. `, "     ")));
  L.push("");

  // 5) Technical details (provenance + honest limits).
  L.push("Technical details");
  const codeLabel = isLive ? "Live dump code" : "Stop code";
  let codeLine = `${codeLabel}: ${name} (${header.bugcheckHex})`;
  if (header.variantBits) codeLine += ` · variant 0x${header.variantBits.toString(16).toUpperCase()}`;
  L.push(`  ${codeLine}`);
  L.push("  Analyzed locally — dump not uploaded · module-level analysis (no symbols)");
  const stamp = new Date(analyzedAt).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  L.push(`  ${TOOL_NAME} v${toolVersion} · knowledge base ${KB_VERSION} · analyzed ${stamp}`);

  if (includeAdvanced) {
    L.push("");
    L.push("Advanced details");
    L.push("----------------");
    L.push(buildDetails(result));
  }

  return L.join("\n");
}

/**
 * Structured Simple-view model for the on-screen card (§7.6), built from the
 * same helpers as the text report so the two never disagree. Pure; the UI turns
 * these strings into DOM. Returns null for a non-ok result (the UI shows the
 * decline message directly).
 */
export function viewModel(result) {
  if (!result || !result.ok) return null;
  const { header, knowledge, modules, isLive } = result;
  const conf = confidenceOf(modules);
  return {
    isLive,
    title: isLive ? "Live diagnostic snapshot — not a crash" : "Crash analysis",
    codeName: knowledge?.name || "(unrecognized stop code)",
    codeHex: header.bugcheckHex,
    whatHappened: whatHappened(knowledge, isLive),
    confidence: conf, // "high" | "medium" | "low" | "none"
    confidenceLabel: conf === "none" ? "no specific driver" : `${conf} confidence`,
    sourceLines: sourceLines(modules, knowledge, conf, isLive),
    machine: machineLine(header),
    fixSteps: fixSteps(knowledge, isLive),
  };
}

function whatHappened(knowledge, isLive) {
  if (isLive) {
    const because = knowledge?.meaning ? ` because ${lowerFirst(knowledge.meaning)}` : ` (${knowledge?.name || "recoverable condition"}).`;
    return `Not a crash — the PC kept running. Windows saved a live diagnostic snapshot${because}`;
  }
  if (knowledge?.meaning) return `Windows crashed. ${knowledge.meaning}`;
  if (knowledge) {
    return `Windows crashed with stop code ${knowledge.name}. No plain-language description is curated for this code yet — see How to fix and the technical details below.`;
  }
  return "Windows crashed, but this stop code is not in the reference table, so it can't be named. The extracted parameters are in the Advanced view.";
}

function sourceLines(modules, knowledge, conf, isLive) {
  if (conf === "medium" && modules.suspect) {
    const tail = isLive ? "stopped responding and was reset." : "the only non-Windows driver found in the dump.";
    return [
      `${moduleLabel(modules.suspect)} — leading candidate; ${tail}`,
      "v1 matches by name, not the exact fault address, so treat this as likely, not proven.",
    ];
  }
  if (conf === "low") {
    const first = modules.thirdParty[0];
    const others = modules.thirdParty.slice(1).map((m) => m.name);
    const lines = [
      `Possibly ${moduleLabel(first)} — one of several third-party drivers present; this stop code can't be pinned to one without symbols.`,
    ];
    if (others.length) lines.push(`Other drivers present: ${others.join(", ")}.`);
    lines.push("→ If you have other recent dumps from this PC, a driver that recurs is the more reliable suspect.");
    return lines;
  }
  // none — phrase from the code's source category.
  const cat = knowledge?.category;
  if (cat === "hardware") {
    return ["Hardware — the fault came from the CPU/platform, not a driver. Most often bad RAM, overheating, or unstable power/overclock."];
  }
  if (cat === "memory") {
    return ["No specific driver implicated — this stop code most often means defective memory (RAM)."];
  }
  return ["No specific driver implicated; this points at memory or hardware. See How to fix, and open the dump in WinDbg for the full stack."];
}

function fixSteps(knowledge, isLive) {
  if (knowledge?.nextSteps?.length) return knowledge.nextSteps.slice(0, 3);
  // Generic fallback for name-only / uncurated codes.
  const verb = isLive ? "stop the hangs" : "stop the crashes";
  return [
    "If a specific driver is named above, update it (or roll it back if the trouble started recently), then restart.",
    `To rule out memory, press Win+R and run  mdsched  (Windows Memory Diagnostic).`,
    `If it continues, repair system files: open Command Prompt as admin and run  sfc /scannow  — and check other recent dumps to ${verb}.`,
  ];
}

/**
 * Verbose breakdown for the in-app "Advanced" expander (§7.6): the raw four
 * parameters with per-code labels, the faulting instruction address, and the
 * full recovered module list. Never part of the concise report or the download
 * default — present for the rare power user.
 */
export function buildDetails(result) {
  if (!result || !result.ok) return "";
  const { header, knowledge, faultAddress, modules } = result;
  const L = [];

  L.push(`Stop code: ${formatStopCode(header.bugcheckCode)} ${knowledge?.name || "(unrecognized)"}`);
  if (header.rawBugcheckCode !== header.bugcheckCode) {
    L.push(`Raw code as stored: ${formatStopCode(header.rawBugcheckCode)} (variant bits folded to base for lookup)`);
  }
  L.push("");

  L.push("Parameters:");
  for (let i = 0; i < 4; i++) {
    const label = knowledge?.params?.[i] || `Parameter ${i + 1}`;
    L.push(`  ${i + 1}: ${formatHex64(header.params[i])}   (${label})`);
  }
  if (faultAddress != null) {
    L.push("");
    L.push(`Faulting instruction address: ${formatHex64(faultAddress)}`);
    L.push("  (v1 recovers module names without load addresses, so this isn't mapped to a module — open in WinDbg for that.)");
  }
  L.push("");

  if (modules.list.length) {
    L.push(`Loaded modules recovered (${modules.list.length}):`);
    for (const m of modules.list) {
      const tag = m.vendor ? ` — ${m.vendor}` : m.generic ? " — Windows (generic)" : "";
      L.push(`  ${m.name}${tag}`);
    }
  } else {
    L.push("No module names were recovered from this dump (header headline only).");
  }

  if (result.warnings?.length) {
    L.push("");
    L.push("Notes:");
    for (const w of result.warnings) L.push(`  - ${w}`);
  }

  return L.join("\n");
}

// ===========================================================================
// Batch / multi-dump (§7.1, §7.6, §8). An "entry" is { file, result } where
// `file` carries at least { name }, and `result` is an analyzeDump() output
// (ok or declined). These helpers stay pure so the UI and the combined-download
// share one source of truth; cross-dump recurrence is the strongest single
// accuracy signal (§7.4), surfaced but never overstated.
// ===========================================================================

/**
 * Compact, scannable fields for one batch row (§8 batch table): the filename,
 * the stop-code name + hex (with a "live" tag), a one-word suspect label, and
 * the calibrated confidence. Declined files become an honest error row.
 */
export function rowFields(entry) {
  const { file, result } = entry;
  const fileName = file?.name || result?.fileName || "(unnamed)";
  if (!result || !result.ok) {
    return { fileName, ok: false, error: result?.declined || "Could not read this file.", confidence: "—" };
  }
  const { header, knowledge, modules, isLive } = result;
  const codeName = knowledge?.name || "(unrecognized stop code)";
  const codeHex = isLive ? `${header.bugcheckHex}, live` : header.bugcheckHex;
  const conf = confidenceOf(modules);

  let suspect;
  if (conf === "medium" && modules.suspect) suspect = modules.suspect.name;
  else if (conf === "low") suspect = "several drivers";
  else suspect = knowledge?.category === "hardware" ? "hardware — no driver" : "no driver";

  return { fileName, ok: true, isLive, codeName, codeHex, suspect, confidence: conf };
}

/**
 * Roll a batch of entries into an overview (§8): counts of crash vs live vs
 * unreadable, and the suspect that recurs across the most dumps — the single
 * strongest signal (§7.4). `recurring` is null unless a third-party driver shows
 * up in at least two readable dumps.
 */
export function summarizeBatch(entries) {
  const ok = entries.filter((e) => e.result?.ok);
  const liveCount = ok.filter((e) => e.result.isLive).length;
  const unreadable = entries.length - ok.length;

  // Tally third-party drivers across readable dumps (each driver counted at most
  // once per dump), so recurrence reflects dumps, not raw mentions.
  const tally = new Map(); // basename → { count, vendor }
  for (const e of ok) {
    const seen = new Set();
    for (const m of e.result.modules.thirdParty) {
      if (seen.has(m.name)) continue;
      seen.add(m.name);
      const cur = tally.get(m.name) || { count: 0, vendor: m.vendor || null };
      cur.count += 1;
      tally.set(m.name, cur);
    }
  }
  let recurring = null;
  for (const [name, { count, vendor }] of tally) {
    if (count >= 2 && (!recurring || count > recurring.count)) recurring = { name, vendor, count };
  }

  return {
    total: entries.length,
    readable: ok.length,
    crashes: ok.length - liveCount,
    liveCount,
    unreadable,
    recurring, // { name, vendor, count } | null
  };
}

/**
 * One combined, paste-ready text file for a whole batch (§7.5): a short overview
 * header (counts + any recurring suspect) followed by one concise per-dump block,
 * separated by rules. Single-entry batches just return that one report.
 */
export function buildBatchReport(entries, opts = {}) {
  if (entries.length === 1) return buildReport(entries[0].result, opts);

  const s = summarizeBatch(entries);
  const L = [];
  const head = `${s.total} dump${s.total === 1 ? "" : "s"} analyzed — ${s.crashes} crash${s.crashes === 1 ? "" : "es"}, ${s.liveCount} live snapshot${s.liveCount === 1 ? "" : "s"}${s.unreadable ? `, ${s.unreadable} unreadable` : ""}`;
  L.push(...titleBlock(head));
  if (s.recurring) {
    const label = s.recurring.vendor ? `${s.recurring.name} (${s.recurring.vendor})` : s.recurring.name;
    L.push(`Recurring suspect: ${label} — in ${s.recurring.count} of ${s.readable}`);
  }
  L.push("");
  L.push("A recurring driver across dumps is a stronger suspect than any single dump (§7.4).");
  L.push("");

  entries.forEach((entry, i) => {
    L.push("=".repeat(78));
    L.push("");
    if (!entry.result?.ok) {
      L.push(...titleBlock(`${entry.file?.name || "(unnamed)"} — could not analyze`));
      L.push(wrapIndent(entry.result?.declined || "Unrecognized or unreadable file."));
    } else {
      L.push(buildReport(entry.result, opts));
    }
    if (i < entries.length - 1) L.push("");
  });

  return L.join("\n");
}

// --- wrapping helpers ------------------------------------------------------

// Wrap a paragraph to ~76 cols. `first` is the prefix for the first line
// (default two-space indent); `cont` is the prefix for continuation lines.
function wrapIndent(text, first = "  ", cont = "  ", width = 76) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = first;
  let prefixLen = first.length;
  for (const w of words) {
    if (line.length > prefixLen && line.length + w.length + 1 > width) {
      lines.push(line);
      line = cont + w;
      prefixLen = cont.length;
    } else {
      line += (line.length === prefixLen ? "" : " ") + w;
    }
  }
  if (line.trim()) lines.push(line);
  return lines.join("\n");
}
