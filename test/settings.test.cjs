const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const context = vm.createContext({ URL });
vm.runInContext(readFileSync(new URL("../settings.js", `file://${__filename}`), "utf8"), context);
const { validateSettings, buildScreenPopUrl } = context.Five9Settings;

test("diagnostic URLs preserve the destination while redacting authentication parameters", () => {
  assert.equal(context.Five9Settings.getDiagnosticUrl("https://example.com/record/123?view=full"),
    "https://example.com/record/123?view=full");
  const logged = context.Five9Settings.getDiagnosticUrl(
    "https://example.com/record/123?access_token=private&view=full#id_token=private"
  );
  assert.doesNotMatch(logged, /private/);
  assert.match(logged, /view=full/);
});

test("URL-variable logs preserve placeholders and nulls without exposing credentials", () => {
  const { getDiagnosticTemplateValue } = context.Five9Settings;
  assert.equal(getDiagnosticTemplateValue(null), null);
  assert.equal(getDiagnosticTemplateValue(""), "");
  assert.equal(getDiagnosticTemplateValue("https://example.com/{Salesforce.Id}"),
    "https://example.com/{Salesforce.Id}");
  assert.doesNotMatch(getDiagnosticTemplateValue("https://private:password@example.com/?token=private"),
    /private|password/);
  assert.equal(getDiagnosticTemplateValue("invalid private value"), "[invalid URL; value omitted]");
});

test("diagnostic snapshots include ordinary values but redact nested authentication data", () => {
  const snapshot = JSON.parse(context.Five9Settings.serializeDiagnostics({
    callData: { interactionId: "CALL123", number: "5550100", count: 0, connected: false },
    credentials: { password: "private-password", accessToken: "private-token" },
    cavs: [
      { group: "Customer", name: "screenpop_url", value: "https://example.com/{Record.Id}" },
      { group: "Auth", name: "ApiKey", value: "private-key" }
    ]
  }));
  assert.equal(snapshot.callData.interactionId, "CALL123");
  assert.equal(snapshot.callData.count, 0);
  assert.equal(snapshot.callData.connected, false);
  assert.equal(snapshot.cavs[0].value, "https://example.com/{Record.Id}");
  assert.equal(snapshot.cavs[1].value, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(snapshot), /private-password|private-token|private-key/);
});

test("validates initial size bounds and supported ADT URLs", () => {
  for (const settings of [
    { width: 319 }, { width: 1601 }, { width: 420.5 }, { height: 319 }, { height: 1201 },
    { adtUrl: "http://app.five9.com/clients/integrations/adt.main.html" },
    { adtUrl: "https://app.five9.com/other" },
    { adtUrl: "https://app.five9.com.evil.example/clients/integrations/adt.main.html" },
    { adtUrl: "https://user:password@app.five9.com/clients/integrations/adt.main.html" }
  ]) {
    assert.throws(() => validateSettings(settings));
  }
  const settings = validateSettings({
    width: 320, height: 1200,
    adtUrl: " https://app.five9.eu/clients/integrations/adt.main.html?f9crmapi=false "
  });
  assert.equal(settings.adtUrl, "https://app.five9.eu/clients/integrations/adt.main.html?f9crmapi=false");
});

test("allows only HTTPS templates with a fixed hostname and balanced placeholders", () => {
  for (const screenPopUrl of [
    "javascript:alert(1)", "http://example.com/{A.B}", "https://{A.B}/record",
    "https://example.com/{A.B", "https://example.com/{}", "https://example.com/{ }",
    "https://user:password@example.com/{A.B}"
  ]) {
    assert.throws(() => validateSettings({ screenPopUrl }));
  }
});

test("substitutes multiple and repeated variables safely in path, query, and fragment", () => {
  const settings = validateSettings({
    screenPopUrl: "https://example.com/accounts/{Subscriber.AccountNumber}?call={Call.Id}#repeat={Call.Id}"
  });
  assert.equal(buildScreenPopUrl(settings, {
    "Subscriber.AccountNumber": " a/b?c#d ",
    "Call.Id": "x&next=https://other.example"
  }), "https://example.com/accounts/a%2Fb%3Fc%23d?call=x%26next%3Dhttps%3A%2F%2Fother.example#repeat=x%26next%3Dhttps%3A%2F%2Fother.example");
});

test("missing variables always skip a candidate regardless of the retired checkbox", () => {
  const settings = validateSettings({ screenPopUrl: "https://example.com/{A.B}?other={C.D}" });
  for (const value of [undefined, null, "", "  "]) {
    assert.equal(buildScreenPopUrl(settings, { "A.B": "123", "C.D": value }), null);
    assert.equal(buildScreenPopUrl({ ...settings, skipNullVariables: false }, {
      "A.B": "123", "C.D": value
    }), null);
  }
  assert.equal(buildScreenPopUrl(settings, { "A.B": 0, "C.D": false }),
    "https://example.com/0?other=false");
});

test("default URL variables resolve by priority and skip when neither is populated", () => {
  const settings = validateSettings({});
  const values = {
    "Screenpop.URL": " https://example.com/first?x=1&y=2 ",
    "Customer.screenpop_url": "https://example.com/second"
  };
  assert.equal(buildScreenPopUrl(settings, values), "https://example.com/first?x=1&y=2");
  for (const value of [undefined, null, "", "  "]) {
    assert.equal(buildScreenPopUrl(settings, { ...values, "Screenpop.URL": value }),
      "https://example.com/second");
  }
  assert.equal(buildScreenPopUrl(settings, {}), null);
  assert.equal(buildScreenPopUrl(validateSettings({ screenPopUrl: "" }), values),
    "https://example.com/second");
});

test("complete URL variables must be HTTPS without embedded credentials", () => {
  for (const value of ["javascript:alert(1)", "http://example.com", "not-a-url",
    "https://user:password@example.com/record"]) {
    assert.throws(() => buildScreenPopUrl(validateSettings({}), { "Screenpop.URL": value }));
  }
});

test("resolves placeholders inside complete URL variables, including encoded braces", () => {
  for (const placeholder of ["{Salesforce.salesforce_id}", "%7BSalesforce.salesforce_id%7D"]) {
    const values = {
      "Screenpop.URL": `https://squirion-dev-ed.lightning.force.com/${placeholder}?view=full`,
      "Salesforce.salesforce_id": "003TEST"
    };
    assert.equal(buildScreenPopUrl(validateSettings({}), values),
      "https://squirion-dev-ed.lightning.force.com/003TEST?view=full");
    assert.deepEqual([...context.Five9Settings.getVariableNames("{Screenpop.URL}", values)],
      ["Screenpop.URL", "Salesforce.salesforce_id"]);
  }
});

test("nested missing variables skip the candidate and allow priority fallback", () => {
  const settings = validateSettings({});
  const values = {
    "Screenpop.URL": "https://example.com/{Salesforce.Id}",
    "Customer.screenpop_url": "https://example.com/fallback/{Customer.Id}",
    "Customer.Id": "123"
  };
  assert.equal(buildScreenPopUrl(settings, values), "https://example.com/fallback/123");
  assert.equal(buildScreenPopUrl(settings, { "Screenpop.URL": values["Screenpop.URL"] }), null);
});

test("resolves URL-variable chains and rejects cycles or dynamic hosts", () => {
  const settings = validateSettings({});
  assert.equal(buildScreenPopUrl(settings, {
    "Screenpop.URL": "{Customer.screenpop_url}",
    "Customer.screenpop_url": "https://example.com/{Salesforce.Id}",
    "Salesforce.Id": "003TEST"
  }), "https://example.com/003TEST");
  for (const values of [
    { "Screenpop.URL": "{Screenpop.URL}" },
    { "Screenpop.URL": "{Customer.URL}", "Customer.URL": "{Screenpop.URL}" },
    { "Screenpop.URL": "https://{Customer.Host}/record", "Customer.Host": "example.com" }
  ]) {
    assert.throws(() => buildScreenPopUrl(settings, values));
  }
});

test("retains previous templates and window settings but removes the retired checkbox", () => {
  const settings = validateSettings({
    width: 650, height: 800, screenPopUrl: "https://example.com/{A.B}", skipNullVariables: false
  });
  assert.equal(settings.width, 650);
  assert.equal(settings.screenPopUrl, "https://example.com/{A.B}");
  assert.equal(settings.fallbackScreenPopUrl, "{Customer.screenpop_url}");
  assert.equal("skipNullVariables" in settings, false);
  assert.equal(settings.reuseScreenPopTab, false);
  assert.equal(validateSettings({ reuseScreenPopTab: true }).reuseScreenPopTab, true);
  assert.throws(() => validateSettings({ reuseScreenPopTab: "true" }));
});

test("blank templates disable pops and invalid value types cannot silently substitute", () => {
  assert.equal(buildScreenPopUrl(validateSettings({ screenPopUrl: "" }), {}), null);
  const settings = validateSettings({ screenPopUrl: "https://example.com/{A.B}" });
  for (const value of [{}, [], Infinity, ".", ".."]) {
    assert.throws(() => buildScreenPopUrl(settings, { "A.B": value }));
  }
});
