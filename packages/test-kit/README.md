# @titan-design/test-kit

Typed test doubles. `partialFake<T>(fields)` builds a `T` from only the fields a test uses,
so a test file needs no `as unknown as T` double cast, which the `titan/no-chained-type-assertions`
rule in `@titan-design/eslint-plugin` reports.

```ts
import { partialFake } from "@titan-design/test-kit";

const file = partialFake<ChangedFile>({ path: "docs/a.md" });
```

A field the test leaves out is `undefined` at run time even though `T` declares it. Fake every
field the code under test reads.

Tier 0 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI. Install it as a
dev dependency.

Status: unpublished. The first version is published by hand; see the repo `CLAUDE.md`.
