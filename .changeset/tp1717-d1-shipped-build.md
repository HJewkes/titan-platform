---
"titan-console": minor
---

Add `titan-console shipped build [--date] [--group] [--dry-run] [--force] [--json]`. It groups the day's PRs merged through Shepherd by initiative into batches of at most 40, reads each PR's title and body serially (bodies cut to 1 KB, reads stop at a GitHub 403), asks one sonnet `claude-print` call per batch for themes (at most 12 calls a build, $0.50 each) and writes `<stateDir>/shipped/<date>.json` for `coord.shipped`. PR numbers the model invents are dropped and PRs it omits are listed unsummarized. An unchanged PR set is a no-op without `--force`, and a logged-out claude exits 2 without writing.
