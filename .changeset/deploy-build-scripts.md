---
"@titan-design/factory": patch
---

`service deploy` builds again under the pinned pnpm 9: only the install step keeps ignore-scripts, which made pnpm 9 run `build` without `node_modules/.bin` on its PATH. A failed git or pnpm step now records its exit code and redacted, capped tails of stderr and stdout, and a killed or timed-out step says so.
