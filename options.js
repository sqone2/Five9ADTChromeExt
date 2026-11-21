const form = document.getElementById("settings");
const controls = document.getElementById("controls");
const widthInput = document.getElementById("width");
const heightInput = document.getElementById("height");
const adtUrlInput = document.getElementById("adt-url");
const screenPopInput = document.getElementById("screen-pop-url");
const fallbackScreenPopInput = document.getElementById("fallback-screen-pop-url");
const reuseTabInput = document.getElementById("reuse-screen-pop-tab");
const status = document.getElementById("status");

for (const help of document.querySelectorAll(".help")) {
  help.addEventListener("mouseenter", () => delete help.dataset.dismissed);
  help.addEventListener("focusin", () => delete help.dataset.dismissed);
  help.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      help.dataset.dismissed = "true";
    }
  });
}

function showStatus(message, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
}

function displaySettings(settings) {
  widthInput.value = settings.width;
  heightInput.value = settings.height;
  adtUrlInput.value = settings.adtUrl;
  screenPopInput.value = settings.screenPopUrl;
  fallbackScreenPopInput.value = settings.fallbackScreenPopUrl;
  reuseTabInput.checked = settings.reuseScreenPopTab;
}

async function saveSettings(input, message) {
  controls.disabled = true;
  let settings;
  try {
    settings = Five9Settings.validateSettings(input);
  } catch (error) {
    showStatus(error.message, true);
    controls.disabled = false;
    return;
  }
  try {
    await chrome.storage.local.set({ settings });
    displaySettings(settings);
    showStatus(message);
  } catch {
    console.error("#### Five9 ADT options could not be saved.");
    showStatus("Could not save your settings. Try again.", true);
  } finally {
    controls.disabled = false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (form.reportValidity()) {
    saveSettings({
      width: widthInput.valueAsNumber,
      height: heightInput.valueAsNumber,
      adtUrl: adtUrlInput.value,
      screenPopUrl: screenPopInput.value,
      fallbackScreenPopUrl: fallbackScreenPopInput.value,
      reuseScreenPopTab: reuseTabInput.checked
    }, "Changes saved.");
  }
});

document.getElementById("reset").addEventListener("click", () => {
  saveSettings(Five9Settings.DEFAULTS, "Defaults restored.");
});
form.addEventListener("input", () => showStatus(""));

Five9Settings.getSettings().then((settings) => {
  displaySettings(settings);
  controls.disabled = false;
}).catch(() => {
  console.error("#### Five9 ADT options could not be loaded.");
  displaySettings(Five9Settings.DEFAULTS);
  controls.disabled = false;
  showStatus("Could not load saved settings. Defaults are shown; save or restore defaults to replace them.", true);
});
