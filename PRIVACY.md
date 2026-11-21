# Five9 ADT Privacy Policy

Last updated: November 21, 2026

This policy describes how the Five9 ADT Chrome extension handles information.
Its purpose is to connect your Five9 Agent Desktop Toolkit (ADT) session to your
browser-based calling workflow through a dedicated ADT window, click-to-dial,
and configurable call screen pops. This is a custom integration, not an official
Five9 extension.

## Information processed and why

- **Preferences:** The extension stores your chosen window dimensions, ADT URL,
  two screen-pop URL templates, and tab-reuse preference locally in Chrome.
- **Window and tab identifiers:** Chrome session storage holds the managed ADT
  window ID and previous screen-pop tab ID so the extension can focus or reuse
  them.
- **Website content and telephone-link clicks:** While the managed ADT session
  is logged in and connected, the extension processes webpage text locally to
  recognize phone numbers and responds to your clicks on telephone links.
  Click-to-dial does not store or log phone numbers or webpage contents.
- **Phone numbers:** A number you click is sent to your managed Five9 ADT session
  through the Five9 CRM SDK for dialing. Five9 handles its dialing interface and
  telephony service.
- **Call and contact information:** When a call starts, the extension reads the
  call variables or contact fields needed by your configured screen-pop
  templates. Depending on your configuration, these may include names, phone
  numbers, customer or record identifiers, and other customer information.
  Referenced values are processed transiently to construct the destination URL;
  they are not saved in the extension's settings.
- **Session state:** Five9 login and connection state is used to enable or
  disable click-to-dial. It is exchanged through live extension connections and
  is not saved in extension storage.

The extension does not build a browsing-history record, record call audio, or
implement advertising analytics or behavioral tracking. It does not collect
your Five9 login credentials through an extension-owned login form.
Authentication takes place directly through Five9.

## Data transfers and third-party services

The extension sends clicked phone numbers to Five9 to fulfill your dialing
request. For screen pops, configured call or contact values are included in the
URL opened at the destination selected by you or your organization.
That destination receives the URL and handles its own authentication and record
access. URLs may appear in the destination's logs and your browser history.

The extension does not upload webpage contents or diagnostics to a
developer-operated server. It does not sell user data, transfer it for advertising,
or use it to determine creditworthiness or for lending. Its data use and transfers
are limited to the calling and screen-pop functionality described here.
Five9, destination websites, Chrome, and GitHub operate under their own privacy
policies; this policy does not govern those services.

## Local diagnostics

The extension writes troubleshooting messages to local browser consoles,
including call-start event data, configured screen-pop templates, some
URL-variable values, and resolved destination URLs. These messages may contain
customer information or record identifiers.

Recognizable authentication fields and known sensitive URL parameters are
redacted or omitted from extension-owned diagnostics. This is not a guarantee
that all sensitive information is removed. Review and redact logs before sharing
them. The bundled Five9 SDK may also produce its own diagnostic messages.
The extension does not automatically send these logs to its developer.

## Storage, retention, and your controls

Preferences remain in local Chrome extension storage until replaced, reset, or
removed by uninstalling the extension. Session-stored window and tab identifiers
reset when Chrome restarts or the extension reloads. Transient call data, webpage
processing state, and connection state are held in memory while needed.
Local console logs are subject to browser developer-tools retention settings;
the extension does not maintain a separate persistent log database.

You can change preferences in **Extension options**, restore defaults, or leave
both screen-pop templates blank to disable screen pops. Logging out of or
closing the managed ADT session disables click-to-dial. You can also restrict
website access in Chrome's extension controls, disable the extension, or uninstall
it. Restricting website access can prevent click-to-dial from working.

Only configure screen-pop destinations you trust. Do not put passwords, tokens,
SSO assertions, or other secrets in saved URLs or screen-pop templates.
Removing the extension does not delete data already received by Five9 or
destination websites, browser history, or logs you have exported.

## Permissions

The `storage` permission supports local preferences and session identifiers.
Content-script website access supports the Five9 SDK integration on the supported
US and Europe ADT pages and phone-number detection on HTTP/HTTPS webpages and
frames. Webpage phone-number detection excludes Five9 domains and cannot run on
Chrome-restricted pages.

## Changes and questions

This policy may be updated when the extension's data handling changes. The
revision date above identifies the current policy.
For privacy questions, use the
[project repository](https://github.com/sqone2/Five9ADTChromeExt) to contact the
maintainer through its available support channels. Do not include customer data,
credentials, or unredacted diagnostic logs in public posts.
