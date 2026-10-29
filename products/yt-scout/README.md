# @titan-design/yt-scout

A scheduled AI-video scout: poll a watch list of YouTube sources, transcribe and score new
videos, and file one daily owner item. So far it holds the watch list, the `videos` state
table, the one-off seen-set import and detect; transcribe, score and the timers come in later
slices, against the typed seams in `src/seams.ts`.

Tier product of the titan-platform DAG. Private; not published.

```sh
titan-yt-scout config check [--config <file>]
titan-yt-scout seen import [--config <file>] [--root <dir>] [--db <file>]
titan-yt-scout detect [--dry-run] [--config <file>] [--db <file>] [--rows-dir <dir>]
```

## Paths

| What | Default | Override |
|---|---|---|
| youtube sources tree | `<active-work root>/youtube/sources` | `YT_ROOT`, `--root` |
| watch list | `<sources>/scout/watchlist.yml` | `TITAN_YT_SCOUT_CONFIG`, `--config` |
| state database | `~/.local/state/titan-yt-scout/scout.sqlite3` | `TITAN_YT_SCOUT_DB`, `--db` |
| step rows | `rows/` beside the state database | `--rows-dir` |
| yt-dlp binary | `yt-dlp` on `PATH` | `yt_dlp` in the watch list, then `YT_DLP` |

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

## Detect

`detect` polls every source and lists the ids not yet in `videos`, with the state the length
filter gives each one. A channel tries its RSS feed first and falls back to a yt-dlp flat
listing of its tabs, writing a `fallback` row. A source whose listing fails yields nothing and
writes a `fail` row with `listing_error`; the other sources still run, and every row collected
reaches disk. `--dry-run` inserts nothing.

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
