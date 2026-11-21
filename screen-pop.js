(() => {
  const sdk = window.Five9?.CrmSdk;
  if (!sdk) {
    console.error("#### Five9 ADT screen pop: CRM SDK did not load.");
    return;
  }

  const handled = new Set();
  const interactionApi = sdk.interactionApi();
  interactionApi.subscribe({
    callStarted: async (params) => {
      try {
        console.info("#### Five9 ADT callStarted incoming params:",
          Five9Settings.serializeDiagnostics(params));
      } catch {
        console.error("#### Five9 ADT could not serialize callStarted incoming params.");
      }
      const call = params?.callData;
      const interactionId = call?.interactionId;
      if (typeof interactionId !== "string" || !interactionId) {
        console.error("#### Five9 ADT screen pop: callStarted has no interaction ID.");
        return;
      }
      if (handled.has(interactionId)) {
        return;
      }
      handled.add(interactionId);
      let stage = "checking the master ADT connection";
      console.info("#### Five9 ADT screen pop: processing callStarted.");
      try {
        if (!await interactionApi.isMasterPage()) {
          handled.delete(interactionId);
          console.info("#### Five9 ADT screen pop skipped: this ADT instance is not the master.");
          return;
        }
        stage = "loading and validating saved options";
        const settings = await Five9Settings.getSettings();
        const names = [...new Set([
          ...Five9Settings.getVariableNames(settings.screenPopUrl),
          ...Five9Settings.getVariableNames(settings.fallbackScreenPopUrl)
        ])];
        let variables;
        let contactFields;
        const values = Object.create(null);
        for (const name of names) {
          const contactPrefix = /^(Customer|Contact)\./.exec(name)?.[0];
          let source;
          if (contactPrefix) {
            if (contactFields === undefined) {
              stage = "reading contact fields through getCrm";
              contactFields = await interactionApi.getCrm({ interactionId });
              if (!Array.isArray(contactFields)) {
                throw new Error("Five9 returned an invalid contact-field list.");
              }
            }
            source = contactFields;
          } else {
            if (variables === undefined) {
              stage = "reading call variables through getCav";
              variables = await interactionApi.getCav({ interactionId, interactionSubType: call.interactionSubType });
              if (!Array.isArray(variables)) {
                throw new Error("Five9 returned an invalid call-variable list.");
              }
            }
            source = variables;
          }
          stage = contactPrefix ? "matching configured contact fields" : "matching configured call variables";
          const matches = source.filter((variable) => {
            if (typeof variable?.name !== "string") {
              return false;
            }
            if (contactPrefix) {
              return variable.name === name.slice(contactPrefix.length);
            }
            const qualified = variable.group && !variable.name.startsWith(`${variable.group}.`)
              ? `${variable.group}.${variable.name}` : variable.name;
            return qualified === name;
          });
          if (matches.length > 1) {
            throw new Error("Five9 returned ambiguous screen-pop variables.");
          }
          const value = matches[0]?.value;
          values[name] = typeof value === "string" ? value.trim() : value ?? null;
          for (const template of [settings.screenPopUrl, settings.fallbackScreenPopUrl]) {
            for (const nested of Five9Settings.getVariableNames(template, values)) {
              if (!names.includes(nested)) {
                names.push(nested);
              }
            }
          }
        }
        for (const [index, template] of [settings.screenPopUrl, settings.fallbackScreenPopUrl].entries()) {
          const value = /^\{[^{}]+\}$/.test(template)
            ? values[template.slice(1, -1)] ?? null : template;
          console.info(`#### Five9 ADT screen-pop priority ${index + 1}:`, template,
            Five9Settings.getDiagnosticTemplateValue(value));
        }
        stage = "validating the resolved screen-pop URL";
        const screenPopUrl = Five9Settings.buildScreenPopUrl(settings, values);
        if (!screenPopUrl) {
          console.info("#### Five9 ADT screen pop skipped: disabled or a required variable is null.");
          return;
        }
        console.info("#### Five9 ADT resolved screen-pop URL:", Five9Settings.getDiagnosticUrl(screenPopUrl));
        stage = "sending the screen-pop request to the extension";
        const result = await chrome.runtime.sendMessage({
          type: "FIVE9_CALL_STARTED",
          values
        });
        if (!result?.ok) {
          stage = "opening the screen-pop page in the extension service worker";
          throw new Error("Screen pop was not acknowledged.");
        }
      } catch {
        handled.delete(interactionId);
        console.error("#### Five9 ADT screen pop failed while", stage,
          "- close ADT and reload the extension if it was updated; check Options and service-worker errors.");
      } finally {
        if (handled.size > 256) {
          handled.delete(handled.values().next().value);
        }
      }
    }
  });
})();
