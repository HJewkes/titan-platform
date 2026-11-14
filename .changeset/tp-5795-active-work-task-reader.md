---
"@titan-design/active-work": patch
---

Read initiative task files through `@titan-design/pm/node`'s `readInitiativeTasks`. The lint-only task loader is gone; lint, doctor, loops, wrap and the loop board share bootstrap's `loadTasks`. Tasks now come back sorted by file name, and an unreadable `tasks/` directory throws instead of reading as empty.
