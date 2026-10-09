---
"titan-console": patch
---

Close the widening and optional-presence gaps in the owner-write guard. With the registry's `run` now a property, a handler whose `run` needs the owner-write context no longer compiles once widened to a console-context `Command`, `AnyCommand`, a factory's return type or an array. `readCommand` and `depositCommand` also refuse, at compile time, a handler whose context has any key the console context lacks, so one that declares `ownerPresence` optional is no longer served as a read or a deposit. A cast still compiles; the `ownerWrite` mark stays the runtime backstop, and only `ownerWriteCommand` ever hands a handler the presence proof.
