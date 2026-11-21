const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(new URL("../screen-pop.js", `file://${__filename}`), "utf8");
const settingsSource = readFileSync(new URL("../settings.js", `file://${__filename}`), "utf8");

function bridge({
  master = true, masterError, reply = { ok: true }, sendError, cavError, crmError,
  contactFields = [],
  variables = [{ group: "Subscriber", name: "AccountNumber", value: "001TEST" }],
  settings = {
    screenPopUrl: "https://squirion-dev-ed.lightning.force.com/{Subscriber.AccountNumber}",
    fallbackScreenPopUrl: ""
  }
} = {}) {
  let callbacks;
  let isMaster = master;
  const messages = [];
  const errors = [];
  const infos = [];
  const lookups = [];
  const crmLookups = [];
  let preferences = settings;
  const context = {
    URL,
    window: {
      Five9: {
        CrmSdk: {
          interactionApi: () => ({
            subscribe(value) {
              callbacks = value;
            },
            async isMasterPage() {
              if (masterError) {
                throw masterError;
              }
              return isMaster;
            },
            async getCav(params) {
              lookups.push(params);
              if (cavError) {
                throw cavError;
              }
              return variables;
            },
            async getCrm(params) {
              crmLookups.push(params);
              if (crmError) {
                throw crmError;
              }
              return contactFields;
            }
          })
        }
      }
    },
    chrome: {
      storage: { local: { async get() { return { settings: preferences }; } } },
      runtime: {
        async sendMessage(message) {
          if (sendError) {
            throw sendError;
          }
          messages.push(message);
          return reply;
        }
      }
    },
    console: {
      error: (...args) => errors.push(args),
      info: (...args) => infos.push(args)
    }
  };
  const vmContext = vm.createContext(context);
  vm.runInContext(settingsSource, vmContext);
  vm.runInContext(source, vmContext);
  return {
    messages,
    errors,
    infos,
    lookups,
    crmLookups,
    setSettings(settings) {
      preferences = settings;
    },
    call: (interactionId = "test-call") => callbacks.callStarted({
      callData: { interactionId, interactionSubType: "INBOUND" }
    }),
    master(value) {
      isMaster = value;
    }
  };
}

test("subscribes to callStarted, suppresses duplicate events, and allows subsequent calls", async () => {
  const sdk = bridge();
  await Promise.all([sdk.call(), sdk.call()]);
  await sdk.call("next-call");
  assert.equal(sdk.messages.length, 2);
  assert.equal(sdk.messages[0].type, "FIVE9_CALL_STARTED");
  assert.equal(sdk.messages[0].values["Subscriber.AccountNumber"], "001TEST");
  assert.deepEqual(Object.keys(sdk.messages[0]), ["type", "values"]);
  assert.equal(sdk.lookups[0].interactionId, "test-call");
  assert.equal(sdk.lookups[0].interactionSubType, "INBOUND");
  assert.equal(sdk.errors.length, 0);
});

test("only the master instance requests a screen pop", async () => {
  const sdk = bridge({ master: false });
  await sdk.call();
  assert.equal(sdk.messages.length, 0);
  assert.equal(sdk.lookups.length, 0);
  sdk.master(true);
  await sdk.call();
  assert.equal(sdk.messages.length, 1);
});

test("reports invalid events without sending call data", async () => {
  const sdk = bridge();
  await sdk.call("");
  await sdk.call(123);
  assert.equal(sdk.messages.length, 0);
  assert.equal(sdk.errors.length, 2);
});

test("reports SDK, messaging, and background failures without logging interaction data", async () => {
  for (const options of [
    { masterError: new Error("sensitive SDK error") },
    { cavError: new Error("sensitive CAV error") },
    { sendError: new Error("sensitive messaging error") },
    { reply: { ok: false } }
  ]) {
    const sdk = bridge(options);
    await sdk.call("private-interaction");
    await sdk.call("private-interaction");
    assert.equal(sdk.errors.length, 2);
    assert.doesNotMatch(JSON.stringify(sdk.errors), /sensitive|private-interaction/);
  }
});

test("reads qualified variable names and trims the account number", async () => {
  const sdk = bridge({
    variables: [
      { group: "Other", name: "AccountNumber", value: "WRONG" },
      { name: "Subscriber.AccountNumber", value: "  001DYNAMIC  " }
    ]
  });
  await sdk.call();
  assert.equal(sdk.messages[0].values["Subscriber.AccountNumber"], "001DYNAMIC");
});

test("skips missing or blank account numbers without a fallback screen pop", async () => {
  for (const variables of [
    [],
    [{ group: "Other", name: "AccountNumber", value: "WRONG" }],
    [{ group: "Other", name: "Subscriber.AccountNumber", value: "WRONG" }],
    [{ group: "Subscriber", name: "AccountNumber", value: "  " }],
    [{ group: "Subscriber", name: "AccountNumber", value: null }]
  ]) {
    const sdk = bridge({ variables });
    await sdk.call();
    assert.equal(sdk.messages.length, 0);
    assert.equal(sdk.errors.length, 0);
    assert.ok(sdk.infos.some(([message]) => /^#### .*required variable is null/.test(message)));
  }
});

test("logs both configured templates including empty fields even when no pop occurs", async () => {
  for (const settings of [
    { screenPopUrl: "", fallbackScreenPopUrl: "" },
    { screenPopUrl: "{Screenpop.URL}", fallbackScreenPopUrl: "{Customer.screenpop_url}" }
  ]) {
    const sdk = bridge({ settings, variables: [] });
    await sdk.call();
    const templateLogs = sdk.infos.filter(([message]) => message.includes("screen-pop priority"));
    assert.deepEqual(templateLogs, [
      ["#### Five9 ADT screen-pop priority 1:", settings.screenPopUrl, settings.screenPopUrl ? null : ""],
      ["#### Five9 ADT screen-pop priority 2:", settings.fallbackScreenPopUrl, settings.fallbackScreenPopUrl ? null : ""]
    ]);
    assert.equal(sdk.messages.length, 0);
  }
});

test("identifies failures before template logging without exposing SDK errors", async () => {
  const sdk = bridge({ masterError: new Error("private-sdk-details") });
  await sdk.call();
  assert.equal(sdk.errors[0][1], "checking the master ADT connection");
  assert.ok(sdk.infos.some(([message]) => message.includes("processing callStarted")));
  assert.doesNotMatch(JSON.stringify(sdk.errors), /private-sdk-details/);

  const invalidSettings = bridge({ settings: { width: 1 } });
  await invalidSettings.call();
  assert.equal(invalidSettings.errors[0][1], "loading and validating saved options");
});

test("identifies CAV, resolved URL, and service-worker failures separately", async () => {
  for (const [options, stage] of [
    [{ cavError: new Error("private") }, "reading call variables through getCav"],
    [{
      settings: {},
      variables: [{ group: "Screenpop", name: "URL", value: "not-a-url" }]
    }, "validating the resolved screen-pop URL"],
    [{ reply: { ok: false } }, "opening the screen-pop page in the extension service worker"]
  ]) {
    const sdk = bridge(options);
    await sdk.call();
    assert.equal(sdk.errors[0][1], stage);
  }
});

test("passes only requested CAVs and picks up template changes without restarting ADT", async () => {
  const sdk = bridge({
    variables: [
      { group: "Subscriber", name: "AccountNumber", value: "001TEST" },
      { group: "Call", name: "Type", value: "INBOUND" },
      { group: "Private", name: "Unused", value: "do-not-send" }
    ]
  });
  sdk.setSettings({
    screenPopUrl: "https://example.com/{Subscriber.AccountNumber}?type={Call.Type}",
    fallbackScreenPopUrl: ""
  });
  await sdk.call();
  assert.deepEqual(Object.keys(sdk.messages[0].values), ["Subscriber.AccountNumber", "Call.Type"]);
  assert.equal(sdk.messages[0].values["Call.Type"], "INBOUND");
  assert.doesNotMatch(JSON.stringify(sdk.messages), /do-not-send/);
  sdk.setSettings({ screenPopUrl: "", fallbackScreenPopUrl: "" });
  await sdk.call("disabled-call");
  assert.equal(sdk.messages.length, 1);
  assert.equal(sdk.lookups.length, 1);
});

test("missing values always skip and static templates do not fetch CAVs", async () => {
  const sdk = bridge({ variables: [] });
  await sdk.call();
  assert.equal(sdk.messages.length, 0);
  sdk.setSettings({ screenPopUrl: "https://example.com/static", fallbackScreenPopUrl: "" });
  await sdk.call("static-call");
  assert.equal(sdk.messages.length, 1);
  assert.equal(sdk.lookups.length, 1);
});

test("reads both default URL variables and sends them for priority resolution", async () => {
  const sdk = bridge({
    settings: {},
    variables: [
      { group: "Screenpop", name: "URL", value: null }
    ],
    contactFields: [{ name: "screenpop_url", value: "https://example.com/fallback" }]
  });

  await sdk.call();
  assert.equal(sdk.messages.length, 1);
  assert.equal(sdk.messages[0].values["Screenpop.URL"], null);
  assert.equal(sdk.messages[0].values["Customer.screenpop_url"], "https://example.com/fallback");
  const variableLogs = sdk.infos.filter(([message]) => message.includes("screen-pop priority"));
  assert.deepEqual(variableLogs, [
    ["#### Five9 ADT screen-pop priority 1:", "{Screenpop.URL}", null],
    ["#### Five9 ADT screen-pop priority 2:", "{Customer.screenpop_url}", "https://example.com/fallback"]
  ]);
  const resolved = sdk.infos.find(([message]) => message.includes("resolved screen-pop URL:"));
  assert.equal(resolved[1], "https://example.com/fallback");
});

test("discovers nested CAVs from URL-valued variables and resolves the final destination", async () => {
  const sdk = bridge({
    settings: {},
    variables: [
      { group: "Screenpop", name: "URL", value: "https://example.com/%7BSalesforce.salesforce_id%7D" },
      { group: "Salesforce", name: "salesforce_id", value: "003TEST" },
      { group: "Private", name: "Unused", value: "do-not-send" }
    ]
  });
  await sdk.call();
  assert.equal(sdk.messages.length, 1);
  assert.equal(sdk.messages[0].values["Salesforce.salesforce_id"], "003TEST");
  assert.equal(sdk.lookups.length, 1);
  const variableLog = sdk.infos.find(([message, name]) =>
    message.includes("screen-pop priority") && name === "{Screenpop.URL}");
  assert.equal(variableLog[2], "https://example.com/{Salesforce.salesforce_id}");
  assert.equal(sdk.infos.find(([message]) => message.includes("resolved screen-pop URL:"))[1],
    "https://example.com/003TEST");
  assert.doesNotMatch(JSON.stringify(sdk.messages), /do-not-send/);
});

test("reports invalid or ambiguous CAV data without exposing values", async () => {
  for (const variables of [
    {},
    [{ group: "Subscriber", name: "AccountNumber", value: {} }],
    [
      { group: "Subscriber", name: "AccountNumber", value: "private-account" },
      { name: "Subscriber.AccountNumber", value: "private-account" }
    ]
  ]) {
    const sdk = bridge({ variables });
    await sdk.call();
    assert.equal(sdk.messages.length, 0);
    assert.equal(sdk.errors.length, 1);
    assert.doesNotMatch(JSON.stringify(sdk.errors), /private-account/);
  }
});

test("does not log getCav or getCrm result lists", async () => {
  const sdk = bridge({
    settings: {},
    variables: [
      { group: "Customer ", name: "screenpop_url", value: "https://example.com/private-record" },
      { group: "Screenpop", name: "URL", value: null },
      { group: "Private", name: "Token", value: "private-token" }
    ]
  });
  await sdk.call();
  assert.equal(sdk.lookups.length, 1);
  assert.equal(sdk.crmLookups.length, 1);
  assert.equal(sdk.infos.some(([message]) => /getCav result|getCrm result/.test(message)), false);
  assert.doesNotMatch(JSON.stringify(sdk.infos), /private-record|private-token/);
});

test("logs incoming callStarted structure before validation and duplicate suppression", async () => {
  const sdk = bridge();
  await sdk.call("private-interaction");
  await sdk.call("private-interaction");
  await sdk.call("");
  const logs = sdk.infos.filter(([message]) => message.includes("callStarted incoming params"));
  assert.equal(logs.length, 3);
  const snapshot = JSON.parse(logs[0][1]);
  assert.equal(snapshot.callData.interactionId, "private-interaction");
  assert.equal(snapshot.callData.interactionSubType, "INBOUND");
});

test("Customer and Contact aliases read getCrm once and never use matching CAVs", async () => {
  const sdk = bridge({
    settings: {
      screenPopUrl: "https://example.com/{Customer.Id}?contact={Contact.Id}",
      fallbackScreenPopUrl: ""
    },
    variables: [{ group: "Customer", name: "Id", value: "WRONG" }],
    contactFields: [{ name: "Id", value: "CRM123" }]
  });
  await sdk.call();
  assert.equal(sdk.lookups.length, 0);
  assert.equal(sdk.crmLookups.length, 1);
  assert.equal(sdk.crmLookups[0].interactionId, "test-call");
  assert.equal(sdk.messages[0].values["Customer.Id"], "CRM123");
  assert.equal(sdk.messages[0].values["Contact.Id"], "CRM123");
  assert.equal(sdk.infos.find(([message]) => message.includes("resolved screen-pop URL:"))[1],
    "https://example.com/CRM123?contact=CRM123");
  assert.equal(sdk.infos.some(([message]) => message.includes("getCrm result:")), false);
});

test("contact URL fields can introduce nested CAVs and contact placeholders", async () => {
  const sdk = bridge({
    settings: { screenPopUrl: "{Customer.screenpop_url}", fallbackScreenPopUrl: "" },
    contactFields: [
      { name: "screenpop_url", value: "https://example.com/{Salesforce.Id}?contact={Contact.Id}" },
      { name: "Id", value: "CRM123" }
    ],
    variables: [{ group: "Salesforce", name: "Id", value: "003TEST" }]
  });
  await sdk.call();
  assert.equal(sdk.lookups.length, 1);
  assert.equal(sdk.crmLookups.length, 1);
  assert.equal(sdk.infos.find(([message]) => message.includes("resolved screen-pop URL:"))[1],
    "https://example.com/003TEST?contact=CRM123");
});

test("getCrm failures and ambiguous contact fields report errors without a false pop", async () => {
  for (const options of [
    { crmError: new Error("private CRM details") },
    { contactFields: {} },
    { contactFields: [{ name: "Id", value: "one" }, { name: "Id", value: "two" }] }
  ]) {
    const sdk = bridge({
      settings: { screenPopUrl: "https://example.com/{Contact.Id}", fallbackScreenPopUrl: "" },
      ...options
    });
    await sdk.call();
    assert.equal(sdk.messages.length, 0);
    assert.equal(sdk.errors.length, 1);
    assert.doesNotMatch(JSON.stringify(sdk.errors), /private CRM details/);
  }
});

test("CAV URL templates resolve nested contact fields through getCrm", async () => {
  const sdk = bridge({
    settings: { screenPopUrl: "{Screenpop.URL}", fallbackScreenPopUrl: "" },
    variables: [{ group: "Screenpop", name: "URL", value: "https://example.com/{Customer.Id}" }],
    contactFields: [{ name: "Id", value: "CRM123" }]
  });
  await sdk.call();
  assert.equal(sdk.lookups.length, 1);
  assert.equal(sdk.crmLookups.length, 1);
  assert.equal(sdk.messages[0].values["Customer.Id"], "CRM123");
  assert.equal(sdk.infos.find(([message]) => message.includes("resolved screen-pop URL:"))[1],
    "https://example.com/CRM123");
});
