(() => {
  if (Five9PhoneNumbers.isFive9Host(location.hostname) || !(document.body instanceof HTMLElement)) {
    return;
  }
  const links = new Set();
  const roots = new Set();
  const excluded = "a,button,input,textarea,select,script,style,noscript,pre,code,[contenteditable],[role=button],[role=textbox]";
  let enabled = false;
  let port;
  let stopped = false;
  let scheduled = false;
  let nextId = 0;
  let pendingId;

  function report(error) {
    console.error("#### Five9 click-to-dial:", error);
    window.alert(`Five9 click-to-dial: ${error}`);
  }

  function scan(root) {
    if (!root.isConnected || root.parentElement?.closest(excluded)) {
      return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = root.nodeType === Node.TEXT_NODE ? [root] : [];
    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }
    for (const node of nodes) {
      if (!(node.parentElement instanceof HTMLElement) || node.parentElement.closest(excluded)) {
        continue;
      }
      const matches = Five9PhoneNumbers.find(node.data);
      if (!matches.length) {
        continue;
      }
      const fragment = document.createDocumentFragment();
      let offset = 0;
      for (const match of matches) {
        fragment.append(node.data.slice(offset, match.index));
        const link = document.createElement("a");
        link.textContent = match.text;
        link.href = `tel:${match.number}`;
        link.title = "Dial with Five9";
        link.style.textDecoration = "underline";
        link.style.color = "inherit";
        links.add(link);
        fragment.append(link);
        offset = match.index + match.text.length;
      }
      fragment.append(node.data.slice(offset));
      node.replaceWith(fragment);
    }
    for (const link of links) {
      if (!link.isConnected) {
        links.delete(link);
      }
    }
  }

  const observer = new MutationObserver((changes) => {
    for (const change of changes) {
      if (change.type === "characterData") {
        roots.add(change.target);
      } else {
        for (const node of change.addedNodes) {
          roots.add(node);
        }
      }
    }
    if (!scheduled) {
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        if (enabled) {
          for (const root of roots) {
            scan(root);
          }
        }
        roots.clear();
      }, 50);
    }
  });

  function setEnabled(value) {
    if (enabled === value) {
      return;
    }
    enabled = value;
    if (enabled) {
      scan(document.body);
      observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    } else {
      observer.disconnect();
      roots.clear();
      for (const link of links) {
        link.replaceWith(document.createTextNode(link.textContent));
      }
      links.clear();
    }
  }

  document.addEventListener("click", (event) => {
    if (!enabled || !event.isTrusted || event.button !== 0 ||
        event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    const link = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
    if (!link || !/^tel:/i.test(link.getAttribute("href") || "")) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      if (pendingId !== undefined) {
        throw new Error("A dial request is pending. Check ADT before trying again.");
      }
      const number = Five9PhoneNumbers.normalize(link.getAttribute("href"));
      if (!port) {
        throw new Error("Five9 is disconnected.");
      }
      const id = ++nextId;
      port.postMessage({ type: "DIAL", id, number });
      pendingId = id;
    } catch (error) {
      report(error.message);
    }
  }, true);

  function connect() {
    if (stopped) {
      return;
    }
    try {
      const connection = chrome.runtime.connect({ name: "FIVE9_PHONE_PAGE" });
      port = connection;
      connection.onMessage.addListener((message) => {
        if (message?.type === "STATE") {
          setEnabled(message.enabled === true);
        } else if (message?.type === "RESULT" && message.id === pendingId) {
          pendingId = undefined;
          if (!message.ok) {
            report(message.error);
          }
        }
      });
      connection.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        if (error) {
          console.error("#### Five9 click-to-dial bridge disconnected:", error.message);
        }
        if (port === connection) {
          port = undefined;
          setEnabled(false);
          if (pendingId !== undefined) {
            pendingId = undefined;
            report("Five9 disconnected. Check ADT before retrying.");
          }
          if (!stopped) {
            setTimeout(connect, 1000);
          }
        }
      });
    } catch (error) {
      stopped = true;
      setEnabled(false);
      console.error("#### Five9 click-to-dial unavailable; reload this tab:", error.message);
    }
  }
  window.addEventListener("pagehide", () => {
    stopped = true;
    port?.disconnect();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      stopped = false;
      connect();
    }
  });
  connect();
})();
