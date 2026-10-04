---
"@titan-design/factory": minor
---

Resync Shepherd at every `titan-factory serve` start, before the first adoption: end each live shepherd-pr run whose PR was merged (`landed elsewhere: `) or closed (`closed elsewhere: `) outside Shepherd, cancel pending gates of runs that already ended, and supersede moved-head gates once. A run that recorded its own `merge` or a post-merge step is never ended this way, which also stops the 5-minute sweep from cancelling a post-merge gate. Adds the `shepherd.resync` command and `titan-factory shepherd resync [--dry-run]`, and the `resyncOnStart` server option.
