---
"@titan-design/explainer": patch
---

The script stage repairs out-of-enum values in a script or chapter reply. An optional field or an item of an optional list whose only fault is a bad enum value (such as a chip's `kind`) is dropped, with a stage note naming the path. Any other bad enum value goes to the schema retry, whose prompt names the path, the bad value and the values the schema allows. A required field is never dropped.
