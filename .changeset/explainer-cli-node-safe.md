---
"@titan-design/explainer": patch
---

The `explainer` CLI starts under plain node again. Its script-time still checks read their motion timing from react-ui's import-free tokens and a no-import timing module, so the CLI entry no longer loads react-ui's motion entry, which resolved to raw react-native and crashed at start. Timings and stage versions are unchanged.
