---
"titan-console": patch
---

Keep `readCommand` and `depositCommand` from wrapping an owner-write handler. A handler whose `run` needs the owner-write context is now a compile error for either helper. Owner-write handlers carry an `ownerWrite: true` mark, and the console refuses a marked handler served as a read or a deposit, both when the helper wraps it and when the registry is built.
