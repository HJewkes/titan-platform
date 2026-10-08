---
"@titan-design/code-graph": minor
---

`layered-deps` gains an `exemptTypeOnly` option. When true, an import edge whose every import
from the source file is `import type` (or `export type … from`) no longer counts as a layer
violation. A file that also imports a value from the same module still counts. The option is
off by default and must be a boolean.
