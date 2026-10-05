---
"@titan-design/code-graph": minor
---

Add `gitTreeSource(repoRoot, rev)`, an `IndexSource` that indexes a commit's tree straight from git objects (`git ls-tree -r -z` plus one `git cat-file --batch`) without a checkout and without writing to the repo. Node ids are byte-identical to a working-tree index of the same commit: they are rooted at the realpath'd repo root, even when an indexed subdir no longer exists on disk. The snapshot's `commitHash` defaults to the source's commit, which the alias bridge also uses. `IndexSource` gains an optional `revision` field (`repoRoot`, `commit`, `commitEpoch`) that the working-tree source leaves unset. The git plumbing is exported from `@titan-design/code-graph/history` as `resolveCommit`, `listTreeBlobs` and `readBlobs`.

Fidelity caveat: files in the repo, including `tsconfig*.json`, `package.json` and `.gitattributes`, come from the commit, but cross-package imports resolve through today's on-disk `node_modules`, and untracked build output under an excluded dir (a gitignored `dist/`, say) is read from disk, as a checkout of the commit would see it. An import of a package whose installed version or build differs from the revision's resolves against the current install.

History metrics are off for a revision: an index from `gitTreeSource` records no churn, recency or ownership metrics until history can be read up to a revision (TP-1472), rather than reporting HEAD's history.
