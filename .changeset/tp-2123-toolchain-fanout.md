---
"@titan-design/factory": patch
---

Add the toolchain fanout core. It reads titan-platform's canonical `.node-version`, `packageManager` and `engines.node`, plans one adoption edit per consumer repo, and prints dry-run lines. An `actions/setup-node` literal `node-version:` becomes `node-version-file: .node-version`; matrix values, expressions and reusable-workflow inputs are left alone and listed. Nothing calls it yet; the serve sweep and CLI follow.
