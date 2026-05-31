// Module → vendor/product lookup and the generic-OS-module set, for the
// probable-cause heuristic (PRD-DMP-Analysis §7.4). DATA, not logic: a small,
// hand-curated dictionary so a raw driver filename like `nvlddmkm.sys` reads as
// "NVIDIA display driver". Unknown modules are reported by filename as-is —
// this table is a convenience label, never a gate on what gets reported.
//
// Keys are lowercase filenames (basename only). Keep entries to common,
// recognizable third-party drivers across the categories that actually cause
// BSODs: display, storage, network, audio, and security/filter drivers.

/**
 * Generic Windows kernel/OS modules. These are usually the *messenger* on a
 * crash stack, not the root cause (§7.4) — a third-party driver corrupted
 * something earlier and a generic module is merely where it surfaced. The
 * heuristic de-prioritizes these as the suspect when a third-party module is
 * also present. Matched by lowercase basename.
 */
export const GENERIC_OS_MODULES = new Set([
  "ntoskrnl.exe",
  "ntkrnlmp.exe",
  "ntkrnlpa.exe",
  "ntkrpamp.exe",
  "hal.dll",
  "halmacpi.dll",
  "halacpi.dll",
  "ci.dll",
  "clfs.sys",
  "fltmgr.sys",
  "ksecdd.sys",
  "msrpc.sys",
  "ndis.sys", // network *stack*, not a specific NIC driver
  "tcpip.sys",
  "netio.sys",
  "win32k.sys",
  "win32kbase.sys",
  "win32kfull.sys",
  "dxgkrnl.sys", // DirectX graphics kernel — generic, not a specific GPU driver
  "watchdog.sys",
  "pci.sys",
  "acpi.sys",
  "wdf01000.sys", // kernel-mode driver framework
  "storport.sys", // storage *port* framework, not a specific controller driver
  "volmgr.sys",
  "volsnap.sys",
  "ntfs.sys",
  "fileinfo.sys",
  "cng.sys",
  "pdc.sys",
  "nt.exe",
]);

/**
 * Lowercase filename → human label. Grouped by category in comments only; the
 * map is flat. Patterns (e.g. all `nv*.sys` NVIDIA modules) are handled by the
 * prefix rules in `vendorForModule()` below so the table stays small.
 */
export const VENDORS = Object.freeze({
  // Display / GPU
  "nvlddmkm.sys": "NVIDIA display driver",
  "nvstor.sys": "NVIDIA storage driver",
  "atikmdag.sys": "AMD/ATI display driver",
  "atikmpag.sys": "AMD/ATI display driver",
  "amdkmdag.sys": "AMD display driver",
  "igdkmd64.sys": "Intel integrated graphics driver",
  "igdkmd32.sys": "Intel integrated graphics driver",
  "igdkmdn64.sys": "Intel graphics driver",

  // Storage / controllers
  "iastor.sys": "Intel Rapid Storage (RST) driver",
  "iastora.sys": "Intel Rapid Storage (RST) driver",
  "stornvme.sys": "NVMe storage driver",
  "nvme.sys": "NVMe storage driver",
  "amdsata.sys": "AMD SATA controller driver",
  "amd_sata.sys": "AMD SATA controller driver",

  // Network
  "rt640x64.sys": "Realtek Ethernet (NIC) driver",
  "rtwlane.sys": "Realtek Wi-Fi driver",
  "e1000.sys": "Intel Ethernet (e1000) driver",
  "e1g60x64.sys": "Intel Gigabit Ethernet driver",
  "netwtw06.sys": "Intel Wi-Fi driver",
  "netwtw08.sys": "Intel Wi-Fi driver",
  "netwtw10.sys": "Intel Wi-Fi driver",
  "athw8x.sys": "Qualcomm Atheros Wi-Fi driver",
  "bcmwl63a.sys": "Broadcom Wi-Fi driver",

  // Audio
  "rtkvhd64.sys": "Realtek HD Audio driver",
  "ksthunk.sys": "Kernel streaming (audio) thunk",
  "portcls.sys": "Windows audio port class driver",

  // Security / filter drivers (common BSOD offenders)
  "klif.sys": "Kaspersky filter driver",
  "klflt.sys": "Kaspersky filter driver",
  "avgntflt.sys": "Avira/AVG filter driver",
  "aswsp.sys": "Avast self-protection driver",
  "aswsnx.sys": "Avast driver",
  "mbam.sys": "Malwarebytes driver",
  "mbamswissarmy.sys": "Malwarebytes driver",
  "csagent.sys": "CrowdStrike Falcon sensor",
  "symefasi.sys": "Symantec/Norton driver",
  "srtsp64.sys": "Symantec/Norton auto-protect driver",
  "wdfilter.sys": "Microsoft Defender filter driver",

  // Virtualization / peripherals
  "vmci.sys": "VMware VMCI driver",
  "vsockdll.sys": "VMware vSocket driver",
  "vboxguest.sys": "VirtualBox guest driver",
  "rzudd.sys": "Razer device driver",
  "lvrs64.sys": "Logitech webcam driver",
});

// Vendor prefixes for whole driver families, so we don't enumerate every file.
// Matched against the lowercase basename. First match wins; keep specific
// VENDORS entries above for exact, more descriptive labels.
const VENDOR_PREFIXES = [
  ["nvlddmkm", "NVIDIA display driver"],
  ["nv", "NVIDIA driver"],
  ["atikm", "AMD/ATI display driver"],
  ["amdkm", "AMD display driver"],
  ["amd", "AMD driver"],
  ["igdkmd", "Intel graphics driver"],
  ["iastor", "Intel Rapid Storage driver"],
  ["rtk", "Realtek driver"],
  ["rt6", "Realtek Ethernet driver"],
  ["rtw", "Realtek Wi-Fi driver"],
  ["netwtw", "Intel Wi-Fi driver"],
  ["e1", "Intel Ethernet driver"],
  ["klif", "Kaspersky driver"],
  ["asw", "Avast driver"],
  ["mbam", "Malwarebytes driver"],
  ["vbox", "VirtualBox driver"],
  ["vmw", "VMware driver"],
];

/** Just the lowercase basename of a module path (handles `\` and `/`). */
export function moduleBasename(name) {
  if (typeof name !== "string") return "";
  const cut = Math.max(name.lastIndexOf("\\"), name.lastIndexOf("/"));
  return (cut >= 0 ? name.slice(cut + 1) : name).toLowerCase();
}

/** True if `name` is a generic Windows/OS module (messenger, not root cause). */
export function isGenericOsModule(name) {
  return GENERIC_OS_MODULES.has(moduleBasename(name));
}

/**
 * Human label for a module filename, or null if unknown (caller shows the raw
 * filename in that case). Exact table entries win over family prefixes.
 */
export function vendorForModule(name) {
  const base = moduleBasename(name);
  if (!base) return null;
  if (base in VENDORS) return VENDORS[base];
  for (const [prefix, label] of VENDOR_PREFIXES) {
    if (base.startsWith(prefix)) return label;
  }
  return null;
}
