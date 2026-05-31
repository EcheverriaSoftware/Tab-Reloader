// Hand-rolled, dependency-free parser for Windows crash dumps (PRD-DMP-Analysis
// §7.1/§7.2/§11). Pure logic over a DataView — no chrome.*, no DOM, no network —
// so it runs anywhere and is importable under node for testing.
//
// Design contract (the whole point of v1):
//   - The HEADLINE is guaranteed. The bugcheck code, its four parameters, the
//     architecture, processor count, and OS build live at FIXED OFFSETS in the
//     dump header and are recovered with a handful of little-endian reads. This
//     never needs Windows tooling and is deterministic.
//   - Module recovery is BEST-EFFORT and degrades honestly. Rather than trust a
//     version-fragile structured triage-stream layout, v1 recovers loaded-module
//     *names* by scanning the dump's triage region for `*.sys/.exe/.dll` strings
//     (both ASCII and UTF-16LE). This is robust across Windows versions but
//     yields names only — not load addresses — so precise address→module
//     attribution is reported as a known limitation, not faked (§10, §12).
//
// User-mode `MDMP` dumps are detected and politely declined (kernel dumps are the
// v1 target; MDMP is a documented fast-follow).

import { isGenericOsModule, moduleBasename, vendorForModule } from "./module-vendors.js";
import { lookupBugcheck, normalizeCode } from "./bugcheck-kb.js";

// 8-byte signatures at file offset 0.
const SIG_KERNEL64 = "PAGEDU64"; // 64-bit kernel dump
const SIG_KERNEL32 = "PAGEDUMP"; // 32-bit kernel dump
const SIG_MINIDUMP = "MDMP"; // user-mode minidump container (4 bytes)

// Fixed field offsets within DUMP_HEADER64 (PRD §7.2). Little-endian throughout.
const K64 = {
  majorVersion: 0x08,
  minorVersion: 0x0c, // ≈ OS build number (e.g. 26100)
  machineType: 0x30,
  processorCount: 0x34,
  bugcheckCode: 0x38,
  param0: 0x40, // four 8-byte parameters at 0x40, 0x48, 0x50, 0x58
  headerSize: 0x2000, // triage data (when present) follows the header
};

// Fixed field offsets within the older 32-bit DUMP_HEADER32.
const K32 = {
  majorVersion: 0x08,
  minorVersion: 0x0c,
  machineType: 0x20,
  processorCount: 0x24,
  bugcheckCode: 0x28,
  param0: 0x2c, // four 4-byte parameters at 0x2c, 0x30, 0x34, 0x38
  headerSize: 0x1000,
};

// Bugcheck codes whose Nth parameter (0-based) is the faulting *instruction*
// address — a genuinely useful extracted fact to surface. Without module load
// addresses we can't say which module it lands in, but we can still report it.
const FAULT_ADDR_PARAM = { "0xA": 3, "0xD1": 3, "0x50": 2, "0x1E": 1, "0x3B": 1, "0x7E": 1 };

// IMAGE_FILE_MACHINE_* → human architecture label.
const ARCH = { 0x014c: "x86", 0x8664: "x64", 0xaa64: "ARM64", 0x01c0: "ARM", 0x01c4: "ARM (Thumb-2)", 0x0200: "IA64" };

/** Read `len` bytes at `off` as a Latin-1/ASCII string (for signatures). */
function readAscii(view, off, len) {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
  return s;
}

/** The 8-byte signature, or "" if the buffer is too small. */
function readSignature(view) {
  if (view.byteLength < 8) return "";
  return readAscii(view, 0, 8);
}

/** Map a raw signature to a dump family. */
export function detectFamily(view) {
  const sig = readSignature(view);
  if (sig.startsWith(SIG_KERNEL64)) return "kernel64";
  if (sig.startsWith(SIG_KERNEL32)) return "kernel32";
  if (sig.startsWith(SIG_MINIDUMP)) return "minidump";
  return "unknown";
}

/** Lowercase 16-digit hex for a BigInt address/value: 1234n → "0x0000000000001234". */
export function formatHex64(value) {
  const big = typeof value === "bigint" ? value : BigInt(value >>> 0);
  return "0x" + big.toString(16).padStart(16, "0").toUpperCase();
}

/**
 * Decode the fixed-offset header headline for a kernel dump. Always succeeds for
 * a recognized kernel signature (it only reads a few fixed offsets); throws only
 * if the buffer is shorter than the header fields it needs.
 */
function parseKernelHeader(view, family) {
  const o = family === "kernel32" ? K32 : K64;
  const wide = family !== "kernel32";
  const minBytes = o.param0 + (wide ? 32 : 16);
  if (view.byteLength < minBytes) {
    throw new Error("Dump header is truncated — not enough bytes for the bugcheck fields.");
  }

  const params = [];
  for (let i = 0; i < 4; i++) {
    params.push(
      wide
        ? view.getBigUint64(o.param0 + i * 8, true)
        : BigInt(view.getUint32(o.param0 + i * 4, true) >>> 0),
    );
  }

  const bugcheckCode = view.getUint32(o.bugcheckCode, true) >>> 0;
  const machineType = view.getUint32(o.machineType, true) >>> 0;

  return {
    bugcheckCode,
    bugcheckHex: normalizeCode(bugcheckCode),
    params, // BigInt[4]
    machineType,
    arch: ARCH[machineType] || `unknown (0x${machineType.toString(16)})`,
    processorCount: view.getUint32(o.processorCount, true) >>> 0,
    majorVersion: view.getUint32(o.majorVersion, true) >>> 0,
    build: view.getUint32(o.minorVersion, true) >>> 0, // minor version ≈ OS build
    headerSize: o.headerSize,
  };
}

// Filename token: a basename of a Windows module. Conservative on purpose so we
// don't harvest random memory: must end in a known kernel-module extension.
const FILENAME_RE = /[A-Za-z0-9_][A-Za-z0-9_.\-]{0,62}\.(sys|exe|dll)/gi;

/**
 * Project a byte range to a searchable string, mapping unprintable bytes to "\n"
 * so the filename regex can't span across them.
 *   - encoding "ascii":  one char per byte.
 *   - encoding "utf16le": one char per 2 bytes when the high byte is 0 (the common
 *     case for ASCII-range module names stored as UTF-16, as Windows does).
 */
function projectString(view, start, end, encoding) {
  const printable = (b) => b >= 0x20 && b <= 0x7e;
  let s = "";
  if (encoding === "ascii") {
    for (let i = start; i < end; i++) {
      const b = view.getUint8(i);
      s += printable(b) ? String.fromCharCode(b) : "\n";
    }
  } else {
    for (let i = start; i + 1 < end; i += 2) {
      const lo = view.getUint8(i);
      const hi = view.getUint8(i + 1);
      s += hi === 0 && printable(lo) ? String.fromCharCode(lo) : "\n";
    }
  }
  return s;
}

/**
 * Recover loaded-module *names* from the dump's triage region by scanning for
 * `*.sys/.exe/.dll` tokens in both ASCII and UTF-16LE. Robust to version drift;
 * returns names only (no load addresses). De-duped by lowercase basename,
 * insertion-ordered, and capped to keep the report sane.
 *
 * Scans from the header end to the end of whatever buffer was provided (the UI
 * may pass only a bounded prefix of a very large dump — §7.1), so the result
 * carries a `truncated` flag when the buffer didn't cover the whole file.
 */
export function scanModuleNames(view, headerSize, fileSize) {
  const start = Math.min(headerSize, view.byteLength);
  const end = view.byteLength;
  const seen = new Map(); // basename(lower) → display name
  const CAP = 500;

  for (const encoding of ["ascii", "utf16le"]) {
    const projected = projectString(view, start, end, encoding);
    for (const match of projected.matchAll(FILENAME_RE)) {
      const base = moduleBasename(match[0]);
      if (!base || seen.has(base)) continue;
      seen.set(base, base);
      if (seen.size >= CAP) break;
    }
    if (seen.size >= CAP) break;
  }

  return {
    names: [...seen.values()],
    truncated: typeof fileSize === "number" && fileSize > view.byteLength,
  };
}

/**
 * Build the module list + a hedged probable-cause assessment from recovered
 * names (§7.4). Because v1 recovers names without load addresses, attribution is
 * "which third-party drivers are present", explicitly hedged — never an
 * address-proven verdict, and never a manufactured suspect when none stand out.
 */
function assessModules(names) {
  const list = names.map((name) => ({
    name,
    generic: isGenericOsModule(name),
    vendor: vendorForModule(name),
  }));

  const thirdParty = list.filter((m) => !m.generic);

  let suspect = null;
  let confidence = "none";
  let rationale;
  if (thirdParty.length === 1) {
    suspect = thirdParty[0];
    confidence = "third-party-present";
    rationale =
      "It is the only non-Windows driver recovered from the dump, which makes it the leading candidate. " +
      "This is name-level attribution, not an address-proven verdict.";
  } else if (thirdParty.length > 1) {
    confidence = "third-party-candidates";
    rationale =
      "Several third-party drivers were recovered. Any of them could be involved; " +
      "v1 reports names only and cannot rank them by the crash address (open this dump in WinDbg for that).";
  } else if (list.length > 0) {
    rationale =
      "Only generic Windows modules were recovered — no third-party driver clearly implicated. " +
      "This stop code may point at memory or hardware rather than a driver.";
  } else {
    rationale = "No module names could be recovered from this dump.";
  }

  return {
    list,
    thirdParty,
    suspect, // {name, vendor, generic} | null
    confidence, // "third-party-present" | "third-party-candidates" | "none"
    rationale,
    hasAddresses: false, // v1 recovers names only; see module limitation note
  };
}

/**
 * Top-level analysis entry point. `buffer` is an ArrayBuffer holding either the
 * whole dump or a bounded prefix; `fileSize`/`fileName` are the original file's
 * metadata from the File API. Returns a structured result; it does not throw for
 * recognized dumps — failures become honest fields on the result (§10).
 */
export function analyzeDump(buffer, { fileName = "", fileSize } = {}) {
  const view = new DataView(buffer);
  const family = detectFamily(view);
  const warnings = [];

  if (family === "minidump") {
    return {
      ok: false,
      family,
      fileName,
      fileSize,
      declined:
        "This is a user-mode application crash dump (MDMP). v1 analyzes Windows " +
        "kernel (BSOD) dumps — user-mode dump support is a planned fast-follow.",
    };
  }
  if (family === "unknown") {
    return {
      ok: false,
      family,
      fileName,
      fileSize,
      declined:
        "Unrecognized file — this does not start with a Windows kernel dump " +
        "signature (PAGEDU64 / PAGEDUMP). It may not be a .dmp, or it may be corrupt.",
    };
  }

  let header;
  try {
    header = parseKernelHeader(view, family);
  } catch (err) {
    return {
      ok: false,
      family,
      fileName,
      fileSize,
      declined: err.message,
    };
  }

  if (family === "kernel32") {
    warnings.push(
      "32-bit (PAGEDUMP) dump: the headline is decoded from the legacy header " +
        "layout. Treat module recovery as best-effort.",
    );
  }

  // Faulting instruction address, when this stop code encodes one in its params.
  let faultAddress = null;
  const faultIdx = FAULT_ADDR_PARAM[header.bugcheckHex];
  if (faultIdx != null && header.params[faultIdx] != null) {
    faultAddress = header.params[faultIdx];
  }

  // Best-effort module recovery + hedged attribution.
  const scan = scanModuleNames(view, header.headerSize, fileSize);
  const modules = assessModules(scan.names);
  if (scan.truncated) {
    warnings.push(
      "Only part of this dump was read (it is large for in-browser analysis), so " +
        "the module list may be incomplete. The headline above is still complete.",
    );
  }
  if (modules.list.length === 0) {
    warnings.push(
      "No module names were recovered from the dump body — only the header " +
        "headline is available for this file.",
    );
  }

  return {
    ok: true,
    family,
    fileName,
    fileSize,
    header,
    knowledge: lookupBugcheck(header.bugcheckCode), // curated entry or null
    faultAddress, // BigInt | null
    modules, // { list, thirdParty, suspect, confidence, rationale, hasAddresses }
    warnings,
  };
}
