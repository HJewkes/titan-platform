---
"@titan-design/pm": minor
"@titan-design/active-work": patch
---

Add a `./node` subpath to pm holding the planning-record file store (read, validated atomic write, the `<initiative>/plan/.lock`), so every plan writer shares one layout and one lock; the root entry stays pure. active-work's plan store is now a thin adapter over it, with no change in behaviour.
