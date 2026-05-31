// Bugcheck (stop code) knowledge base for the DMP File Analyzer.
//
// This is DATA, not logic (PRD-DMP-Analysis §7.3): a curated, versioned table
// mapping each known kernel bugcheck code to its symbolic name, a plain-English
// meaning, per-parameter labels (where the four parameters are well-defined),
// a ranked list of likely causes, and recommended next steps. It is kept
// reviewable and extendable independently of the parser, and intentionally
// carries no chrome.* / DOM access so it can be imported in any context.
//
// Keys are the canonical hex string the report shows for the code, produced by
// `normalizeCode()` below (e.g. 0xD1 → "0xD1", 0x133 → "0x133"). Codes absent
// from the table still get a useful report (code + params + modules + an honest
// "no curated guidance yet" note) — never an invented explanation (§10, §12).

/** Bumped whenever the curated guidance below changes; cited in the report footer. */
export const KB_VERSION = "2026-05";

// Per-parameter labels reused across the IRQL-family stop codes (0xA / 0xD1).
const IRQL_PARAMS = [
  "Memory address that was referenced",
  "IRQL at the time of the reference",
  "Access type (0 = read, 1 = write, 8 = execute)",
  "Address of the instruction that referenced memory",
];

// Generic exception-family parameter labels (0x1E / 0x7E).
const EXCEPTION_PARAMS = [
  "Exception code that was not handled",
  "Address where the exception occurred",
  "Exception record (0 = not supplied)",
  "Context record (0 = not supplied)",
];

export const BUGCHECKS = Object.freeze({
  "0xA": {
    name: "IRQL_NOT_LESS_OR_EQUAL",
    meaning:
      "Kernel-mode code accessed pageable or invalid memory at an interrupt request level (IRQL) too high to allow it — usually a bad pointer in a driver.",
    params: IRQL_PARAMS,
    causes: [
      "Faulty or buggy device driver dereferencing a bad pointer",
      "Defective or mismatched system memory (RAM)",
      "Corrupted system service or antivirus/filter driver",
    ],
    nextSteps: [
      "Identify the implicated driver below; update or roll it back, then reboot and retest.",
      "If no driver is implicated, run a memory diagnostic (e.g. Windows Memory Diagnostic / MemTest86).",
      "For a full symbolicated call stack, open this dump in WinDbg.",
    ],
  },
  "0xD1": {
    name: "DRIVER_IRQL_NOT_LESS_OR_EQUAL",
    meaning:
      "A kernel driver tried to access pageable or invalid memory while running at an interrupt request level (IRQL) too high to allow it.",
    params: IRQL_PARAMS,
    causes: [
      "Faulty, outdated, or incompatible device driver (most common)",
      "Defective system memory (RAM)",
      "Underlying hardware fault",
    ],
    nextSteps: [
      "Identify the implicated driver below; update or roll it back, then reboot and retest.",
      "If crashes continue with no driver implicated, run a memory diagnostic.",
      "For a full symbolicated call stack, open this dump in WinDbg.",
    ],
  },
  "0x50": {
    name: "PAGE_FAULT_IN_NONPAGED_AREA",
    meaning:
      "The system referenced memory that does not exist (an invalid address). Often bad RAM, or a driver using a freed/invalid pointer.",
    params: [
      "Memory address that was referenced",
      "Access type (0 = read, 1 = write, 2 = execute)",
      "Address of the instruction that referenced memory",
      "Reserved / fault type",
    ],
    causes: [
      "Defective system memory (RAM) — a leading cause for this code",
      "Faulty device driver or system service using an invalid pointer",
      "Corrupted NTFS volume or failing storage",
    ],
    nextSteps: [
      "Run a memory diagnostic first — this stop code frequently points at bad RAM.",
      "If a third-party driver is implicated below, update or roll it back.",
      "Check the disk for errors (chkdsk) if storage corruption is suspected.",
    ],
  },
  "0x1E": {
    name: "KMODE_EXCEPTION_NOT_HANDLED",
    meaning:
      "A kernel-mode program generated an exception that the error handler did not catch.",
    params: EXCEPTION_PARAMS,
    causes: [
      "Faulty device driver or system service",
      "Defective system memory (RAM)",
      "Incompatible or corrupted software at the kernel level",
    ],
    nextSteps: [
      "If a third-party driver is implicated below, update or roll it back.",
      "Run a memory diagnostic if no driver is clearly implicated.",
      "For the unhandled exception's full context, open this dump in WinDbg.",
    ],
  },
  "0x3B": {
    name: "SYSTEM_SERVICE_EXCEPTION",
    meaning:
      "An exception occurred while executing a routine that transitions from non-privileged to privileged (kernel) code.",
    params: [
      "Exception that caused the bugcheck",
      "Address of the instruction that caused the bugcheck",
      "Context record of the exception",
      "Reserved",
    ],
    causes: [
      "Faulty or outdated device driver",
      "Corrupted system files",
      "Defective system memory (RAM)",
    ],
    nextSteps: [
      "Update or roll back the implicated driver below, then retest.",
      "Run System File Checker (sfc /scannow) if corruption is suspected.",
      "For the faulting instruction's context, open this dump in WinDbg.",
    ],
  },
  "0x7E": {
    name: "SYSTEM_THREAD_EXCEPTION_NOT_HANDLED",
    meaning:
      "A system thread generated an exception that the error handler did not catch.",
    params: EXCEPTION_PARAMS,
    causes: [
      "Faulty, outdated, or incompatible device driver",
      "Corrupted system files",
      "Defective system memory (RAM)",
    ],
    nextSteps: [
      "Update or roll back the implicated driver below, then retest.",
      "Run a memory diagnostic and System File Checker if no driver is implicated.",
      "For the full call stack, open this dump in WinDbg.",
    ],
  },
  "0x133": {
    name: "DPC_WATCHDOG_VIOLATION",
    meaning:
      "A Deferred Procedure Call (DPC) ran too long, or the system spent too long at an elevated IRQL — typically a driver that stalls or spins.",
    params: [
      "Watchdog type (0 = single DPC over time limit, 1 = system cumulatively over limit)",
      "DPC time-limit / watchdog period (in ticks)",
      "Cumulative time (or 0)",
      "Reserved",
    ],
    causes: [
      "Outdated storage/SSD firmware or driver (a very common cause)",
      "Old or buggy device driver stalling at high IRQL",
      "A driver deadlock or spin",
    ],
    nextSteps: [
      "Update SSD/NVMe firmware and storage controller drivers first — these are the usual culprits.",
      "Update or roll back any third-party driver implicated below.",
      "For the stalled DPC's stack, open this dump in WinDbg.",
    ],
  },
  "0x124": {
    name: "WHEA_UNCORRECTABLE_ERROR",
    meaning:
      "A fatal hardware error was reported through the Windows Hardware Error Architecture (WHEA). This is almost always a hardware problem, not software.",
    params: [
      "Error source type (0 = machine-check exception)",
      "Address of the WHEA_ERROR_RECORD structure",
      "High 32 bits of the machine-check status (MCi_STATUS)",
      "Low 32 bits of the machine-check status (MCi_STATUS)",
    ],
    causes: [
      "Hardware fault: CPU, RAM, or motherboard",
      "Overheating, unstable voltage, or aggressive overclocking",
      "Failing or marginal power supply",
    ],
    nextSteps: [
      "Treat this as hardware: check temperatures, reseat/test RAM, and reset any overclock to stock.",
      "A third-party driver is rarely the root cause here — don't expect a software fix.",
      "If it persists, test components individually (CPU/RAM/PSU).",
    ],
  },
  "0x9F": {
    name: "DRIVER_POWER_STATE_FAILURE",
    meaning:
      "A driver failed to complete a power-state transition in time (e.g. entering or leaving sleep/hibernate).",
    params: [
      "Failure type (e.g. 3 = device object blocked an IRP for too long)",
      "Pointer to the offending device object or IRP (depends on type)",
      "Pointer to a related structure (depends on type)",
      "Reserved",
    ],
    causes: [
      "A driver mishandling a sleep/resume (power) transition",
      "Outdated network, storage, or chipset driver",
      "Buggy device firmware",
    ],
    nextSteps: [
      "Update the driver implicated below — power-transition bugs are usually driver-specific.",
      "Network and storage drivers are common offenders for this code; update those first.",
      "For the blocked power IRP, open this dump in WinDbg.",
    ],
  },
  "0x1A": {
    name: "MEMORY_MANAGEMENT",
    meaning:
      "The memory manager detected a serious error. The first parameter is a subtype that determines what the rest mean.",
    params: [
      "Subtype code (determines the meaning of the other parameters)",
      "Subtype-dependent",
      "Subtype-dependent",
      "Subtype-dependent",
    ],
    causes: [
      "Defective system memory (RAM) — a frequent cause",
      "Faulty driver corrupting memory or page tables",
      "Failing storage or a corrupted page file",
    ],
    nextSteps: [
      "Run a memory diagnostic first; this code is strongly associated with bad RAM.",
      "Update or roll back any third-party driver implicated below.",
      "For the subtype's meaning, open this dump in WinDbg (it decodes parameter 1).",
    ],
  },
  "0x19": {
    name: "BAD_POOL_HEADER",
    meaning:
      "A pool (kernel heap) header is corrupt — the allocator found a block whose bookkeeping doesn't add up. Usually a driver overwrote memory it shouldn't have.",
    params: [
      "Pool violation subtype",
      "Subtype-dependent (often the pool pointer)",
      "Subtype-dependent",
      "Subtype-dependent",
    ],
    causes: [
      "A driver corrupting kernel pool memory (buffer overrun / use-after-free)",
      "Defective system memory (RAM)",
      "Antivirus or filter drivers mismanaging pool",
    ],
    nextSteps: [
      "Update or roll back the implicated driver below — pool corruption is usually a driver bug.",
      "Run a memory diagnostic if no driver is implicated.",
      "For the corrupted pool block, open this dump in WinDbg.",
    ],
  },
  "0xC2": {
    name: "BAD_POOL_CALLER",
    meaning:
      "A kernel component (usually a driver) made an illegal pool (kernel heap) request — e.g. freeing memory twice or with the wrong tag.",
    params: [
      "Pool violation type",
      "Subtype-dependent (often the pool tag or address)",
      "Subtype-dependent",
      "Subtype-dependent",
    ],
    causes: [
      "A driver misusing pool allocation/free APIs",
      "Use-after-free or double-free in a third-party driver",
      "Defective system memory (RAM)",
    ],
    nextSteps: [
      "Update or roll back the implicated driver below.",
      "Run a memory diagnostic if no driver is implicated.",
      "For the offending pool call, open this dump in WinDbg.",
    ],
  },
  "0xEF": {
    name: "CRITICAL_PROCESS_DIED",
    meaning:
      "A process that Windows requires to keep running (a critical system process) unexpectedly terminated.",
    params: [
      "Address of the process object (EPROCESS) that died",
      "Reserved",
      "Reserved",
      "Reserved",
    ],
    causes: [
      "Corrupted system files or a botched update",
      "Malware or aggressive security software killing a system process",
      "Failing storage corrupting system binaries",
    ],
    nextSteps: [
      "Run System File Checker (sfc /scannow) and DISM to repair system files.",
      "Check the disk for errors; failing storage can corrupt critical binaries.",
      "Review recent updates or security software that may have terminated the process.",
    ],
  },
  "0x139": {
    name: "KERNEL_SECURITY_CHECK_FAILURE",
    meaning:
      "The kernel detected that a critical data structure was corrupted (a security/integrity check failed) and stopped to prevent further damage.",
    params: [
      "Type of corruption detected (e.g. 3 = LIST_ENTRY corruption)",
      "Address of the trap frame",
      "Address of the exception record",
      "Reserved",
    ],
    causes: [
      "A driver corrupting a kernel data structure",
      "Defective system memory (RAM)",
      "Incompatible or outdated low-level software (drivers, security tools)",
    ],
    nextSteps: [
      "Update or roll back the implicated driver below.",
      "Run a memory diagnostic if no driver is implicated.",
      "For the corrupted structure, open this dump in WinDbg.",
    ],
  },
});

/**
 * Canonical hex key for a numeric bugcheck code: 0xD1 → "0xD1", 0x133 → "0x133".
 * Returns null for non-finite input so callers can branch cleanly.
 */
export function normalizeCode(code) {
  if (!Number.isFinite(code)) return null;
  return "0x" + (code >>> 0).toString(16).toUpperCase();
}

/** Curated entry for a numeric bugcheck code, or null if not in the table. */
export function lookupBugcheck(code) {
  const key = normalizeCode(code);
  return key && key in BUGCHECKS ? BUGCHECKS[key] : null;
}
