---
"@titan-design/agent-dispatch": minor
---

`@titan-design/agent-dispatch/profiles` now holds agent-chat's profile schema and parser: `parseProfile`, the closed value lists with their type guards, and `harnessRefusal`. The parser is split by field family, and its checks, messages, `denies` alias and derived denies match agent-chat's. Unknown keys warn. A `codex` profile that names a Claude model is refused at load, and any `codex` profile is refused at launch with `harness_unsupported`.
