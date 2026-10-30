---
"@titan-design/egress-scan": minor
---

`/hooks` gains `posixShell`, `hardenedShebang`, `ENVIRONMENT_SCRUB` and `hookShell` (the `HookShell` the hooks writer takes), and `ownToolDirs`, `withOwnTools` and `defaultScanInputs`, so a hooks writer whose PATH lacks the scanner still bakes its own scanner and node.
