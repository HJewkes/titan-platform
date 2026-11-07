---
"@titan-design/factory": patch
---

The Version Packages and toolchain adoption sweeps start from `startPackageSweeps` in `shepherd/package-sweeps.ts`, which also owns the `releaseSweepMs` and `toolchainSweepMs` options. Serve spreads its result into the sweep list. No behaviour change.
