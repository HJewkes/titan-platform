---
"@titan-design/titan": patch
---

`titan host services install` without `--dry-run` now installs the rendered backup units: it disables the legacy restic timer first, writes the units, reloads systemd and enables the titan backup timer, stopping at the first failing step.
