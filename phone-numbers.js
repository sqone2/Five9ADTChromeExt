(() => {
  function isFive9Host(hostname) {
    return /(^|\.)five9\./i.test(hostname);
  }

  function normalize(value) {
    if (typeof value !== "string" || value.length > 100) {
      throw new Error("Invalid phone number.");
    }
    let text;
    try {
      text = decodeURIComponent(value.replace(/^tel:/i, "")).trim();
    } catch {
      throw new Error("Invalid telephone link encoding.");
    }
    if (!/^\+?[\d(). \t-]+$/.test(text)) {
      throw new Error("Use a phone number without extensions or telephone-link parameters.");
    }
    const number = text.replace(/[(). \t-]/g, "");
    if (!/^\+?\d{7,15}$/.test(number)) {
      throw new Error("Phone numbers must contain 7-15 digits.");
    }
    return number;
  }

  function find(text) {
    const pattern = /\+\d{8,15}|\+\d{1,3}[ .-](?:\d{1,4}[ .-]){1,3}\d{2,4}|(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-]?)\d{3}[ .-]?\d{4}/g;
    const matches = [];
    for (const match of text.matchAll(pattern)) {
      const end = match.index + match[0].length;
      if (/[a-z\d_+]/i.test(text[match.index - 1] || "") ||
          /[a-z\d_]/i.test(text[end] || "")) {
        continue;
      }
      try {
        matches.push({ index: match.index, text: match[0], number: normalize(match[0]) });
      } catch {
        // A text match is only a candidate, not a user dialing request.
      }
    }
    return matches;
  }

  globalThis.Five9PhoneNumbers = Object.freeze({ normalize, find, isFive9Host });
})();
