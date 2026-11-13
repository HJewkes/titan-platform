Part of TP-5592 (slice A3). Stacked on #3680.

## What

- A round whose run recorded no own-diff step takes its id from the factory git-cache at refresh time. The read is read-only: no fetch, no `git init`, no config write. A head the cache lacks stays without an id, is never guessed, and is counted in the refresh line and `--json` (`ownDiffsComputed`, `ownDiffsMissing`). A recorded id always wins over a read one.
- Older heads read against `origin/main` in the cache, since a run records no base branch; a stacked PR's older heads therefore read against main.
- Daily refresh: `ops/systemd/titan-review-stats.{service,timer}` runs `titan-factory shepherd stats --reviews --json` at 05:00 with the same env file as the owner-gates unit, plus a README section.
- `review-stats-backfill.ts` added to the G10 hold closure, as A1 did.

## Tests

- `a round without an own-diff step takes its id from the git-cache` (real git)
- `a head missing from the cache stays without an id and is counted`

## Owner install (not done here)

```sh
cp ops/systemd/titan-review-stats.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now titan-review-stats.timer
```

The env file `~/.config/titan-factory/owner-gates.env` must set `ACTIVE_ROOT` and `TITAN_FACTORY_DB`.

## Read-only run against a scratch copy of the ledger (symlinked, store written to scratch)

Own-diff ids read from the cache: 1602. Heads missing from the cache: 5832. Unchanged passes: 210 (after MERGE 202, after FIX_FIRST 8), within the plan's 142 to 236 band.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
