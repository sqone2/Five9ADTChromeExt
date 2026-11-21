const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(new URL("../background.js", `file://${__filename}`), "utf8");
const settingsSource = readFileSync(new URL("../settings.js", `file://${__filename}`), "utf8");

function createBrowser(settings = {
  screenPopUrl: "https://squirion-dev-ed.lightning.force.com/{Subscriber.AccountNumber}",
  fallbackScreenPopUrl: ""
}) {
  const session = {};
  const local = { settings };
  const windows = new Map();
  const created = [];
  const updates = [];
  const errors = [];
  const tabs = [];
  const tabRecords = new Map();
  const tabUpdates = [];
  let nextTabId = 1000;
  let listener;
  let messageListener;
  let nextId = 1;
  let createError;
  let tabError;
  let badge = "";
  let title = "";

  const chrome = {
    runtime: {
      id: "test-extension",
      onMessage: {
        addListener(callback) {
          messageListener = callback;
        }
      },
      onConnect: { addListener() {} }
    },
    tabs: {
      async create(options) {
        if (tabError) {
          throw tabError;
        }
        tabs.push(options);
        const tab = { id: nextTabId++, ...options };
        tabRecords.set(tab.id, tab);
        return tab;
      },
      async query() {
        return [...tabRecords.values()].filter((tab) => windows.has(tab.windowId));
      },
      async update(id, options) {
        if (tabError) {
          throw tabError;
        }
        assert.ok(tabRecords.has(id));
        const tab = tabRecords.get(id);
        Object.assign(tab, options);
        tabUpdates.push({ id, ...options });
        return tab;
      }
    },
    storage: {
      local: {
        async get() {
          return local;
        }
      },
      session: {
        async get(key) {
          return { [key]: session[key] };
        },
        async set(values) {
          Object.assign(session, values);
        }
      }
    },
    windows: {
      async getAll({ windowTypes }) {
        return [...windows.values()].filter((window) => windowTypes.includes(window.type));
      },
      async create(options) {
        if (createError) {
          throw createError;
        }
        const window = { id: nextId++, state: "normal", ...options };
        const tab = { id: nextTabId++, windowId: window.id, url: options.url };
        window.tabs = [tab];
        tabRecords.set(tab.id, tab);
        windows.set(window.id, window);
        created.push(window);
        return window;
      },
      async update(id, options) {
        assert.ok(windows.has(id));
        updates.push({ id, ...options });
        Object.assign(windows.get(id), options);
      }
    },
    action: {
      onClicked: {
        addListener(callback) {
          listener = callback;
        }
      },
      async setBadgeText(options) {
        badge = options.text;
      },
      async setBadgeBackgroundColor() {},
      async setTitle(options) {
        title = options.title;
      }
    }
  };

  let context;
  function restartWorker() {
    context = vm.createContext({
      chrome,
      URL,
      console: { error: (...args) => errors.push(args), info() {} },
      importScripts(...files) {
        for (const file of files) {
          vm.runInContext(file === "settings.js" ? settingsSource :
            readFileSync(new URL(`../${file}`, `file://${__filename}`), "utf8"), context);
        }
      }
    });
    vm.runInContext(source, context);
  }
  restartWorker();

  return {
    windows,
    created,
    updates,
    errors,
    tabs,
    tabRecords,
    tabUpdates,
    restartWorker,
    setSettings(settings) {
      local.settings = settings;
    },
    click(tab = { id: 99 }) {
      listener(tab);
      return vm.runInContext("launchQueue", context);
    },
    setCreateError(error) {
      createError = error;
    },
    setTabError(error) {
      tabError = error;
    },
    message(sender = {}, message = {
      type: "FIVE9_CALL_STARTED", values: { "Subscriber.AccountNumber": "001DYNAMIC" }
    }) {
      return new Promise((resolve) => {
        const keepOpen = messageListener(message, {
          id: "test-extension",
          frameId: 0,
          url: "https://app.five9.com/clients/integrations/adt.main.html",
          tab: { windowId: created[0]?.id },
          ...sender
        }, resolve);
        if (!keepOpen) {
          resolve(undefined);
        }
      });
    },
    get badge() {
      return badge;
    },
    get title() {
      return title;
    }
  };
}

test("opens the US ADT URL without assigning an originating tab", async () => {
  const browser = createBrowser();
  await browser.click();
  const window = browser.created[0];
  assert.equal(window.url, "https://app.five9.com/clients/integrations/adt.main.html");
  assert.equal(window.type, "popup");
  assert.equal(window.focused, true);
  assert.equal("tabId" in window, false);
  assert.equal("openerTabId" in window, false);
});

test("serializes concurrent clicks and reuses the window across worker restarts", async () => {
  const browser = createBrowser();
  await Promise.all([browser.click(), browser.click(), browser.click()]);
  assert.equal(browser.created.length, 1);
  assert.equal(browser.updates.length, 2);
  browser.restartWorker();
  await browser.click({ id: 200 });
  assert.equal(browser.created.length, 1);
  assert.equal(browser.updates[2].id, browser.created[0].id);
});

test("restores a minimized window without resetting a maximized window", async () => {
  const browser = createBrowser();
  await browser.click();
  const window = browser.created[0];
  window.state = "minimized";
  await browser.click();
  assert.equal(window.state, "normal");
  window.state = "maximized";
  await browser.click();
  assert.equal(window.state, "maximized");
  assert.equal("state" in browser.updates[1], false);
});

test("creates a new window after the ADT window is closed", async () => {
  const browser = createBrowser();
  await browser.click();
  browser.windows.delete(browser.created[0].id);
  await browser.click();
  assert.equal(browser.created.length, 2);
  await browser.click();
  assert.equal(browser.created.length, 2);
  assert.equal(browser.updates[0].id, browser.created[1].id);
});

test("shows failures explicitly and allows a successful retry", async () => {
  const browser = createBrowser();
  browser.setCreateError(new Error("Window creation failed"));
  await browser.click();
  assert.equal(browser.badge, "!");
  assert.match(browser.title, /Click to retry/);
  assert.equal(browser.errors.length, 1);
  browser.setCreateError(undefined);
  await browser.click();
  assert.equal(browser.created.length, 1);
  assert.equal(browser.badge, "");
  assert.equal(browser.title, "Open Five9 ADT");
});

test("screen pops the requested account in a normal browser window, not the ADT popup", async () => {
  const browser = createBrowser();
  await browser.click();
  browser.windows.set(100, { id: 100, type: "normal", state: "minimized" });
  const result = await browser.message();
  assert.equal(result.ok, true);
  assert.equal(browser.tabs.length, 1);
  assert.equal(browser.tabs[0].windowId, 100);
  assert.equal(browser.tabs[0].active, true);
  assert.equal(browser.tabs[0].url, "https://squirion-dev-ed.lightning.force.com/001DYNAMIC");
  assert.equal(browser.windows.get(100).state, "normal");
  assert.equal(browser.windows.get(100).focused, true);
});

test("creates a normal browser window for screen pop if only ADT is open", async () => {
  const browser = createBrowser();
  await browser.click();
  assert.equal((await browser.message()).ok, true);
  assert.equal(browser.created[1].type, "normal");
  assert.equal(browser.created[1].url, "https://squirion-dev-ed.lightning.force.com/001DYNAMIC");
  assert.equal(browser.tabs.length, 0);
});

test("ignores other ADT windows and rejects unexpected screen-pop senders", async () => {
  const browser = createBrowser();
  await browser.click();
  assert.equal((await browser.message({ tab: { windowId: 999 } })).skipped, true);
  for (const sender of [
    { id: "other-extension" },
    { frameId: 1 },
    { url: "https://example.com/clients/integrations/adt.main.html" },
    { url: "https://app.five9.com/other.html" }
  ]) {
    assert.equal((await browser.message(sender)).ok, false);
  }
  assert.equal(await browser.message({}, { type: "OTHER" }), undefined);
  assert.equal(browser.created.length, 1);
  assert.equal(browser.tabs.length, 0);
});

test("screen-pop tab failures report an error rather than acknowledge success", async () => {
  const browser = createBrowser();
  await browser.click();
  browser.windows.set(100, { id: 100, type: "normal" });
  browser.setTabError(new Error("Cannot open tab"));
  assert.equal((await browser.message()).ok, false);
  assert.equal(browser.badge, "!");
  assert.match(browser.title, /screen pop failed/);
  assert.equal(browser.errors.length, 1);
});

test("encodes the account as one path segment on the fixed Salesforce origin", async () => {
  const browser = createBrowser();
  await browser.click();
  browser.windows.set(100, { id: 100, type: "normal" });
  const result = await browser.message({}, {
    type: "FIVE9_CALL_STARTED", values: { "Subscriber.AccountNumber": "  account/with?query#fragment  " }
  });
  assert.equal(result.ok, true);
  assert.equal(browser.tabs[0].url,
    "https://squirion-dev-ed.lightning.force.com/account%2Fwith%3Fquery%23fragment");
});

test("rejects malformed or traversal variable values and skips missing values by default", async () => {
  const browser = createBrowser();
  await browser.click();
  for (const value of [{}, ".", ".."]) {
    const result = await browser.message({}, {
      type: "FIVE9_CALL_STARTED", values: { "Subscriber.AccountNumber": value }
    });
    assert.equal(result.ok, false);
  }
  for (const value of [undefined, "", "  ", null]) {
    const result = await browser.message({}, {
      type: "FIVE9_CALL_STARTED", values: { "Subscriber.AccountNumber": value }
    });
    assert.equal(result.skipped, true);
  }
  assert.equal(browser.created.length, 1);
  assert.equal(browser.tabs.length, 0);
});

test("uses saved dimensions and Europe URL only when creating a new window", async () => {
  const browser = createBrowser({
    width: 650, height: 900,
    adtUrl: "https://app.five9.eu/clients/integrations/adt.main.html?f9verticalthreshold=500px"
  });
  await browser.click();
  assert.equal(browser.created[0].width, 650);
  assert.equal(browser.created[0].height, 900);
  assert.equal(browser.created[0].url,
    "https://app.five9.eu/clients/integrations/adt.main.html?f9verticalthreshold=500px");
  browser.setSettings({ width: 800, adtUrl: "" });
  await browser.click();
  assert.equal(browser.created.length, 1);
  assert.equal(browser.created[0].width, 650);
  browser.windows.delete(browser.created[0].id);
  await browser.click();
  assert.equal(browser.created[1].width, 800);
  assert.equal(browser.created[1].url, "https://app.five9.com/clients/integrations/adt.main.html");
});

test("reads template changes on each pop and accepts Europe senders", async () => {
  const browser = createBrowser();
  await browser.click();
  browser.windows.set(100, { id: 100, type: "normal" });
  browser.setSettings({
    screenPopUrl: "https://example.com/accounts/{Subscriber.AccountNumber}?type={Call.Type}",
    fallbackScreenPopUrl: "https://example.com/accounts/{Subscriber.AccountNumber}"
  });
  const result = await browser.message({
    url: "https://app.five9.eu/clients/integrations/adt.main.html?test=1"
  }, {
    type: "FIVE9_CALL_STARTED",
    values: { "Subscriber.AccountNumber": "001NEW", "Call.Type": null }
  });
  assert.equal(result.ok, true);
  assert.equal(browser.tabs[0].url, "https://example.com/accounts/001NEW");
  browser.setSettings({ screenPopUrl: "" });
  assert.equal((await browser.message()).skipped, true);
  assert.equal(browser.tabs.length, 1);
});

test("invalid saved settings show an error instead of opening a default window", async () => {
  const browser = createBrowser({ adtUrl: "https://example.com/adt" });
  await browser.click();
  assert.equal(browser.created.length, 0);
  assert.equal(browser.badge, "!");
});

test("opens a URL-valued CAV only after replacing its nested Salesforce placeholder", async () => {
  const browser = createBrowser({});
  await browser.click();
  browser.windows.set(100, { id: 100, type: "normal" });
  const result = await browser.message({}, {
    type: "FIVE9_CALL_STARTED",
    values: {
      "Screenpop.URL": "https://squirion-dev-ed.lightning.force.com/{Salesforce.salesforce_id}",
      "Salesforce.salesforce_id": "003TEST"
    }
  });
  assert.equal(result.ok, true);
  assert.equal(browser.tabs[0].url, "https://squirion-dev-ed.lightning.force.com/003TEST");
});

test("reuses and focuses the last screen-pop tab across worker restarts", async () => {
  const browser = createBrowser({ screenPopUrl: "https://example.com/{Call.Id}", reuseScreenPopTab: true });
  await browser.click();
  browser.windows.set(100, { id: 100, type: "normal", state: "normal" });
  const pop = (id) => browser.message({}, { type: "FIVE9_CALL_STARTED", values: { "Call.Id": id } });
  assert.equal((await pop("first")).ok, true);
  browser.windows.get(100).state = "minimized";
  browser.restartWorker();
  assert.equal((await pop("second")).ok, true);
  assert.equal(browser.tabs.length, 1);
  assert.equal(browser.tabUpdates.length, 1);
  assert.equal(browser.tabUpdates[0].url, "https://example.com/second");
  assert.equal(browser.tabUpdates[0].active, true);
  assert.equal(browser.windows.get(100).state, "normal");
  assert.equal(browser.windows.get(100).focused, true);
});

test("creates a replacement after closure and uses new tabs when reuse is disabled", async () => {
  const settings = { screenPopUrl: "https://example.com/pop", reuseScreenPopTab: true };
  const browser = createBrowser(settings);
  await browser.click();
  browser.windows.set(100, { id: 100, type: "normal" });
  await browser.message();
  const first = [...browser.tabRecords.values()].find((tab) => tab.windowId === 100);
  browser.tabRecords.delete(first.id);
  await browser.message();
  assert.equal(browser.tabs.length, 2);
  assert.equal(browser.tabUpdates.length, 0);
  browser.setSettings({ ...settings, reuseScreenPopTab: false });
  await browser.message();
  assert.equal(browser.tabs.length, 3);
});

test("serializes concurrent reusable pops and tracks a tab created in a new browser window", async () => {
  const browser = createBrowser({ screenPopUrl: "https://example.com/pop", reuseScreenPopTab: true });
  await browser.click();
  const replies = await Promise.all([browser.message(), browser.message(), browser.message()]);
  assert.ok(replies.every((reply) => reply.ok));
  assert.equal(browser.created.length, 2);
  assert.equal(browser.created[1].type, "normal");
  assert.equal(browser.tabUpdates.length, 2);
  assert.equal(browser.tabUpdates[0].id, browser.created[1].tabs[0].id);
});

test("reuse navigation errors report failure and do not create duplicate tabs", async () => {
  const browser = createBrowser({ screenPopUrl: "https://example.com/pop", reuseScreenPopTab: true });
  await browser.click();
  browser.windows.set(100, { id: 100, type: "normal" });
  await browser.message();
  browser.setTabError(new Error("Navigation failed"));
  assert.equal((await browser.message()).ok, false);
  assert.equal(browser.tabs.length, 1);
  assert.equal(browser.badge, "!");
  browser.setTabError(undefined);
  assert.equal((await browser.message()).ok, true);
  assert.equal(browser.tabs.length, 1);
});
