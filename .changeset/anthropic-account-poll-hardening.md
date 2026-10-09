---
"@titan-design/anthropic-account": patch
---

Harden `pollUsage`: a known usage window in an unexpected shape now makes the whole reading `malformed` instead of being dropped, and `fetch` is optional, defaulting to `globalThis.fetch`. The docs say the supplied `fetch` receives the raw access token in the `authorization` header.
