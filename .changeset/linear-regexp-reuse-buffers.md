---
"@titan-design/fix-proof": patch
---

`LinearRegExp` allocates its NFA buffers once per compiled source instead of once per `test`, so a glob tested hundreds of thousands of times no longer spends most of its time allocating typed arrays.
