---
"@titan-design/eslint-plugin": minor
---

Add `no-internal-module-mock`, enabled in `recommended`. Tests may mock only external dependencies. A `vi.mock` or `jest.mock` of a relative, absolute or `#` specifier, or of a package under `internalPrefixes` (default `@titan-design/`), is reported. `node:` builtins and third-party packages stay mockable.
