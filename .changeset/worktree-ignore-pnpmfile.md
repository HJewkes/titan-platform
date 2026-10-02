---
"@titan-design/worktree": patch
---

Pin `ignore-pnpmfile` in the worktree setup environment, so pnpm does not load a branch's `.pnpmfile.cjs` during setup when the branch's `.npmrc` or `package.json` asks it to. A branch `pnpm-workspace.yaml` outranks this pin; the setup step's refusal of a changed `pnpm-workspace.yaml` covers that case.
