---
"titan-console": patch
---

Keep `readCommand` and `depositCommand` from wrapping an owner-write handler. Owner-write handlers carry an `ownerWrite: true` mark. The console refuses a marked handler served as a read or a deposit, both when the helper wraps it and when the registry is built. Passing a handler whose `run` needs the owner-write context directly, under its own type, is also a compile error. Widening it to a console-context `Command` or `AnyCommand` first, or casting it, still compiles because `run` is a bivariant method; the runtime mark is the backstop until the registry makes `run` a property.
