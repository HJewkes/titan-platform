---
"@titan-design/agent-dispatch": minor
"@titan-design/factory": patch
---

`@titan-design/agent-dispatch/limits/node` exports `LimitsBlockMissingError`, a `LimitsConfigError` that `loadLimits` throws when a host config has no block under the requested key. The factory's host limits read branches on it instead of matching the message text.
