(() => {
  const sdk = window.Five9?.CrmSdk;
  if (!sdk) {
    console.error("#### Five9 click-to-dial: CRM SDK did not load.");
    return;
  }
  const interactionApi = sdk.interactionApi();
  let working = false;
  let connected = false;
  let generation = 0;
  let healthTimer;
  let port;
  let stopped = false;

  function publish() {
    port?.postMessage({ type: "STATE", enabled: working && connected });
  }

  async function checkConnection() {
    const version = generation;
    let timeout;
    try {
      const master = await Promise.race([
        interactionApi.isMasterPage(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Five9 connection check timed out.")), 5000);
        })
      ]);
      if (version === generation && !stopped) {
        connected = master === true;
        publish();
      }
    } catch {
      if (version === generation && !stopped) {
        connected = false;
        publish();
        console.error("#### Five9 click-to-dial connection check failed. Check ADT's connection.");
      }
    } finally {
      clearTimeout(timeout);
      if (version === generation && working && !stopped) {
        healthTimer = setTimeout(checkConnection, 5000);
      }
    }
  }

  sdk.applicationApi().subscribe({
    loginStateChanged: (params) => {
      generation++;
      clearTimeout(healthTimer);
      working = params?.state === "WORKING";
      connected = false;
      console.info("#### Five9 click-to-dial:", working ? "logged in" : "disabled");
      publish();
      if (working) {
        return checkConnection();
      }
    },
    error: (event) => {
      if (event?.source === "websocket" || event?.source === "sdk") {
        working = false;
        connected = false;
        generation++;
        clearTimeout(healthTimer);
        publish();
        console.error("#### Five9 click-to-dial disabled after a Five9 connection error.");
      }
    }
  });

  function connect() {
    if (stopped) {
      return;
    }
    try {
      const connection = chrome.runtime.connect({ name: "FIVE9_ADT_DIAL" });
      port = connection;
      connection.onMessage.addListener(async (message) => {
        if (message?.type !== "DIAL") {
          return;
        }
        try {
          const number = Five9PhoneNumbers.normalize(message.number);
          if (!working || !connected || !await interactionApi.isMasterPage() ||
              !working || !connected || port !== connection) {
            throw new Error("Five9 is not logged in or its master connection is unavailable.");
          }
          interactionApi.click2dial({ click2DialData: { clickToDialNumber: number } });
          connection.postMessage({ type: "RESULT", id: message.id, ok: true });
          console.info("#### Five9 click-to-dial request sent to ADT.");
        } catch {
          console.error("#### Five9 click-to-dial failed. Check ADT's login, connection, and dialing UI.");
          connection.postMessage({ type: "RESULT", id: message.id, ok: false });
        }
      });
      connection.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        if (error) {
          console.error("#### Five9 click-to-dial bridge disconnected:", error.message);
        }
        if (port === connection) {
          port = undefined;
          if (!stopped) {
            setTimeout(connect, 1000);
          }
        }
      });
      publish();
    } catch (error) {
      stopped = true;
      console.error("#### Five9 click-to-dial bridge unavailable; reload ADT:", error.message);
    }
  }
  window.addEventListener("pagehide", () => {
    stopped = true;
    working = false;
    connected = false;
    generation++;
    clearTimeout(healthTimer);
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
