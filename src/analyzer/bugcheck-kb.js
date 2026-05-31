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
export const KB_VERSION = "2026-05.1";

// Per-parameter labels reused across the IRQL-family stop codes (0xA / 0xD1).
const IRQL_PARAMS = [
  "Memory address that was referenced",
  "IRQL at the time of the reference",
  "Access type (0 = read, 1 = write, 8 = execute)",
  "Address of the instruction that referenced memory",
];

// 0x7E parameter labels: P3/P4 are pointers to the exception and context records.
const EXCEPTION_PARAMS = [
  "Exception code that was not handled",
  "Address where the exception occurred",
  "Exception record (0 = not supplied)",
  "Context record (0 = not supplied)",
];

// 0x1E parameter labels (Addendum §18.2). Distinct from 0x7E: here P3/P4 are the
// first two parameters OF the unhandled exception, not record pointers.
const KMODE_1E_PARAMS = [
  "Exception code that was not handled",
  "Address where the exception occurred",
  "Parameter 0 of the exception",
  "Parameter 1 of the exception",
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
    params: KMODE_1E_PARAMS,
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

// Full Microsoft Bug Check Code Reference name table (Addendum §18.4): every
// recognized code resolves to at least its symbolic name even when there is no
// curated guidance. Keyed by canonical base hex ("0x" + base.toUpperCase()).
// Source: learn.microsoft.com — Bug Check Code Reference. Curated codes above
// also appear here so this stays the single canonical name list.
export const BUGCHECK_NAMES = Object.freeze({
  "0x1": "APC_INDEX_MISMATCH",
  "0x2": "DEVICE_QUEUE_NOT_BUSY",
  "0x3": "INVALID_AFFINITY_SET",
  "0x4": "INVALID_DATA_ACCESS_TRAP",
  "0x5": "INVALID_PROCESS_ATTACH_ATTEMPT",
  "0x6": "INVALID_PROCESS_DETACH_ATTEMPT",
  "0x7": "INVALID_SOFTWARE_INTERRUPT",
  "0x8": "IRQL_NOT_DISPATCH_LEVEL",
  "0x9": "IRQL_NOT_GREATER_OR_EQUAL",
  "0xA": "IRQL_NOT_LESS_OR_EQUAL",
  "0xB": "NO_EXCEPTION_HANDLING_SUPPORT",
  "0xC": "MAXIMUM_WAIT_OBJECTS_EXCEEDED",
  "0xD": "MUTEX_LEVEL_NUMBER_VIOLATION",
  "0xE": "NO_USER_MODE_CONTEXT",
  "0xF": "SPIN_LOCK_ALREADY_OWNED",
  "0x10": "SPIN_LOCK_NOT_OWNED",
  "0x11": "THREAD_NOT_MUTEX_OWNER",
  "0x12": "TRAP_CAUSE_UNKNOWN",
  "0x13": "EMPTY_THREAD_REAPER_LIST",
  "0x14": "CREATE_DELETE_LOCK_NOT_LOCKED",
  "0x15": "LAST_CHANCE_CALLED_FROM_KMODE",
  "0x16": "CID_HANDLE_CREATION",
  "0x17": "CID_HANDLE_DELETION",
  "0x18": "REFERENCE_BY_POINTER",
  "0x19": "BAD_POOL_HEADER",
  "0x1A": "MEMORY_MANAGEMENT",
  "0x1B": "PFN_SHARE_COUNT",
  "0x1C": "PFN_REFERENCE_COUNT",
  "0x1D": "NO_SPIN_LOCK_AVAILABLE",
  "0x1E": "KMODE_EXCEPTION_NOT_HANDLED",
  "0x1F": "SHARED_RESOURCE_CONV_ERROR",
  "0x20": "KERNEL_APC_PENDING_DURING_EXIT",
  "0x21": "QUOTA_UNDERFLOW",
  "0x22": "FILE_SYSTEM",
  "0x23": "FAT_FILE_SYSTEM",
  "0x24": "NTFS_FILE_SYSTEM",
  "0x25": "NPFS_FILE_SYSTEM",
  "0x26": "CDFS_FILE_SYSTEM",
  "0x27": "RDR_FILE_SYSTEM",
  "0x28": "CORRUPT_ACCESS_TOKEN",
  "0x29": "SECURITY_SYSTEM",
  "0x2A": "INCONSISTENT_IRP",
  "0x2B": "PANIC_STACK_SWITCH",
  "0x2C": "PORT_DRIVER_INTERNAL",
  "0x2D": "SCSI_DISK_DRIVER_INTERNAL",
  "0x2E": "DATA_BUS_ERROR",
  "0x2F": "INSTRUCTION_BUS_ERROR",
  "0x30": "SET_OF_INVALID_CONTEXT",
  "0x31": "PHASE0_INITIALIZATION_FAILED",
  "0x32": "PHASE1_INITIALIZATION_FAILED",
  "0x33": "UNEXPECTED_INITIALIZATION_CALL",
  "0x34": "CACHE_MANAGER",
  "0x35": "NO_MORE_IRP_STACK_LOCATIONS",
  "0x36": "DEVICE_REFERENCE_COUNT_NOT_ZERO",
  "0x37": "FLOPPY_INTERNAL_ERROR",
  "0x38": "SERIAL_DRIVER_INTERNAL",
  "0x39": "SYSTEM_EXIT_OWNED_MUTEX",
  "0x3A": "SYSTEM_UNWIND_PREVIOUS_USER",
  "0x3B": "SYSTEM_SERVICE_EXCEPTION",
  "0x3C": "INTERRUPT_UNWIND_ATTEMPTED",
  "0x3D": "INTERRUPT_EXCEPTION_NOT_HANDLED",
  "0x3E": "MULTIPROCESSOR_CONFIGURATION_NOT_SUPPORTED",
  "0x3F": "NO_MORE_SYSTEM_PTES",
  "0x40": "TARGET_MDL_TOO_SMALL",
  "0x41": "MUST_SUCCEED_POOL_EMPTY",
  "0x42": "ATDISK_DRIVER_INTERNAL",
  "0x43": "NO_SUCH_PARTITION",
  "0x44": "MULTIPLE_IRP_COMPLETE_REQUESTS",
  "0x45": "INSUFFICIENT_SYSTEM_MAP_REGS",
  "0x46": "DEREF_UNKNOWN_LOGON_SESSION",
  "0x47": "REF_UNKNOWN_LOGON_SESSION",
  "0x48": "CANCEL_STATE_IN_COMPLETED_IRP",
  "0x49": "PAGE_FAULT_WITH_INTERRUPTS_OFF",
  "0x4A": "IRQL_GT_ZERO_AT_SYSTEM_SERVICE",
  "0x4B": "STREAMS_INTERNAL_ERROR",
  "0x4C": "FATAL_UNHANDLED_HARD_ERROR",
  "0x4D": "NO_PAGES_AVAILABLE",
  "0x4E": "PFN_LIST_CORRUPT",
  "0x4F": "NDIS_INTERNAL_ERROR",
  "0x50": "PAGE_FAULT_IN_NONPAGED_AREA",
  "0x51": "REGISTRY_ERROR",
  "0x52": "MAILSLOT_FILE_SYSTEM",
  "0x53": "NO_BOOT_DEVICE",
  "0x54": "LM_SERVER_INTERNAL_ERROR",
  "0x55": "DATA_COHERENCY_EXCEPTION",
  "0x56": "INSTRUCTION_COHERENCY_EXCEPTION",
  "0x57": "XNS_INTERNAL_ERROR",
  "0x58": "FTDISK_INTERNAL_ERROR",
  "0x59": "PINBALL_FILE_SYSTEM",
  "0x5A": "CRITICAL_SERVICE_FAILED",
  "0x5B": "SET_ENV_VAR_FAILED",
  "0x5C": "HAL_INITIALIZATION_FAILED",
  "0x5D": "HEAP_INITIALIZATION_FAILED",
  "0x5E": "OBJECT_INITIALIZATION_FAILED",
  "0x5F": "SECURITY_INITIALIZATION_FAILED",
  "0x60": "PROCESS_INITIALIZATION_FAILED",
  "0x61": "HAL1_INITIALIZATION_FAILED",
  "0x62": "OBJECT1_INITIALIZATION_FAILED",
  "0x63": "SECURITY1_INITIALIZATION_FAILED",
  "0x64": "SYMBOLIC_INITIALIZATION_FAILED",
  "0x65": "MEMORY1_INITIALIZATION_FAILED",
  "0x66": "CACHE_INITIALIZATION_FAILED",
  "0x67": "CONFIG_INITIALIZATION_FAILED",
  "0x68": "FILE_INITIALIZATION_FAILED",
  "0x69": "IO1_INITIALIZATION_FAILED",
  "0x6A": "LPC_INITIALIZATION_FAILED",
  "0x6B": "PROCESS1_INITIALIZATION_FAILED",
  "0x6C": "REFMON_INITIALIZATION_FAILED",
  "0x6D": "SESSION1_INITIALIZATION_FAILED",
  "0x6E": "SESSION2_INITIALIZATION_FAILED",
  "0x6F": "SESSION3_INITIALIZATION_FAILED",
  "0x70": "SESSION4_INITIALIZATION_FAILED",
  "0x71": "SESSION5_INITIALIZATION_FAILED",
  "0x72": "ASSIGN_DRIVE_LETTERS_FAILED",
  "0x73": "CONFIG_LIST_FAILED",
  "0x74": "BAD_SYSTEM_CONFIG_INFO",
  "0x75": "CANNOT_WRITE_CONFIGURATION",
  "0x76": "PROCESS_HAS_LOCKED_PAGES",
  "0x77": "KERNEL_STACK_INPAGE_ERROR",
  "0x78": "PHASE0_EXCEPTION",
  "0x79": "MISMATCHED_HAL",
  "0x7A": "KERNEL_DATA_INPAGE_ERROR",
  "0x7B": "INACCESSIBLE_BOOT_DEVICE",
  "0x7C": "BUGCODE_NDIS_DRIVER",
  "0x7D": "INSTALL_MORE_MEMORY",
  "0x7E": "SYSTEM_THREAD_EXCEPTION_NOT_HANDLED",
  "0x7F": "UNEXPECTED_KERNEL_MODE_TRAP",
  "0x80": "NMI_HARDWARE_FAILURE",
  "0x81": "SPIN_LOCK_INIT_FAILURE",
  "0x82": "DFS_FILE_SYSTEM",
  "0x85": "SETUP_FAILURE",
  "0x8B": "MBR_CHECKSUM_MISMATCH",
  "0x8E": "KERNEL_MODE_EXCEPTION_NOT_HANDLED",
  "0x8F": "PP0_INITIALIZATION_FAILED",
  "0x90": "PP1_INITIALIZATION_FAILED",
  "0x92": "UP_DRIVER_ON_MP_SYSTEM",
  "0x93": "INVALID_KERNEL_HANDLE",
  "0x94": "KERNEL_STACK_LOCKED_AT_EXIT",
  "0x96": "INVALID_WORK_QUEUE_ITEM",
  "0x97": "BOUND_IMAGE_UNSUPPORTED",
  "0x98": "END_OF_NT_EVALUATION_PERIOD",
  "0x99": "INVALID_REGION_OR_SEGMENT",
  "0x9A": "SYSTEM_LICENSE_VIOLATION",
  "0x9B": "UDFS_FILE_SYSTEM",
  "0x9C": "MACHINE_CHECK_EXCEPTION",
  "0x9E": "USER_MODE_HEALTH_MONITOR",
  "0x9F": "DRIVER_POWER_STATE_FAILURE",
  "0xA0": "INTERNAL_POWER_ERROR",
  "0xA1": "PCI_BUS_DRIVER_INTERNAL",
  "0xA2": "MEMORY_IMAGE_CORRUPT",
  "0xA3": "ACPI_DRIVER_INTERNAL",
  "0xA4": "CNSS_FILE_SYSTEM_FILTER",
  "0xA5": "ACPI_BIOS_ERROR",
  "0xA7": "BAD_EXHANDLE",
  "0xAB": "SESSION_HAS_VALID_POOL_ON_EXIT",
  "0xAC": "HAL_MEMORY_ALLOCATION",
  "0xB1": "BGI_DETECTED_VIOLATION",
  "0xB4": "VIDEO_DRIVER_INIT_FAILURE",
  "0xB8": "ATTEMPTED_SWITCH_FROM_DPC",
  "0xB9": "CHIPSET_DETECTED_ERROR",
  "0xBA": "SESSION_HAS_VALID_VIEWS_ON_EXIT",
  "0xBB": "NETWORK_BOOT_INITIALIZATION_FAILED",
  "0xBC": "NETWORK_BOOT_DUPLICATE_ADDRESS",
  "0xBD": "INVALID_HIBERNATED_STATE",
  "0xBE": "ATTEMPTED_WRITE_TO_READONLY_MEMORY",
  "0xBF": "MUTEX_ALREADY_OWNED",
  "0xC1": "SPECIAL_POOL_DETECTED_MEMORY_CORRUPTION",
  "0xC2": "BAD_POOL_CALLER",
  "0xC4": "DRIVER_VERIFIER_DETECTED_VIOLATION",
  "0xC5": "DRIVER_CORRUPTED_EXPOOL",
  "0xC6": "DRIVER_CAUGHT_MODIFYING_FREED_POOL",
  "0xC7": "TIMER_OR_DPC_INVALID",
  "0xC8": "IRQL_UNEXPECTED_VALUE",
  "0xC9": "DRIVER_VERIFIER_IOMANAGER_VIOLATION",
  "0xCA": "PNP_DETECTED_FATAL_ERROR",
  "0xCB": "DRIVER_LEFT_LOCKED_PAGES_IN_PROCESS",
  "0xCC": "PAGE_FAULT_IN_FREED_SPECIAL_POOL",
  "0xCD": "PAGE_FAULT_BEYOND_END_OF_ALLOCATION",
  "0xCE": "DRIVER_UNLOADED_WITHOUT_CANCELLING_PENDING_OPERATIONS",
  "0xCF": "TERMINAL_SERVER_DRIVER_MADE_INCORRECT_MEMORY_REFERENCE",
  "0xD0": "DRIVER_CORRUPTED_MMPOOL",
  "0xD1": "DRIVER_IRQL_NOT_LESS_OR_EQUAL",
  "0xD2": "BUGCODE_ID_DRIVER",
  "0xD3": "DRIVER_PORTION_MUST_BE_NONPAGED",
  "0xD4": "SYSTEM_SCAN_AT_RAISED_IRQL_CAUGHT_IMPROPER_DRIVER_UNLOAD",
  "0xD5": "DRIVER_PAGE_FAULT_IN_FREED_SPECIAL_POOL",
  "0xD6": "DRIVER_PAGE_FAULT_BEYOND_END_OF_ALLOCATION",
  "0xD7": "DRIVER_UNMAPPING_INVALID_VIEW",
  "0xD8": "DRIVER_USED_EXCESSIVE_PTES",
  "0xD9": "LOCKED_PAGES_TRACKER_CORRUPTION",
  "0xDA": "SYSTEM_PTE_MISUSE",
  "0xDB": "DRIVER_CORRUPTED_SYSPTES",
  "0xDC": "DRIVER_INVALID_STACK_ACCESS",
  "0xDE": "POOL_CORRUPTION_IN_FILE_AREA",
  "0xDF": "IMPERSONATING_WORKER_THREAD",
  "0xE0": "ACPI_BIOS_FATAL_ERROR",
  "0xE1": "WORKER_THREAD_RETURNED_AT_BAD_IRQL",
  "0xE2": "MANUALLY_INITIATED_CRASH",
  "0xE3": "RESOURCE_NOT_OWNED",
  "0xE4": "WORKER_INVALID",
  "0xE6": "DRIVER_VERIFIER_DMA_VIOLATION",
  "0xE7": "INVALID_FLOATING_POINT_STATE",
  "0xE8": "INVALID_CANCEL_OF_FILE_OPEN",
  "0xE9": "ACTIVE_EX_WORKER_THREAD_TERMINATION",
  "0xEA": "THREAD_STUCK_IN_DEVICE_DRIVER",
  "0xEB": "DIRTY_MAPPED_PAGES_CONGESTION",
  "0xEC": "SESSION_HAS_VALID_SPECIAL_POOL_ON_EXIT",
  "0xED": "UNMOUNTABLE_BOOT_VOLUME",
  "0xEF": "CRITICAL_PROCESS_DIED",
  "0xF0": "STORAGE_MINIPORT_ERROR",
  "0xF1": "SCSI_VERIFIER_DETECTED_VIOLATION",
  "0xF2": "HARDWARE_INTERRUPT_STORM",
  "0xF3": "DISORDERLY_SHUTDOWN",
  "0xF4": "CRITICAL_OBJECT_TERMINATION",
  "0xF5": "FLTMGR_FILE_SYSTEM",
  "0xF6": "PCI_VERIFIER_DETECTED_VIOLATION",
  "0xF7": "DRIVER_OVERRAN_STACK_BUFFER",
  "0xF8": "RAMDISK_BOOT_INITIALIZATION_FAILED",
  "0xF9": "DRIVER_RETURNED_STATUS_REPARSE_FOR_VOLUME_OPEN",
  "0xFA": "HTTP_DRIVER_CORRUPTED",
  "0xFC": "ATTEMPTED_EXECUTE_OF_NOEXECUTE_MEMORY",
  "0xFD": "DIRTY_NOWRITE_PAGES_CONGESTION",
  "0xFE": "BUGCODE_USB_DRIVER",
  "0xFF": "RESERVE_QUEUE_OVERFLOW",
  "0x100": "LOADER_BLOCK_MISMATCH",
  "0x101": "CLOCK_WATCHDOG_TIMEOUT",
  "0x103": "MUP_FILE_SYSTEM",
  "0x104": "AGP_INVALID_ACCESS",
  "0x105": "AGP_GART_CORRUPTION",
  "0x106": "AGP_ILLEGALLY_REPROGRAMMED",
  "0x108": "THIRD_PARTY_FILE_SYSTEM_FAILURE",
  "0x109": "CRITICAL_STRUCTURE_CORRUPTION",
  "0x10A": "APP_TAGGING_INITIALIZATION_FAILED",
  "0x10C": "FSRTL_EXTRA_CREATE_PARAMETER_VIOLATION",
  "0x10D": "WDF_VIOLATION",
  "0x10E": "VIDEO_MEMORY_MANAGEMENT_INTERNAL",
  "0x10F": "RESOURCE_MANAGER_EXCEPTION_NOT_HANDLED",
  "0x111": "RECURSIVE_NMI",
  "0x112": "MSRPC_STATE_VIOLATION",
  "0x113": "VIDEO_DXGKRNL_FATAL_ERROR",
  "0x114": "VIDEO_SHADOW_DRIVER_FATAL_ERROR",
  "0x115": "AGP_INTERNAL",
  "0x116": "VIDEO_TDR_FAILURE",
  "0x117": "VIDEO_TDR_TIMEOUT_DETECTED",
  "0x119": "VIDEO_SCHEDULER_INTERNAL_ERROR",
  "0x11B": "DRIVER_RETURNED_HOLDING_CANCEL_LOCK",
  "0x11C": "ATTEMPTED_WRITE_TO_CM_PROTECTED_STORAGE",
  "0x11D": "EVENT_TRACING_FATAL_ERROR",
  "0x11E": "TOO_MANY_RECURSIVE_FAULTS",
  "0x121": "DRIVER_VIOLATION",
  "0x122": "WHEA_INTERNAL_ERROR",
  "0x124": "WHEA_UNCORRECTABLE_ERROR",
  "0x127": "PAGE_NOT_ZERO",
  "0x12B": "FAULTY_HARDWARE_CORRUPTED_PAGE",
  "0x12C": "EXFAT_FILE_SYSTEM",
  "0x133": "DPC_WATCHDOG_VIOLATION",
  "0x139": "KERNEL_SECURITY_CHECK_FAILURE",
  "0x13A": "KERNEL_MODE_HEAP_CORRUPTION",
  "0x144": "BUGCODE_USB3_DRIVER",
  "0x154": "UNEXPECTED_STORE_EXCEPTION",
  "0x161": "LIVE_SYSTEM_DUMP",
  "0x162": "KERNEL_AUTO_BOOST_INVALID_LOCK_RELEASE",
  "0x163": "KERNEL_AUTO_BOOST_LOCK_ACQUISITION_WITH_RAISED_IRQL",
});

// Base codes that are inherently non-fatal "captured condition" dumps, not a
// machine-down bugcheck (Addendum §18.3): GPU TDR recovery and live system dump.
const LIVE_BASE_CODES = new Set([0x117, 0x161]);

/**
 * Split a raw 32-bit bugcheck code into its canonical base and any high-order
 * variant bits (Addendum §18.4). Real codes are small (≤ ~0x1FF) and live in the
 * low 16 bits; high bits (e.g. 0x10000000 in a live-dump variant like 0x1000007E)
 * are a modifier we record rather than blindly strip.
 */
export function decodeCode(code) {
  if (!Number.isFinite(code)) return { raw: null, base: null, baseHex: null, variantBits: 0 };
  const raw = code >>> 0;
  const base = raw & 0xffff;
  return {
    raw,
    base,
    baseHex: "0x" + base.toString(16).toUpperCase(),
    variantBits: raw & 0xffff0000, // non-zero ⇒ variant / live-dump signal
  };
}

/**
 * Canonical base hex key for a bugcheck code, folding away variant high bits:
 * 0xD1 → "0xD1", 0x1000007E → "0x7E". Returns null for non-finite input.
 */
export function normalizeCode(code) {
  return decodeCode(code).baseHex;
}

/**
 * Is this dump a non-fatal *live* kernel dump rather than a fatal crash
 * (Addendum §18.3)? True when the code carries variant high bits, is a known
 * live base code (0x117 / 0x161), or its name ends in _LIVEDUMP.
 */
export function isLiveDump(code) {
  const { base, baseHex, variantBits } = decodeCode(code);
  if (base == null) return false;
  if (variantBits !== 0) return true;
  if (LIVE_BASE_CODES.has(base)) return true;
  const name = BUGCHECK_NAMES[baseHex];
  return !!name && /_LIVEDUMP$/.test(name);
}

// Most-likely source CATEGORY per curated code (§7.3 #3): used to phrase the
// "Most likely source" line when no specific driver is implicated. One of
// "driver" | "memory" | "hardware" | "system".
const CATEGORY = Object.freeze({
  "0xA": "driver",
  "0xD1": "driver",
  "0x50": "memory",
  "0x1E": "driver",
  "0x3B": "driver",
  "0x7E": "driver",
  "0x133": "driver",
  "0x124": "hardware",
  "0x9F": "driver",
  "0x1A": "memory",
  "0x19": "driver",
  "0xC2": "driver",
  "0xEF": "system",
  "0x139": "driver",
});

/**
 * Knowledge for a bugcheck code. Folds variant bits to the base code, then:
 *   - returns the curated entry (name + meaning + params + causes + nextSteps)
 *     when one exists;
 *   - else a name-only entry (`nameOnly: true`) from the full reference table;
 *   - else null (truly unrecognized).
 */
export function lookupBugcheck(code) {
  const { baseHex } = decodeCode(code);
  if (!baseHex) return null;
  const curated = BUGCHECKS[baseHex];
  const name = curated?.name || BUGCHECK_NAMES[baseHex] || null;
  if (!name) return null;
  return {
    name,
    meaning: curated?.meaning ?? null,
    params: curated?.params ?? null,
    causes: curated?.causes ?? null,
    nextSteps: curated?.nextSteps ?? null,
    category: CATEGORY[baseHex] ?? null,
    nameOnly: !curated,
  };
}
