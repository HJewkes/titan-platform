# structure-ts

A synthetic three-package TypeScript repo for the repo-explainer structure stage (RX2).
`packages/a/src/entry.ts` calls `Service.run` in `packages/b`, which reaches
`packages/c/src/store.ts` through a `this.helper()` method call.
