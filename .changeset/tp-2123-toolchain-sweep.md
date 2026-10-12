---
"@titan-design/factory": minor
---

Add a toolchain adoption sweep: `serve` runs it hourly (`toolchainSweepMs` overrides), and `titan-factory toolchain fanout [--dry-run]` runs it or previews it on demand. It reads every consumer repo's Node and pnpm toolchain against titan-platform's, opens one adoption PR per drifted repo through the contents API, and registers it with Shepherd with no fixer and an owner-gated merge, because these PRs edit other repos' release workflows. An existing PR on the toolchain branch is registered if Shepherd does not know it yet, and a closed one is never reopened.
