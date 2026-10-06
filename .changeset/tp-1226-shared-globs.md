---
"@titan-design/egress-scan": minor
"@titan-design/fix-proof": minor
---

`.egress-allow` globs now compile through fix-proof's shared glob compiler, so `docs/{a,b}.md` expands braces instead of matching nothing. The literal-segment guard checks every brace alternative. `AllowEntry.pattern` (a `RegExp`) is replaced by `AllowEntry.matches`. fix-proof exports `expandBraces`.
