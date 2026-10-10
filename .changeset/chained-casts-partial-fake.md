---
"@titan-design/eslint-plugin": minor
"@titan-design/test-kit": minor
---

`@titan-design/eslint-plugin` adds `no-chained-type-assertions`, which reports a type assertion
applied to another one (`x as unknown as T`), and enables it in `recommended`.
The new `@titan-design/test-kit` package exports `partialFake<T>()`, which builds a typed test fake
from only the fields a test reads, so test files need no double cast.
