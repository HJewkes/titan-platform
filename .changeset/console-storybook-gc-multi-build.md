---
"titan-console": minor
---

`titan-console storybooks gc [--dry-run] [--json]` sweeps the Storybook store. It keeps builds that open rounds, or rounds closed in the last 14 days, name. It removes builds that only older closed rounds name. Over 3 GiB, it removes the oldest builds no round names first. It prints each build kept or removed and why, removes nothing when a round's sidecar cannot be read, and never follows a symlink. A multi-PR round can now carry one build per PR group, as a `titan-review/storybook-set@1` sidecar with each build under `storybook/builds/<sha>/`. Each group's variants show only the build at that group's head. Single-build rounds import as before.
