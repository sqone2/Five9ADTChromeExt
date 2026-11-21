# Five9 ADT

A Chrome Manifest V3 extension that opens Five9 Agent Desktop
Toolkit directly in an independent popup window.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this directory.
4. Pin **Five9 ADT**, then click its toolbar button.
5. Sign in to Five9 normally inside the ADT window.

Clicking again focuses the existing window, restoring it if minimized. Closing
the tab used to launch it does not close the ADT window. Closing ADT and clicking
the button again opens a new window.

The extension stores only the ADT window ID in Chrome session storage, so it
survives extension service-worker suspension but resets when the extension is
reloaded or Chrome restarts. Reloading the extension while ADT is open clears
its tracking; close that ADT window before launching again to avoid duplicates.

## Chrome Web Store package

Run from this directory:

```sh
mkdir -p dist
version=$(node -p "require('./manifest.json').version")
zip -X "dist/five9-adt-$version.zip" manifest.json \
  background.js click-to-dial-background.js five9.crm.sdk.js \
  settings.js screen-pop.js phone-numbers.js adt-dial.js click-to-dial.js \
  options.html options.css options.js \
  assets/toolbar16.png assets/toolbar32.png assets/icon128.png
```

Upload `dist/five9-adt-<version>.zip` to the Chrome Web Store Developer Dashboard.
The filename uses the version from `manifest.json` so releases can be tracked.
The ZIP contains only runtime files, with `manifest.json` at its root.
The `dist/` directory is ignored by Git.

## Options

Right-click the extension toolbar icon and choose **Options** (or open
**Details > Extension options** in `chrome://extensions`).
Hover over an **i** icon beside a setting, or focus it with the keyboard, to see
its help text. Press **Escape** to dismiss a tooltip.

- **Initial window size:** whole-pixel width (320-1600) and height (320-1200).
  Defaults are 420 x 760, including Chrome's window frame. Chrome may constrain
  the requested size to the available display. Only new windows use these values;
  focusing an existing ADT window does not resize it.
- **ADT URL:** leave blank for
  `https://app.five9.com/clients/integrations/adt.main.html`. Supports that path
  on `app.five9.com` and `app.five9.eu`, with custom query parameters. Close and
  reopen ADT after changing its URL.
- **Screen-pop URL - priority 1:** defaults to `{Screenpop.URL}`. A single variable
  can supply a complete HTTPS URL. Also accepts an HTTPS URL with `{Group.Name}` CAV placeholders,
  for example `https://mysite.com/accounts/{Subscriber.AccountNumber}` or
  `https://mysite.com/search?account={Subscriber.AccountNumber}&call={Call.Id}`.
  Placeholders can occur in the path, query, or fragment, but not the hostname.
  A static URL is also supported.
- **Screen-pop URL - priority 2:** defaults to `{Customer.screenpop_url}` and uses
  the same syntax. Tried only if priority 1 is blank or any of its referenced
  variables is missing, null, empty, or whitespace-only. Only one pop occurs.
  If neither candidate is populated, no pop occurs. Leave both fields blank to disable pops.
- **Variable sources:** `{Customer.field}` and `{Contact.field}` are aliases for
  the contact field named `field`, read through `interactionApi.getCrm()`.
  All other prefixes read CAVs through `interactionApi.getCav()`.
- **Reuse the previous screen-pop tab:** off by default. When enabled, the last
  screen-pop tab is navigated and focused if it is still open; otherwise a new
  tab is created. Its containing window is restored if minimized. The last tab ID
  survives service-worker restarts but clears when Chrome restarts or the extension
  reloads. Reuse replaces that tab's current page even if you navigated elsewhere.
  No additional site or `tabs` permission is needed.
- **Restore Defaults:** immediately saves the original settings.

Settings are saved locally in Chrome and survive restarts. Screen-pop changes
apply on the next `callStarted`, including in an already-open ADT window.
Existing saved templates are retained as priority 1; **Restore Defaults** applies
the new defaults to both priorities. The former null-variable checkbox is removed;
missing values always skip that candidate.
Do not put credentials, tokens, or SSO assertions in either URL. Only configure
destinations you trust: substituted CAV values are sent to that site in the URL.

## Scope and permissions

- Uses `storage` for local options and its session-scoped window ID.
- The packaged Five9 CRM SDK runs only on the US and Europe ADT pages.
  Click-to-dial content scripts run on HTTP/HTTPS websites and their HTTP/HTTPS
  frames, including screen-pop destinations. Chrome will request website access.
  Phone detection and telephone-link interception are excluded on `five9.*`
  domains and their subdomains, regardless of domain suffix. The ADT SDK bridge
  and screen pops remain active.
  Chrome internal pages, the Chrome Web Store, file URLs, and other restricted
  pages cannot be modified. No broad `tabs` permission is needed.
- No CRM callbacks or changes to the ADT URL flags.
- No credentials are collected. Call variables are read transiently to select
  the screen-pop record; only referenced values are sent to the configured site
  in the URL, not stored by the extension. The resolved destination URL is logged
  for troubleshooting, along with ordinary event values in the local console.
  Authentication fields remain redacted. Five9 handles authentication
  and telephony within its website.
- Does not replace any Five9-required softphone or connectivity extension.
- This is a custom launcher, not an official Five9 extension.

See the [privacy policy](PRIVACY.md) for data handling, local diagnostics,
third-party transfers, and user controls.

CRM and Hook API flags are omitted from the default URL: the Interaction API
provides both call events and click-to-dial.

## Click-to-dial

While the launched ADT reports login state `WORKING`, telephone (`tel:`) links
send their number to Five9 instead of the operating system's phone handler.
The extension also makes recognizable phone numbers in page text clickable,
including newly loaded content. It recognizes ten-digit North American numbers
(with optional country code 1) and common explicit `+` international formats.
Digit-only record IDs can resemble phone numbers; review the number in ADT.
Inputs, editable areas, code, and existing links/buttons are not rewritten.
Shadow-root content is not scanned.

Logging out or closing/disconnecting ADT removes extension-created phone links.
The SDK master connection is also checked every five seconds while logged in;
a failed or timed-out check disables links until it recovers.
Existing telephone links retain their normal behavior while Five9 dialing is
disabled. Only real, unmodified left clicks are intercepted. Numbers are
normalized to digits with an optional leading `+`; extensions and telephone URI
parameters are rejected with a visible error rather than silently discarded.
No phone numbers or page contents are stored or logged by click-to-dial.

Each request goes only to the extension's tracked ADT window and rechecks its
login state and `interactionApi.isMasterPage()` before calling the documented
`interactionApi.click2dial({ click2DialData: { clickToDialNumber } })`.
ADT is focused/restored. Five9 handles campaign selection and the dialing UI;
the extension does not force an automatic campaign or claim the call connected.
Login state is exchanged over live extension connections, not saved in storage.
Errors are shown on the originating page. Requests are never automatically retried.
If confirmation is lost, check ADT before clicking again.

After upgrading, reload the extension, close/relaunch ADT, and reload already-open
website tabs to install the new scripts. Login starts disabled until the SDK
reports `WORKING`; if unavailable after refreshing ADT, sign in again.

## Call-variable screen pop

When the launched ADT window's master instance emits `callStarted`, the extension
reads referenced call variables or contact fields through the appropriate SDK API and substitutes
them into the configured screen-pop templates in priority order. A group/name pair
or a qualified variable name is accepted. Values embedded in an HTTPS template are
trimmed and URL-encoded individually. A whole-URL variable is trimmed but not
URL-encoded, preserving its hostname, query, and fragment. The resulting destination
opens in a new tab or reuses the last screen-pop tab according to Options. The defaults are:

1. `{Screenpop.URL}`
2. `{Customer.screenpop_url}`

URL-valued variables can themselves contain placeholders, for example
`Screenpop.URL = https://mysite.com/{Salesforce.salesforce_id}`. Referenced
variables are read from that interaction's CAVs or contact fields and substituted before navigation.
Encoded placeholder braces (`%7B` and `%7D`) are also recognized. Missing nested
values skip that priority; circular URL-variable references and hostname
placeholders are reported as errors.

Skipped pops produce a `####` console message. There is no fixed-record fallback.
Populated but invalid URLs are errors, not a reason to try the next priority.
Invalid or ambiguous variable
data and SDK failures are reported as errors. String, finite numeric, and boolean
CAV values are supported. Variables are read once on `callStarted`, not watched
for later changes. Each API is fetched at most once per event when needed, including
for nested placeholders. Static templates fetch neither API.

This applies to all call directions. Repeated events for the same interaction
are suppressed within the current ADT document (up to 256 recent interactions).
Five9 also emits `callStarted` after refreshing ADT during an active call, so a
refresh can open the record again. Events from ADT windows not managed by this
launcher are ignored. Destination authentication and record access are handled by
that site; the extension does not inspect the destination page.

The official SDK is bundled unchanged from the supplied reference extension in
`five9.crm.sdk.js`, preserving its copyright header. Bundling keeps execution
local for Manifest V3, following the reference's isolated-world SDK integration.
No Navusoft integration code is included.

## Errors

A launcher failure displays a red `!` badge and an error tooltip. Click again to
retry. For details, open this extension's service-worker inspector or **Errors**
on `chrome://extensions`. Login and softphone errors are displayed by Five9.
Extension-owned console messages start with `####`; the bundled SDK is unchanged.
Every incoming `callStarted` logs a JSON snapshot before validation, master checks,
or duplicate suppression. Ordinary scalar values, object/array structure, and nulls
are retained. Serialization failures are reported without interrupting handling.
The result lists returned by `getCav` and `getCrm` are not logged.
Password, token, and other recognizable authentication fields remain
redacted, including authentication-valued CAVs and URL query parameters.
These local diagnostics may contain customer data; do not share them unredacted.
After reading and matching call variables, the ADT console logs one line per
screen-pop priority: the configured template followed by its whole-URL variable
value before nested substitution (including null or empty values). Static URL
templates show the template as their value. Nested placeholders remain readable;
credentials and known authentication parameters are omitted or redacted.
The ADT console also logs `resolved screen-pop URL` after successful validation,
and the service worker logs `opening screen-pop URL` before opening the destination.
Known authentication query parameters and sensitive fragments are redacted from
these diagnostic URLs; the URL used for navigation is unchanged. Destination
record identifiers may be visible in these logs, so do not share them unredacted.
Screen-pop errors identify the failed stage (master connection, saved options,
CAV lookup, variable matching, resolved URL validation, messaging, or service-worker
page opening). A `processing callStarted` message appears before the master check.
If that message is absent, close ADT, reload the extension, and reopen ADT before
testing another call. Reloading an extension does not replace its scripts in an
already-open ADT page.

## Validation

With Node.js installed:

```sh
npm test
npm run check
```

Tests exercise settings, template substitution, and SDK/Chrome integration with
mocked APIs. They do not verify
Five9 authentication or a live browser session. After installation, verify:

1. Launch ADT from an ordinary tab, then close that tab: ADT stays open.
2. Click the extension from another tab: the same ADT window is focused.
3. Minimize ADT, then click the extension: ADT is restored.
4. Close ADT, then click the extension: a new ADT window opens.
5. Sign in and verify your organization's station/softphone configuration.
6. Start or receive a call with `Screenpop.URL` populated with an HTTPS URL: that
   page opens once in a new tab. With it blank, populate `Customer.screenpop_url`
   and confirm the fallback opens. With both blank, no pop should occur.
   Closing the screen-pop tab must not close ADT.
7. Save a custom initial size and ADT URL in Options, close ADT, and reopen it.
8. Test a multi-variable template and both priorities. Reopen Options to
   verify settings persist; restore defaults when done.
9. Enable tab reuse and trigger two pops: the same tab should navigate and focus.
   Close that tab and trigger another pop: a new tab should open. Turn reuse off
   to verify that each pop opens a separate tab again.

## References

- [Chrome windows API](https://developer.chrome.com/docs/extensions/reference/api/windows)
- [Five9 ADT URL parameters](https://cdn.prod.us.five9.net/stable/crm-sdk-lib/doc/tutorial-adturlparams.html)
