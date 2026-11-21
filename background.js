importScripts("settings.js");
importScripts("phone-numbers.js", "click-to-dial-background.js");

const WINDOW_KEY = "adtWindowId";
const SCREEN_POP_TAB_KEY = "screenPopTabId";
let launchQueue = Promise.resolve();
let screenPopQueue = Promise.resolve();

async function openAdt() {
  const stored = await chrome.storage.session.get(WINDOW_KEY);
  const windows = await chrome.windows.getAll({ windowTypes: ["popup"] });
  const existing = windows.find((window) => window.id === stored[WINDOW_KEY]);

  if (existing) {
    const update = { focused: true };
    if (existing.state === "minimized") {
      update.state = "normal";
    }
    await chrome.windows.update(existing.id, update);
  } else {
    const settings = await Five9Settings.getSettings();
    const created = await chrome.windows.create({
      url: settings.adtUrl || Five9Settings.DEFAULT_ADT_URL,
      type: "popup",
      width: settings.width,
      height: settings.height,
      focused: true
    });
    if (!Number.isInteger(created?.id)) {
      throw new Error("Chrome did not return an ADT window ID.");
    }
    await chrome.storage.session.set({ [WINDOW_KEY]: created.id });
  }

  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: "Open Five9 ADT" });
}

chrome.action.onClicked.addListener(() => {
  // Serialize clicks so two clicks cannot create two windows.
  launchQueue = launchQueue.then(openAdt).catch(async (error) => {
    console.error("#### Five9 ADT launcher failed:", error);
    try {
      await chrome.action.setBadgeBackgroundColor({ color: "#b3261e" });
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setTitle({
        title: "Could not open Five9 ADT. Click to retry; see extension errors for details."
      });
    } catch (notificationError) {
      console.error("#### Could not display the launcher error:", notificationError);
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "FIVE9_CALL_STARTED") {
    return false;
  }

  async function screenPop() {
    const url = sender.url ? new URL(sender.url) : null;
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
        !["https://app.five9.com", "https://app.five9.eu"].includes(url?.origin) ||
        url.pathname !== "/clients/integrations/adt.main.html") {
      throw new Error("Screen pop rejected: unexpected sender.");
    }
    const stored = await chrome.storage.session.get(WINDOW_KEY);
    if (!Number.isInteger(stored[WINDOW_KEY]) ||
        sender.tab?.windowId !== stored[WINDOW_KEY]) {
      return { ok: true, skipped: true };
    }
    const settings = await Five9Settings.getSettings();
    const screenPopUrl = Five9Settings.buildScreenPopUrl(settings, message.values);
    if (!screenPopUrl) {
      console.info("#### Five9 ADT screen pop skipped: disabled or a required variable is null.");
      return { ok: true, skipped: true };
    }
    const windows = await chrome.windows.getAll({ windowTypes: ["normal", "popup"] });
    let previous;
    if (settings.reuseScreenPopTab) {
      const storedTab = await chrome.storage.session.get(SCREEN_POP_TAB_KEY);
      if (Number.isInteger(storedTab[SCREEN_POP_TAB_KEY])) {
        const tabs = await chrome.tabs.query({});
        previous = tabs.find((tab) => tab.id === storedTab[SCREEN_POP_TAB_KEY]);
      }
    }
    const previousWindow = previous && windows.find((window) => window.id === previous.windowId);
    const browsers = windows.filter((window) => window.type === "normal");
    let browser = previousWindow || browsers.find((window) => window.focused) || browsers[0];
    console.info("#### Five9 ADT opening screen-pop URL:", Five9Settings.getDiagnosticUrl(screenPopUrl));
    let tab;
    if (previousWindow) {
      tab = await chrome.tabs.update(previous.id, { url: screenPopUrl, active: true });
    } else if (browser) {
      tab = await chrome.tabs.create({ windowId: browser.id, url: screenPopUrl, active: true });
    } else {
      browser = await chrome.windows.create({ url: screenPopUrl, type: "normal", focused: true });
      tab = browser?.tabs?.[0];
    }
    if (!Number.isInteger(tab?.id)) {
      throw new Error("Chrome did not return a screen-pop tab ID.");
    }
    await chrome.storage.session.set({ [SCREEN_POP_TAB_KEY]: tab.id });
    const update = { focused: true };
    if (browser.state === "minimized") {
      update.state = "normal";
    }
    await chrome.windows.update(browser.id, update);
    return { ok: true };
  }

  // Serialize pops so simultaneous requests cannot create competing reusable tabs.
  screenPopQueue = screenPopQueue.then(screenPop).then(sendResponse).catch(async () => {
    console.error("#### Five9 ADT screen pop failed.");
    try {
      await chrome.action.setBadgeBackgroundColor({ color: "#b3261e" });
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setTitle({
        title: "Five9 screen pop failed. See extension errors for details."
      });
    } catch {
      console.error("#### Could not display the screen pop error.");
    }
    sendResponse({ ok: false, error: "Five9 screen pop failed." });
  });
  return true;
});
