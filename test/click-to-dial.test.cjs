const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const source = (file) => readFileSync(new URL(`../${file}`, `file://${__filename}`), "utf8");

function event() {
  const listeners = [];
  return {
    addListener(callback) { listeners.push(callback); },
    async emit(...args) { await Promise.all(listeners.map((callback) => callback(...args))); }
  };
}

function port(name, sender) {
  return {
    name, sender, messages: [], closed: false,
    onMessage: event(), onDisconnect: event(),
    postMessage(message) {
      assert.equal(this.closed, false, "must not send to a closed port");
      this.messages.push(message);
    },
    disconnect() {
      this.closed = true;
      return this.onDisconnect.emit();
    }
  };
}

function worker() {
  const onConnect = event();
  const updates = [];
  const errors = [];
  let getWindows = async () => [{ id: 10, state: "minimized" }];
  const chrome = {
    runtime: { id: "extension", onConnect },
    storage: { session: { async get() { return { adtWindowId: 10 }; } } },
    windows: {
      async getAll() { return getWindows(); },
      async update(id, options) { updates.push({ id, ...options }); }
    }
  };
  const context = vm.createContext({
    chrome, URL, setTimeout, clearTimeout,
    console: { error: (...args) => errors.push(args) }
  });
  vm.runInContext(source("phone-numbers.js"), context);
  vm.runInContext(source("click-to-dial-background.js"), context);
  return {
    updates, errors,
    setGetWindows(callback) { getWindows = callback; },
    async connect(name, overrides = {}) {
      const sender = {
        id: "extension", frameId: 0,
        url: name === "FIVE9_ADT_DIAL"
          ? "https://app.five9.com/clients/integrations/adt.main.html"
          : "https://example.com/",
        tab: { id: 20, windowId: 10 }, ...overrides
      };
      const connection = port(name, sender);
      await onConnect.emit(connection);
      return connection;
    }
  };
}

function bridge() {
  const connection = port("FIVE9_ADT_DIAL");
  const calls = [];
  const errors = [];
  let callbacks;
  let master = async () => true;
  let dial = (params) => calls.push(params);
  const timers = new Map();
  let nextTimerId = 0;
  const context = vm.createContext({
    chrome: { runtime: { connect: () => connection } },
    window: {
      Five9: { CrmSdk: {
        applicationApi: () => ({ subscribe(value) { callbacks = value; } }),
        interactionApi: () => ({
          isMasterPage: () => master(),
          click2dial: (params) => dial(params)
        })
      } },
      addEventListener() {}
    },
    setTimeout(callback) {
      timers.set(++nextTimerId, callback);
      return nextTimerId;
    },
    clearTimeout(id) { timers.delete(id); },
    console: { info() {}, error: (...args) => errors.push(args) }
  });
  vm.runInContext(source("phone-numbers.js"), context);
  vm.runInContext(source("adt-dial.js"), context);
  return {
    connection, calls, errors,
    state(state) { return callbacks.loginStateChanged({ state }); },
    connectionError() { callbacks.error({ source: "websocket" }); },
    setMaster(value) { master = value; },
    setDial(value) { dial = value; },
    runTimer() {
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      return callback();
    }
  };
}

test("detects phone numbers without partial matches inside IDs or longer digit sequences", () => {
  const context = vm.createContext({});
  vm.runInContext(source("phone-numbers.js"), context);
  const { find, normalize } = context.Five9PhoneNumbers;
  assert.deepEqual(Array.from(find("Call (925) 555-0100 or +44 20 7946 0958."),
    (match) => match.number), ["9255550100", "+442079460958"]);
  assert.equal(find("ID1234567890 1234567890123456 2026-11-20").length, 0);
  assert.equal(normalize("tel:%2B1%20(925)%20555-0100"), "+19255550100");
  for (const value of ["tel:9255550100;ext=12", "tel:5550100?x=1", "javascript:1234567890",
    "12", "+1234567890123456", "tel:%XX", "1+9255550100"]) {
    assert.throws(() => normalize(value));
  }
});

test("SDK bridge gates dialing on WORKING and rechecks login after the master check", async () => {
  const sdk = bridge();
  assert.equal(sdk.connection.messages[0].enabled, false);
  await sdk.connection.onMessage.emit({ type: "DIAL", id: 1, number: "9255550100" });
  assert.equal(sdk.calls.length, 0);
  await sdk.state("WORKING");
  await sdk.connection.onMessage.emit({ type: "DIAL", id: 2, number: "9255550100" });
  assert.equal(sdk.calls[0].click2DialData.clickToDialNumber, "9255550100");
  sdk.setMaster(async () => {
    sdk.state("LOGIN");
    return true;
  });
  await sdk.connection.onMessage.emit({ type: "DIAL", id: 3, number: "9255550100" });
  assert.equal(sdk.calls.length, 1);
  assert.equal(sdk.connection.messages.at(-1).ok, false);
});

test("SDK master, connection and dispatch errors block dialing and report failures", async () => {
  const sdk = bridge();
  await sdk.state("WORKING");
  sdk.setMaster(async () => false);
  await sdk.connection.onMessage.emit({ type: "DIAL", id: 1, number: "9255550100" });
  assert.equal(sdk.calls.length, 0);
  sdk.setMaster(async () => true);
  sdk.setDial(() => { throw new Error("SDK dispatch failed"); });
  await sdk.connection.onMessage.emit({ type: "DIAL", id: 2, number: "9255550100" });
  assert.equal(sdk.connection.messages.at(-1).ok, false);
  sdk.connectionError();
  assert.equal(sdk.connection.messages.at(-1).enabled, false);
  assert.equal(sdk.errors.length, 3);
});

test("only the tracked top-level ADT and regular website ports are accepted", async () => {
  const browser = worker();
  for (const overrides of [
    { id: "foreign" }, { frameId: 1 }, { tab: { id: 20, windowId: 99 } },
    { url: "https://app.five9.com/other" }, { url: "https://example.com/" }
  ]) {
    assert.equal((await browser.connect("FIVE9_ADT_DIAL", overrides)).closed, true);
  }
  assert.equal((await browser.connect("FIVE9_PHONE_PAGE", { url: "chrome://settings/" })).closed, true);
});

test("Five9 domains of any suffix never initialize phone detection or accept website dialing ports", async () => {
  const browser = worker();
  for (const hostname of [
    "five9.com", "app.five9.com", "cdn.prod.us.five9.net",
    "app.five9.eu", "agents.five9.co.uk", "app.five9.test"
  ]) {
    const context = vm.createContext({ location: { hostname } });
    vm.runInContext(source("phone-numbers.js"), context);
    // No DOM or Chrome mocks: excluded hosts must exit before touching either.
    vm.runInContext(source("click-to-dial.js"), context);
    assert.equal((await browser.connect("FIVE9_PHONE_PAGE", {
      url: `https://${hostname}/`
    })).closed, true);
  }
  for (const hostname of ["example.com", "notfive9.com", "five9-tools.net"]) {
    assert.equal((await browser.connect("FIVE9_PHONE_PAGE", {
      url: `https://${hostname}/`
    })).closed, false);
  }
});

test("worker gates, normalizes, focuses and routes requests; logout removes eligibility", async () => {
  const browser = worker();
  const page = await browser.connect("FIVE9_PHONE_PAGE");
  const adt = await browser.connect("FIVE9_ADT_DIAL");
  await page.onMessage.emit({ type: "DIAL", id: 1, number: "9255550100" });
  assert.equal(page.messages.at(-1).ok, false);
  await adt.onMessage.emit({ type: "STATE", enabled: true });
  await page.onMessage.emit({ type: "DIAL", id: 2, number: "(925) 555-0100" });
  const request = adt.messages.at(-1);
  assert.equal(request.number, "9255550100");
  assert.deepEqual(JSON.parse(JSON.stringify(browser.updates)), [{ id: 10, focused: true, state: "normal" }]);
  await adt.onMessage.emit({ type: "RESULT", id: request.id, ok: true });
  assert.equal(page.messages.at(-1).id, 2);
  assert.equal(page.messages.at(-1).ok, true);
  await adt.onMessage.emit({ type: "STATE", enabled: false });
  await page.onMessage.emit({ type: "DIAL", id: 3, number: "9255550100" });
  assert.equal(page.messages.at(-1).ok, false);
});

test("worker blocks overlapping requests and clears pending requests on ADT disconnect", async () => {
  const browser = worker();
  const page = await browser.connect("FIVE9_PHONE_PAGE");
  const adt = await browser.connect("FIVE9_ADT_DIAL");
  await adt.onMessage.emit({ type: "STATE", enabled: true });
  await Promise.all([
    page.onMessage.emit({ type: "DIAL", id: 1, number: "9255550100" }),
    page.onMessage.emit({ type: "DIAL", id: 2, number: "9255550101" })
  ]);
  assert.equal(adt.messages.filter((message) => message.type === "DIAL").length, 1);
  assert.equal(page.messages.filter((message) => message.ok === false).length, 1);
  await adt.disconnect();
  assert.equal(page.messages.at(-1).ok, false);
  assert.equal(page.messages.some((message) => message.type === "STATE" && !message.enabled), true);
});

test("health checks disable stale connections on timeout and reenable after recovery", async () => {
  const sdk = bridge();
  await sdk.state("WORKING");
  sdk.setMaster(() => new Promise(() => {}));
  const check = sdk.runTimer();
  sdk.runTimer();
  await check;
  assert.equal(sdk.connection.messages.at(-1).enabled, false);
  assert.equal(sdk.errors.length, 1);
  sdk.setMaster(async () => true);
  await sdk.runTimer();
  assert.equal(sdk.connection.messages.at(-1).enabled, true);
});

test("a website closing during window lookup cancels its request without dispatching", async () => {
  const browser = worker();
  const page = await browser.connect("FIVE9_PHONE_PAGE");
  const adt = await browser.connect("FIVE9_ADT_DIAL");
  await adt.onMessage.emit({ type: "STATE", enabled: true });
  let finish;
  browser.setGetWindows(() => new Promise((resolve) => { finish = resolve; }));
  const request = page.onMessage.emit({ type: "DIAL", id: 1, number: "9255550100" });
  await page.disconnect();
  finish([{ id: 10, state: "normal" }]);
  await request;
  assert.equal(adt.messages.length, 0);
});
