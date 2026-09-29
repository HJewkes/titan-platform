---
"@titan-design/factory": patch
---

A malformed factory config file no longer kills commands that never need it. `factoryRoutes` is now a function that builds the routes on first call instead of at module import, so `titan-factory --help` and `service plist` succeed. `loadConfig` reports invalid JSON with the config path.
