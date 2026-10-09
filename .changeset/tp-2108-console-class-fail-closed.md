---
"titan-console": patch
---

Make console command classes fail closed. Every command now declares its class where it is defined, the console refuses to start if any command has no class, and a classed command cannot be re-classed (for example, an owner-write wrapped as a read).
