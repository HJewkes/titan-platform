TP-4871 (slice r2 of TP-1005): moves the package sweeps out of `products/factory/src/serve.ts`, which sat at the 350-line cap. Behaviour is identical.

Done-when:
- `shepherd/package-sweeps.ts` exports `PackageSweepOptions` and `startPackageSweeps(host, services, options, log): Sweep[]`.
- `FactoryServerOptions` extends `PackageSweepOptions`, and serve spreads the result into its sweep list.
- `serve.ts` is down to 344 non-blank lines.

Tests: new `shepherd/package-sweeps.test.ts` (fake timers) covers the configured intervals, the defaults when unset, and no sweeps without services. The existing serve tests pass unchanged. The six root checks are green.

Mutation caught: swapping `releaseSweepMs` and `toolchainSweepMs` fails "starts the Version Packages and toolchain sweeps at their configured intervals".

🤖 Generated with [Claude Code](https://claude.com/claude-code)
