---
"@titan-design/code-graph": patch
---

Sign an overloaded class member by its implementation (a declaration file with no implementation keeps its first overload), and sign a getter/setter pair as the property it exposes, `name: type`, from the getter's declared or inferred return type (a lone setter uses its parameter's type). Qualified member names now resolve through one name map per file, built once per extraction pass, instead of a whole-file walk per name. `INDEX_VERSION` moves to 0.19.0, so the first index after upgrading re-extracts every member signature.
