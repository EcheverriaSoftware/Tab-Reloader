import { MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES, clampInterval } from "../common/constants.js";
import {
  getDefaultInterval,
  getShowBadge,
  setDefaultInterval,
  setShowBadge,
} from "../common/storage.js";

const $ = (sel) => document.querySelector(sel);

function showMessage(text, kind) {
  const el = $("#intervalMsg");
  el.textContent = text;
  el.className = `msg msg--${kind}`;
  el.hidden = false;
}

async function saveInterval() {
  const raw = $("#defaultInterval").value;
  const { value, clamped, invalid } = clampInterval(raw, await getDefaultInterval());
  if (invalid) {
    showMessage("Please enter a number of minutes.", "warn");
    return;
  }
  await setDefaultInterval(value);
  $("#defaultInterval").value = value;
  if (clamped) {
    showMessage(
      `Saved. Adjusted to ${value} min (allowed range ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES}).`,
      "warn",
    );
  } else {
    showMessage("Saved.", "ok");
  }
}

$("#saveBtn").addEventListener("click", saveInterval);
$("#defaultInterval").addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveInterval();
});

$("#showBadge").addEventListener("change", async (e) => {
  await setShowBadge(e.target.checked);
});

$("#shortcutsBtn").addEventListener("click", () => {
  // Chromium-standard shortcuts page. Not openable via chrome.tabs from an
  // options page on all builds, so use a plain tab creation.
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

async function showShortcut() {
  try {
    const cmds = await chrome.commands.getAll();
    const cmd = cmds.find((c) => c.name === "toggle-current-tab");
    $("#shortcut").textContent = cmd?.shortcut || "(unset)";
  } catch {
    /* ignore */
  }
}

async function init() {
  $("#defaultInterval").value = await getDefaultInterval();
  $("#showBadge").checked = await getShowBadge();
  await showShortcut();
}

init();
