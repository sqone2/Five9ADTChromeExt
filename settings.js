(() => {
  const AUTH_FIELD = /password|passphrase|secret|token|authorization|cookie|api[-_]?key|session[-_]?id|sso|assertion|saml|oauth|^code$/i;
  const DEFAULT_ADT_URL = "https://app.five9.com/clients/integrations/adt.main.html";
  const DEFAULTS = Object.freeze({
    width: 420,
    height: 760,
    adtUrl: "",
    screenPopUrl: "{Screenpop.URL}",
    fallbackScreenPopUrl: "{Customer.screenpop_url}",
    reuseScreenPopTab: false
  });

  function normalizePlaceholders(template) {
    return template.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
  }

  function getVariableNames(template, values = {}, visited = new Set()) {
    const normalized = normalizePlaceholders(template);
    const names = [...new Set([...normalized.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]))];
    if (/^\{[^{}]+\}$/.test(normalized)) {
      const name = names[0];
      if (visited.has(name)) {
        throw new Error("Screen-pop URL variables contain a circular reference.");
      }
      const value = Object.hasOwn(values, name) ? values[name] : null;
      if (typeof value === "string" && value.trim()) {
        const nested = getVariableNames(value.trim(), values, new Set([...visited, name]));
        return [...new Set([...names, ...nested])];
      }
    }
    return names;
  }

  function parseHttpsUrl(value, label) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${label} must be a valid HTTPS URL.`);
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error(`${label} must use HTTPS and cannot contain credentials.`);
    }
    return url;
  }

  function validateSettings(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Settings must be an object.");
    }
    const settings = {
      width: input.width ?? DEFAULTS.width,
      height: input.height ?? DEFAULTS.height,
      adtUrl: input.adtUrl ?? DEFAULTS.adtUrl,
      screenPopUrl: input.screenPopUrl ?? DEFAULTS.screenPopUrl,
      fallbackScreenPopUrl: input.fallbackScreenPopUrl ?? DEFAULTS.fallbackScreenPopUrl,
      reuseScreenPopTab: input.reuseScreenPopTab ?? DEFAULTS.reuseScreenPopTab
    };
    if (!Number.isInteger(settings.width) || settings.width < 320 || settings.width > 1600 ||
        !Number.isInteger(settings.height) || settings.height < 320 || settings.height > 1200) {
      throw new Error("Width must be 320-1600 pixels and height must be 320-1200 pixels (whole numbers).");
    }
    if ([settings.adtUrl, settings.screenPopUrl, settings.fallbackScreenPopUrl]
      .some((value) => typeof value !== "string")) {
      throw new Error("URLs must be text.");
    }
    if (typeof settings.reuseScreenPopTab !== "boolean") {
      throw new Error("Reuse screen-pop tab must be a checkbox value.");
    }
    settings.adtUrl = settings.adtUrl.trim();
    settings.screenPopUrl = settings.screenPopUrl.trim();
    settings.fallbackScreenPopUrl = settings.fallbackScreenPopUrl.trim();
    const adt = parseHttpsUrl(settings.adtUrl || DEFAULT_ADT_URL, "ADT URL");
    if (!["https://app.five9.com", "https://app.five9.eu"].includes(adt.origin) ||
        adt.pathname !== "/clients/integrations/adt.main.html") {
      throw new Error("Use the Five9 US or Europe ADT URL, optionally with query parameters.");
    }
    for (const template of [settings.screenPopUrl, settings.fallbackScreenPopUrl]) {
      if (!template) {
        continue;
      }
      const sample = template.replace(/\{([^{}]+)\}/g, "placeholder");
      if (/[{}]/.test(sample) || getVariableNames(template).some((name) => !name.trim())) {
        throw new Error("Screen-pop variables must use balanced, nonempty {Group.Name} placeholders.");
      }
      if (/^\{[^{}]+\}$/.test(template)) {
        continue;
      }
      const authority = /^https:\/\/[^/?#]+/i.exec(template)?.[0];
      if (!authority || /[{}]/.test(authority)) {
        throw new Error("Screen-pop variables are allowed only after the hostname, not in it.");
      }
      parseHttpsUrl(sample, "Screen-pop URL");
    }
    return settings;
  }

  async function getSettings() {
    const { settings } = await chrome.storage.local.get("settings");
    return validateSettings(settings === undefined ? {} : settings);
  }

  function buildScreenPopUrl(settings, values) {
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new Error("Screen-pop variable values must be an object.");
    }
    for (const template of [settings.screenPopUrl, settings.fallbackScreenPopUrl]) {
      if (!template) {
        continue;
      }
      const result = renderTemplate(template, values);
      if (result) {
        return result;
      }
    }
    return null;
  }

  function renderTemplate(template, values, visited = new Set()) {
    template = normalizePlaceholders(template);
    let missing = false;
    const wholeUrlVariable = /^\{[^{}]+\}$/.test(template);
    if (wholeUrlVariable) {
      const name = getVariableNames(template)[0];
      if (visited.has(name)) {
        throw new Error("Screen-pop URL variables contain a circular reference.");
      }
      const value = Object.hasOwn(values, name) ? values[name] : null;
      if (value == null || (typeof value === "string" && !value.trim())) {
        return null;
      }
      if (typeof value !== "string") {
        throw new Error("A complete screen-pop URL variable must contain text.");
      }
      return renderTemplate(value.trim(), values, new Set([...visited, name]));
    }
    const sample = template.replace(/\{([^{}]+)\}/g, "placeholder");
    const authority = /^https:\/\/[^/?#]+/i.exec(template)?.[0];
    if (/[{}]/.test(sample) || getVariableNames(template).some((name) => !name.trim()) ||
        !authority || /[{}]/.test(authority)) {
      throw new Error("A screen-pop URL has invalid or hostname placeholders.");
    }
    parseHttpsUrl(sample, "Screen-pop URL");
    const rendered = template.replace(/\{([^{}]+)\}/g, (_, name) => {
      const value = Object.hasOwn(values, name) ? values[name] : null;
      if (value == null || (typeof value === "string" && !value.trim())) {
        missing = true;
        return "";
      }
      if (!["string", "number", "boolean"].includes(typeof value) ||
          (typeof value === "number" && !Number.isFinite(value))) {
        throw new Error("A screen-pop variable has an unsupported value type.");
      }
      const text = String(value).trim();
      if (text === "." || text === "..") {
        throw new Error("A screen-pop variable cannot be a relative-path segment.");
      }
      return encodeURIComponent(text);
    });
    if (missing) {
      return null;
    }
    const url = parseHttpsUrl(rendered, "Screen-pop URL");
    const expected = new URL(sample);
    if (url.origin !== expected.origin) {
      throw new Error("Screen-pop variables cannot change the URL origin.");
    }
    return url.href;
  }

  function getDiagnosticUrl(value) {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    const sensitive = /password|passphrase|secret|token|authorization|cookie|api[-_]?key|session[-_]?id|sso|assertion|saml|oauth|code/i;
    for (const name of [...url.searchParams.keys()]) {
      if (sensitive.test(name)) {
        url.searchParams.set(name, "[REDACTED]");
      }
    }
    if (sensitive.test(url.hash)) {
      url.hash = "[REDACTED]";
    }
    return url.href;
  }

  function getDiagnosticTemplateValue(value) {
    if (value == null || value === "") {
      return value;
    }
    if (typeof value !== "string") {
      return "[unsupported value type]";
    }
    if (/^\{[^{}]+\}$/.test(value)) {
      return value;
    }
    try {
      return normalizePlaceholders(getDiagnosticUrl(value));
    } catch {
      return "[invalid URL; value omitted]";
    }
  }

  function serializeDiagnostics(data) {
    return JSON.stringify(data, function (key, value) {
      if (AUTH_FIELD.test(key) ||
          (key === "value" && AUTH_FIELD.test(String(this.name || this.key || "")))) {
        return "[REDACTED]";
      }
      if (typeof value === "string" && /^https?:\/\//i.test(value)) {
        try {
          return normalizePlaceholders(getDiagnosticUrl(value));
        } catch {
          return "[invalid URL; value omitted]";
        }
      }
      return value;
    });
  }

  globalThis.Five9Settings = Object.freeze({
    DEFAULT_ADT_URL, DEFAULTS, validateSettings, getSettings, getVariableNames, buildScreenPopUrl,
    getDiagnosticUrl, getDiagnosticTemplateValue, serializeDiagnostics
  });
})();
