---
"@titan-design/factory": patch
---

The consumer bump plan now edits a dependency by its JSON path, so a same-literal entry in an override field is never rewritten, and reads override pins with pnpm's selector parser, npm's nested `overrides` and `pnpm-workspace.yaml` `overrides`. A dependency an override pins is left alone, and a pin already at npm latest is no longer listed.
