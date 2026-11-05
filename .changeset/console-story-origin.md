---
"titan-console": minor
---

Serve review rounds' stored Storybook builds from a story origin of their own (TP-3793 S3). `TITAN_CONSOLE_STORY_PORT` (7501 by default, `0` off) opens a read-only origin on loopback and, in LAN mode, the LAN address behind the same certificate and session cookie. `GET /sb/<buildId>/<path>` serves a build from the store, injecting the story bridge into its `iframe.html`; a build that is not stored gets a fast-fail page whose bridge posts `error`. `GET /__bridge.js` serves the bridge, which posts `ready`, `error` and `height` to the console page only. Every story response carries a CSP that allows `iframe.html`'s inline scripts by hash and is framed only by the console's own origins. `rounds.get`'s `live.origin` now names the story origin for the listener that answered.
