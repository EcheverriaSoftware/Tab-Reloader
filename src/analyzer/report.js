// Plain-text report builder for the DMP File Analyzer (PRD-DMP-Analysis §7.5/§8).
// Pure: takes the structured result from `analyzeDump()` and returns a single
// self-contained, paste-ready string. No chrome.*, no DOM — the UI owns delivery
// (download + clipboard). The structure (headline → stop code → source → causes →
// next steps → modules → limits → provenance) is the spec; wording can evolve.

import { KB_VERSION } from "./bugcheck-kb.js";
import { formatHex64 } from "./dmp-parser.js";

const TOOL_NAME = "DMP Analyzer";

// Known OS build numbers → marketing name. Build is the dump header's minor
// version; unknown builds fall back to "Windows (build N)".
const OS_BUILDS = {
  26100: "Windows 11 24H2",
  22631: "Windows 11 23H2",
  22621: "Windows 11 22H2",
  22000: "Windows 11 21H2",
  19045: "Windows 10 22H2",
  19044: "Windows 10 21H2",
  19043: "Windows 10 21H1",
  19042: "Windows 10 20H2",
  19041: "Windows 10 2004",
  18363: "Windows 10 1909",
  17763: "Windows 10 1809 / Server 2019",
  14393: "Windows 10 1607 / Server 2016",
  10240: "Windows 10 1507",
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

function formatBytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "size unknown";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 8-digit zero-padded stop-code hex, matching how Windows shows it: 0x000000D1. */
function formatStopCode(code) {
  return "0x" + (code >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

/** Display label for a module: "name  (vendor)" or just "name" when unknown. */
function moduleLine(m) {
  if (m.vendor) return `${m.name}  (${m.vendor})`;
  if (m.generic) return `${m.name}  (Windows — generic)`;
  return m.name;
}

/**
 * Build the full plain-text report for a successful analysis result.
 * `opts.toolVersion` (the extension version) and `opts.analyzedAt` (epoch ms)
 * are injected by the UI so this module stays pure.
 */
export function buildReport(result, { toolVersion = "1.0", analyzedAt = Date.now() } = {}) {
  if (!result || !result.ok) {
    return result?.declined || "No analysis available.";
  }

  const { header, knowledge, faultAddress, modules } = result;
  const L = []; // lines

  L.push("WINDOWS CRASH DUMP — ANALYSIS SUMMARY");
  L.push("=====================================");
  L.push(`File:        ${result.fileName || "(unnamed)"}   (kernel dump, ${formatBytes(result.fileSize)})`);
  L.push(
    `System:      ${osName(header.build)} (build ${header.build}), ${header.arch}, ${header.processorCount} CPU${header.processorCount === 1 ? "" : "s"}`,
  );
  L.push("");

  // --- Stop code -----------------------------------------------------------
  L.push("STOP CODE");
  L.push("---------");
  L.push(`${formatStopCode(header.bugcheckCode)}  ${knowledge ? knowledge.name : "(unrecognized stop code)"}`);
  if (knowledge) {
    L.push(wrap(knowledge.meaning));
  } else {
    L.push(wrap("No curated guidance for this stop code yet — the extracted facts are below."));
  }
  L.push("");
  L.push("Parameters:");
  for (let i = 0; i < 4; i++) {
    const label = knowledge?.params?.[i] || `Parameter ${i + 1}`;
    L.push(`  ${i + 1}: ${formatHex64(header.params[i])}   (${label})`);
  }
  L.push("");

  // --- Most likely source --------------------------------------------------
  L.push("MOST LIKELY SOURCE");
  L.push("------------------");
  if (modules.suspect) {
    L.push(`Suspect module:  ${moduleLine(modules.suspect)}`);
  } else if (modules.confidence === "third-party-candidates") {
    L.push("Candidate drivers (could not be ranked without symbols):");
    for (const m of modules.thirdParty) L.push(`  ${moduleLine(m)}`);
  } else {
    L.push("No third-party driver clearly implicated.");
  }
  L.push(indentWrap(modules.rationale));
  if (faultAddress != null) {
    L.push(
      indentWrap(
        `The faulting instruction address is ${formatHex64(faultAddress)} (extracted from the stop-code ` +
          `parameters). v1 cannot map it to a module — open the dump in WinDbg for that.`,
      ),
    );
  }
  L.push("");

  // --- Probable causes -----------------------------------------------------
  if (knowledge?.causes?.length) {
    L.push("PROBABLE CAUSES (most to least common for this stop code)");
    knowledge.causes.forEach((c, i) => L.push(`  ${i + 1}. ${c}`));
    L.push("");
  }

  // --- Recommended next steps ----------------------------------------------
  if (knowledge?.nextSteps?.length) {
    L.push("RECOMMENDED NEXT STEPS");
    for (const s of knowledge.nextSteps) L.push(`  - ${s}`);
    L.push("");
  }

  // --- Loaded modules ------------------------------------------------------
  if (modules.list.length) {
    L.push("LOADED MODULES RECOVERED FROM THE DUMP");
    for (const m of modules.list) L.push(`  ${moduleLine(m)}`);
    L.push("");
  }

  // --- Limitations / honesty notes -----------------------------------------
  const notes = [
    "Module-level analysis only — no symbolicated call stack. For function names " +
      "and line numbers, open this dump in WinDbg.",
    "Module recovery is name-level (load addresses are not resolved in v1), so the " +
      "suspect is a hedged candidate, not a proven verdict.",
    ...(result.warnings || []),
  ];
  L.push("LIMITATIONS");
  for (const n of notes) L.push(`  - ${n}`);
  L.push("");

  // --- Provenance footer ---------------------------------------------------
  L.push("-----");
  const stamp = new Date(analyzedAt).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  L.push(
    `Generated by ${TOOL_NAME} v${toolVersion}  ·  knowledge base ${KB_VERSION}  ·  ${stamp}  ·  ` +
      "analyzed locally, dump not uploaded  ·  module-level analysis (no symbols)",
  );

  return L.join("\n");
}

// Wrap a paragraph to ~78 cols so the report reads cleanly pasted into a ticket.
function wrap(text, width = 78, indent = "") {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = indent;
  for (const w of words) {
    if (line.length + w.length + 1 > width && line.trim()) {
      lines.push(line);
      line = indent + w;
    } else {
      line += (line === indent ? "" : " ") + w;
    }
  }
  if (line.trim()) lines.push(line);
  return lines.join("\n");
}

function indentWrap(text) {
  return wrap(text, 78, "  ");
}
