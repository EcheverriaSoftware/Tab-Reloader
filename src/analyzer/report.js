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

// Section header + dashed underline, matching the §8 template's title style.
function titleBlock(line) {
  return [line, "-".repeat(line.length)];
}

/**
 * The concise, paste-ready report (§8). `opts.toolVersion` (extension version)
 * and `opts.analyzedAt` (epoch ms) are injected by the UI so this stays pure.
 */
export function buildReport(result, { toolVersion = "1.0", analyzedAt = Date.now() } = {}) {
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
    L.push(wrapIndent(line));
  }
  L.push("");

  // 3) Machine.
  L.push("Machine");
  L.push(
    `  ${osName(header.build)} (build ${header.build}) · ${archLabel(header.arch)} · ${header.processorCount} core${header.processorCount === 1 ? "" : "s"}`,
  );
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

  return L.join("\n");
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
