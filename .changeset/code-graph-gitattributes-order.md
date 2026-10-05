---
"@titan-design/code-graph": patch
---

Match `.gitattributes` `linguist-generated` patterns the way git does: a leading `/` anchors to the repo root, a non-final `**` segment matches zero or more directories (`**/x.ts` matches a root `x.ts`, `a/**/b.ts` matches `a/b.ts`), and a later `-linguist-generated` line opts a path back out because the last matching line wins.
