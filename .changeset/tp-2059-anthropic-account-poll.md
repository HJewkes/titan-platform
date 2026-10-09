---
"@titan-design/anthropic-account": minor
---

Add `pollUsage` and `pollAll` to the `./node` subpath. `pollUsage` reads a profile's access token through the 0600 credentials gate and sends one `GET https://api.anthropic.com/api/oauth/usage` through an injected `fetch`, with the token only in the Authorization header, `redirect: "error"`, a timeout and no retry. It never refreshes: a token within 60 s of expiry is reported `expired`. The body is capped at 64 KiB and parsed against a zod allowlist of window keys. Every failure is a message-free value: `missing`, `refused`, `expired`, `io`, `http-<status>`, `network` or `malformed`. `pollAll` polls every discovered profile and writes each reading with `writeReading`.
