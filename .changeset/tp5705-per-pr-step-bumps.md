---
"@titan-design/factory": patch
---

A fact step's version bump can be recorded per PR in `src/registry/bumps/<pr>.json` (`{ step, pr }` rows), and the registry adds one per distinct PR to the step's declared `version.bump`. Two concurrent PRs bumping the same step each write their own file, so landing one no longer makes the other re-bump. `pnpm registry:closure` fails a bump row naming another PR, a row naming no fact step, and a removed base row.
