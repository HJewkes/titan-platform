---
"@titan-design/tool-guard": patch
---

A wrapper's short option cluster that holds a digit (`xargs -0I {}`, `xargs -0n 1`, `env -0u X`) is now split option by option, so its value is skipped and the wrapped command is classified.
