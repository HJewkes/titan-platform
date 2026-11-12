---
"@titan-design/factory": patch
---

`factory deploy` now matches the service file's bin as a whole path, so a service started from `/x/<checkout>/products/factory/dist/bin.js` no longer counts as running from `<checkout>`.
