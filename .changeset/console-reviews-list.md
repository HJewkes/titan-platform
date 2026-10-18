---
"titan-console": patch
---

Add `reviews.list`, the read side of the Reviews tab. It scans one level of `TITAN_CONSOLE_REVIEWS_DIR` (default: the repo-review folder under the active-work root). Each subfolder with a `README.md` is a review. The command reads fixed paths in each one, no-follow and capped at 1 MB, parses them with `@titan-design/pm`'s review-folder parsers and caches them by mtime and size. Each review comes back with its pin, its label (`current-label`, else `flat`), P1 and P2 counts, claims, coverage, headless cost, and a state that a rule table in `server/review-rules.ts` derives from the files. The README's status line is never used for the state. A label that is not a plain name, a symlinked file or dir, and a file that fails to parse each show up as a gap line instead.
