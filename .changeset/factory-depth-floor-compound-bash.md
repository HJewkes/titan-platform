---
"@titan-design/factory": patch
---

Count compound Bash commands toward the review depth floor: `cd <dir> && grep ...`, `VAR=x && git -C <dir> diff`, and `pnpm exec vitest` now show a reviewer read the change, while sessions with only `cd`, `echo`, `git fetch` or `rm` still do not.
