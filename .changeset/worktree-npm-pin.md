---
"@titan-design/worktree": patch
---

The setup step now runs npm with `ignore_scripts=true`, `git=git`, `node_options=--no-deprecation`, `script_shell=/bin/sh` and `shell=/bin/sh` pinned in its environment. A resumed tree's branch-controlled `package.json` and `.npmrc` can no longer run a program (lifecycle scripts, a custom git, node options or a script shell) during setup. Ports agent-chat's CC-324 fix.
