(() => {
  let adt;
  let enabled = false;
  let nextId = 0;
  const pages = new Set();
  const pending = new Map();

  function failPending(error) {
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.port.postMessage({ type: "RESULT", id: request.pageId, ok: false, error });
      pending.delete(id);
    }
  }

  function publish(value) {
    enabled = value;
    for (const page of pages) {
      page.postMessage({ type: "STATE", enabled });
    }
  }

  chrome.runtime.onConnect.addListener((port) => {
    const sender = port.sender;
    let url;
    try {
      url = new URL(sender?.url);
    } catch {
      port.disconnect();
      return;
    }
    if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id)) {
      port.disconnect();
      return;
    }
    if (port.name === "FIVE9_PHONE_PAGE" && ["http:", "https:"].includes(url.protocol) &&
        !Five9PhoneNumbers.isFive9Host(url.hostname)) {
      pages.add(port);
      port.postMessage({ type: "STATE", enabled });
      port.onDisconnect.addListener(() => {
        pages.delete(port);
        for (const [id, request] of pending) {
          if (request.port === port) {
            clearTimeout(request.timer);
            pending.delete(id);
          }
        }
      });
      port.onMessage.addListener(async (message) => {
        if (message?.type !== "DIAL") {
          return;
        }
        try {
          const number = Five9PhoneNumbers.normalize(message.number);
          if (!enabled || !adt) {
            throw new Error("Sign in to the extension's Five9 ADT window before dialing.");
          }
          if (pending.size) {
            throw new Error("A dial request is already pending. Check ADT before trying again.");
          }
          const target = adt;
          const windows = await chrome.windows.getAll({ windowTypes: ["popup"] });
          const window = windows.find((item) => item.id === target.sender.tab.windowId);
          if (!window || !enabled || adt !== target || !pages.has(port)) {
            throw new Error("Five9 ADT is no longer connected.");
          }
          await chrome.windows.update(window.id, {
            focused: true, ...(window.state === "minimized" ? { state: "normal" } : {})
          });
          if (!enabled || adt !== target || pending.size || !pages.has(port)) {
            throw new Error("Five9 state changed or another dial request is pending. Check ADT.");
          }
          const id = ++nextId;
          const timer = setTimeout(() => {
            pending.delete(id);
            port.postMessage({
              type: "RESULT", id: message.id, ok: false,
              error: "Five9 did not confirm the request. Check ADT before retrying."
            });
            console.error("#### Five9 click-to-dial confirmation timed out.");
          }, 12000);
          pending.set(id, { port, pageId: message.id, timer });
          try {
            target.postMessage({ type: "DIAL", id, number });
          } catch (error) {
            clearTimeout(timer);
            pending.delete(id);
            throw error;
          }
        } catch (error) {
          console.error("#### Five9 click-to-dial rejected:", error.message);
          if (pages.has(port)) {
            port.postMessage({ type: "RESULT", id: message.id, ok: false, error: error.message });
          }
        }
      });
      return;
    }
    if (port.name !== "FIVE9_ADT_DIAL" || sender.frameId !== 0 ||
        !["https://app.five9.com", "https://app.five9.eu"].includes(url.origin) ||
        url.pathname !== "/clients/integrations/adt.main.html") {
      port.disconnect();
      return;
    }
    let closed = false;
    port.onDisconnect.addListener(() => {
      closed = true;
      if (adt === port) {
        adt = undefined;
        publish(false);
        failPending("Five9 ADT disconnected. Check ADT before retrying.");
      }
    });
    const authorized = chrome.storage.session.get("adtWindowId").then((stored) => {
      if (closed) {
        return false;
      }
      if (stored.adtWindowId !== sender.tab.windowId) {
        port.disconnect();
        return false;
      }
      if (adt && adt !== port) {
        adt.disconnect();
      }
      adt = port;
      publish(false);
      return true;
    }).catch((error) => {
      console.error("#### Five9 click-to-dial sender validation failed:", error.message);
      port.disconnect();
      return false;
    });
    port.onMessage.addListener(async (message) => {
      if (!await authorized || closed || adt !== port) {
        return;
      }
      if (message?.type === "STATE") {
        publish(message.enabled === true);
      } else if (message?.type === "RESULT") {
        const request = pending.get(message.id);
        if (request) {
          clearTimeout(request.timer);
          pending.delete(message.id);
          request.port.postMessage({
            type: "RESULT", id: request.pageId, ok: message.ok === true,
            error: message.ok === true ? undefined : "Five9 rejected the request. Check its login and connection."
          });
        }
      }
    });
  });
})();
