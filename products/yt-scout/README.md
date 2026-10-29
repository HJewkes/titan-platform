# @titan-design/yt-scout

A scheduled AI-video scout: poll a watch list of YouTube sources, transcribe and score new
videos, and file one daily owner item. This first slice holds the watch list, the `videos`
state table and the one-off seen-set import; detect, transcribe, score and the timers come in
later slices, against the typed seams in `src/seams.ts`.

Tier product of the titan-platform DAG. Private; not published.

```sh
titan-yt-scout config check [--config <file>]
titan-yt-scout seen import [--config <file>] [--root <dir>] [--db <file>]
```

## Paths

| What | Default | Override |
|---|---|---|
| youtube sources tree | `<active-work root>/youtube/sources` | `YT_ROOT`, `--root` |
| watch list | `<sources>/scout/watchlist.yml` | `TITAN_YT_SCOUT_CONFIG`, `--config` |
| state database | `~/.local/state/titan-yt-scout/scout.sqlite3` | `TITAN_YT_SCOUT_DB`, `--db` |

The watch list is owner data, so it lives in the initiative tree, not in this repo.

## Watch list

```yaml
version: 1
defaults: { poll: 1h, tabs: [videos], min_seconds: 180, max_seconds: 18000 }
sources:
  - key: someChannel          # unique; history channel names map onto it
    name: Some Channel
    channel_id: UC…           # a channel source, polled per tab
    handle: someChannel
    tabs: [videos, streams]   # optional, else defaults.tabs
    poll: 3h                  # optional, else defaults.poll
    trial_until: 2026-11-27   # optional: a trial source, reviewed once this day passes
  - key: someSpeaker
    name: Some Speaker (search)
    search: '"Some Speaker"'  # a search source instead of channel_id
    match: 'some speaker'     # case-insensitive regex a hit's title or channel must match
scoring: { threshold_total: 10, also_if_any_axis: 5, daily_top: 3 }
budget: { daily_usd: 2.00, backfill_usd: 25.00 }
models: { score: <model id>, digest: <model id> }
```

Every object is strict: an unknown key is an error. `config check` prints `ok: N sources, M on
trial` or one `file:line: path: message` line per problem and exits 1.

## Seen-set import

`seen import` loads the history that predates the scout so the first tick does not redo it.
Each id gets the furthest state any source gives it (`seen` < `transcribed` < `mined` <
`scored`); the import never moves a video backwards, so a rerun reports `inserted 0`.

| Source, under the sources tree | State |
|---|---|
| `ai-channels-2026-10/inventory.jsonl` | `seen` |
| `ai-channels-2026-10/scores/all-scores.json` and `batch-*.jsonl` | `scored`, with the card |
| `watch-later/selected.jsonl` | `mined` when `watch-later/facts/<id>.md` exists, else `seen` |
| `id:` in the front matter of `out/**/*.md` (not `*.digest.md`) | `transcribed` |

A missing source is reported as `missing`, not an error. Channels that match a watch-list key,
handle or name are stored as that key; others keep their own name.

Tests use synthetic ids and text written to a temp directory. Do not commit real transcript text.

## Eval loop

Cases live under `$YT_ROOT/scout/evals/cases/score-<id>.json`, outside the repo: each holds the
transcript's path and sha256, never its text.

- `titan-yt-scout flag <id> --transcript <file> --verdict over|under|miss|wrong-ts|bad-why [--gold-total <n>] [--note ...]`
  records the owner's verdict. `over`, `under` and `miss` need `--gold-total`, the total the card should have had.
- `score` files automatic cases (`schema_invalid`, `refusal`, `ts_invalid`).
- `titan-yt-scout eval audit --model <opus> --rubric <file>` re-scores 5 cards from the last week
  and files an `audit-disagree` case on a gap of 3 or more in total, or a flip across the threshold.
- `titan-yt-scout eval replay --model <m> --rubric <file> [--max-cases n] [--max-cost usd]` re-runs every case and prints
  threshold-side agreement, mean absolute difference in total against gold (the recorded card when there is no gold),
  ts validity and cost. A case whose transcript changed since it was filed is counted `stale`, not replayed.
