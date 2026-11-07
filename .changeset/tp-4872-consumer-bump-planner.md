---
"@titan-design/factory": patch
---

Shepherd gains a consumer bump planner, not yet wired to a sweep or verb (TP-4872, slice a of TP-1005). `shepherd/consumer-bump.ts` reads a consumer's root and workspace manifests at a ref (workspaces from pnpm `importers` or npm `packages` keys), plus its lockfile, `pnpm-workspace.yaml` and `.npmrc`. It looks up npm `latest` for each `@titan-design/*` dependency and plans textual edits that raise `^x.y.z`, `~x.y.z` and exact `x.y.z` specifiers with the prefix kept and the rest of the file byte-identical. `workspace:`/`npm:` protocols, dist-tags, compound ranges, names npm answers 404 for and prerelease `latest` versions are left alone with a reason. `bumpBranch` names `shepherd/bump-consumers-<8 hex>` from the sorted `name@version` set.
