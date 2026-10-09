TP-2112: the depth floor counted a Bash call only when the whole command started with a read verb, so reviewers working in a detached tree (`cd /tmp/review-x && grep ...`, `dir=... && git -C "$dir" diff`, `pnpm exec vitest run`) were judged to have read nothing and real MERGE / FIX_FIRST verdicts were set aside.

`isInvestigativeCall` now splits a command on `&&`, `||`, `;` and `|` (outside single or double quotes), drops leading `VAR=value` assignments and `git -C <dir>`, ignores `cd` segments, and counts the call when any segment starts with a read verb. Added verbs: grep, ls, head, tail, wc, find, git ls-files, git merge-tree, pnpm exec vitest, pnpm vitest, npm run verify, npm test, node --test. Sessions of only cd, mkdir, rm, echo, git fetch or git worktree add still do not count.

Tests replay the rejected shapes as investigative and the cd, echo, git fetch and rm -rf only shapes as not; 14 of them failed before the change.

This is merge policy (the floor guards against unread MERGEs): hold for an adversarial review.
