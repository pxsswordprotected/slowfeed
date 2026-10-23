(() => {
  "use strict";

  const defaults = { enabled: true, timerSeconds: 60 };
  const revisions = { enabled: 0, timerSeconds: 0 };
  const enabledControl = document.getElementById("sf-enabled");
  const timerRow = document.getElementById("sf-timer-row");
  const timerControls = document.querySelectorAll('input[name="sf-timer"]');
  let settings = { ...defaults };
  let loaded = false;
  let loadSequence = 0;

  function normalizeSettings(values) {
    return {
      enabled: typeof values.enabled === "boolean" ? values.enabled : defaults.enabled,
      timerSeconds: [3, 30, 60].includes(values.timerSeconds)
        ? values.timerSeconds
        : defaults.timerSeconds
    };
  }

  function renderSettings(current) {
    enabledControl.checked = current.enabled;
    enabledControl.disabled = !loaded;
    timerRow.disabled = !loaded || !current.enabled;
    for (const control of timerControls) {
      control.checked = Number(control.value) === current.timerSeconds;
    }
  }

  async function loadSettings() {
    const sequence = ++loadSequence;
    const beforeRead = { ...revisions };
    loaded = false;
    renderSettings(settings);
    try {
      const stored = normalizeSettings(await chrome.storage.sync.get(defaults));
      if (sequence !== loadSequence) return;
      for (const key of Object.keys(defaults)) {
        if (revisions[key] === beforeRead[key]) settings[key] = stored[key];
      }
      loaded = true;
      renderSettings(settings);
    } catch (error) {
      console.error("Slow Feed settings read failed:", error);
    }
  }

  async function saveSetting(key, value) {
    try {
      await chrome.storage.sync.set({ [key]: value });
    } catch (error) {
      console.error("Slow Feed settings write failed:", error);
      await loadSettings();
    }
  }

  function onStorageChanged(changes, areaName) {
    if (areaName !== "sync") return;
    for (const key of Object.keys(defaults)) {
      if (!Object.hasOwn(changes, key)) continue;
      revisions[key] += 1;
      settings[key] = normalizeSettings({ [key]: changes[key].newValue })[key];
    }
    renderSettings(settings);
  }

  chrome.storage.onChanged.addListener(onStorageChanged);
  enabledControl.addEventListener("change", () => {
    void saveSetting("enabled", enabledControl.checked);
  });
  for (const control of timerControls) {
    control.addEventListener("change", () => {
      if (control.checked) void saveSetting("timerSeconds", Number(control.value));
    });
  }
  void loadSettings();
})();
