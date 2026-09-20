# code-report

codewatch's layered code report: the big picture first, then prioritised findings, then a
drill-down into any directory, file, or symbol. It is the first consumer of
`@titan-design/react-app` (hooks, Vite preset), `@titan-design/rpc-client` (live and static
sources), and `@titan-design/code-read` (the read API). Visual primitives come from
`@titan-design/react-ui`. The app is private and publishes nothing. codewatch's CLI will
point at it after the batched npm publish.

One build runs three ways with the same code:

| Mode | How | Data |
| --- | --- | --- |
| Dev | `pnpm --filter code-report dev` | Vite on :5173 proxies `/rpc` to a report daemon on :7433 |
| Served | `pnpm --filter code-report build && pnpm --filter code-report serve` | The daemon serves the single-file build through `mountStaticApp` beside `/rpc` |
| From disk | `pnpm --filter code-report build && pnpm --filter code-report export` | `dist/report.html` carries a `titan-snapshot@1`; open it with no server running |

## First run

```sh
pnpm build                          # the workspace packages the scripts import
pnpm --filter code-report index     # index titan-platform into .codewatch/graph.db (about a minute)
pnpm --filter code-report dev
```

Findings are the check rules' violations, derived on read. By default those are
`.codewatch/check.json`, which CI keeps at zero, so Priorities is empty on a clean tree.
`rules/strict.json` has tighter demo thresholds. Point any script at it:

```sh
CODE_REPORT_RULES=apps/code-report/rules/strict.json pnpm --filter code-report dev
```

Other settings: `CODE_REPORT_PORT` (default 7433) and `CODE_REPORT_DB` (default
`<repo>/.codewatch/graph.db`). `pnpm --filter code-report call <command> '<json args>'`
answers one command in process and prints its size and time.

## Routes

Hash routes, because a page opened from disk has no server to answer a pushed path.

| Route | Calls |
| --- | --- |
| `#/` Overview | `findings.list` (counts only), `hierarchy.get` from the repo at depth 2 |
| `#/priorities` | `findings.list` unfiltered for facet counts, and filtered, sorted, paged by 25 for rows |
| `#/node/<id>` | `node.get`, `hierarchy.get` one level down, `findings.list` scoped to the node, `node.neighbors` for stored nodes |
| `#/finding/<id>` | `finding.get` with the excerpt, or the reason there is none |
| `#/compare` | none; a placeholder until identity across renames (TP-187) reaches code-read |

A search box on every page calls `node.resolve`. It accepts a name, a path, or `path:line`.
Every page pins the snapshot `api.describe` reports as newest, so the pages agree even if
the index moves underneath.

## The static export

`export` records the calls each page makes on first paint, plus `finding.get` for every
finding, as `titan-snapshot@1` calls. It also embeds a dataset: the newest snapshot's read
model flattened to JSON, and the text of every flagged file. Any call not recorded is
answered in the browser by code-read's own query functions over that dataset
(`createQueryResolver`), so paging, filters, scoped findings, other nodes, and search all
work offline. The script then answers every recorded call through the live registry too,
and fails if any answer differs. The only fields allowed to differ are the dataset kind,
the capabilities, the index versions, and the excerpt origin.

What the export cannot answer: text of files with no finding (`not-in-export`), and older
snapshots (only the newest travels).

`src/data/dataset.ts` (decode) and `server/dataset-export.ts` (encode) are a product-side
adapter. They are deleted once code-read ships a static dataset encoder and source of its
own.

## Seams

The plain tables, lists, and code block are placeholders for the titan-design components
TD-31 to TD-35, and each one says so where it is defined:

| Seam | Replaced by |
| --- | --- |
| `components/CodeExcerpt.tsx` | TD-31 code viewer with range highlighting |
| Directory and "Contains" tables | TD-32 hierarchy navigation |
| `components/DataTable.tsx` | TD-33 table filtering and virtualisation |
| (no growth timeline yet) | TD-34 line chart |
| Directory neighbours note | TD-35 dependency structure matrix |

## Fixtures

`fixtures/` holds two committed `titan-snapshot@1` files, built from real indexes by
`pnpm --filter code-report fixtures`. Neither carries a dataset, so each answers exactly the
calls it recorded and nothing else; that keeps them small enough to commit and to load in a
test. Pass `--with-dataset` for a self-answering export instead, which costs megabytes.

| Fixture | Holds | Bytes |
| --- | --- | --- |
| `titan-platform-history.snapshot.json` | This repository at 17 of its 59 tags, 2026-09-08 to 2026-09-19, in one store: a real growth timeline | 308,925 |
| `titan-design.snapshot.json` | `~/projects/titan-design` at its current main, one snapshot, 61 findings | 501,435 |

The script clones each repository into a scratch directory and checks the clone out at each
ref, so neither working tree is touched. `--full` indexes all 59 tags instead of every
fourth plus the newest three; `--reuse` skips indexing when the scratch store is already
there; `--only platform` or `--only design` builds one of the two.

Both fixtures use this repository's own `.codewatch/check.json`, which is why the
titan-platform one has no findings at all: CI keeps those rules at zero. Set
`CODE_REPORT_RULES=apps/code-report/rules/strict.json` to rebuild with the demo thresholds
instead. `TITAN_DESIGN_REPO` and `CODE_REPORT_SCRATCH` move the second repository and the
scratch directory.

There is no timeline command in code-read's contract, so a metric's history is recorded as
`snapshot.list` plus one `node.get` per node per snapshot. A node the snapshot predates
answers `EXIT.NOINPUT`, not a null value with a reason, so a consumer assembling a line has
to read that error as the gap it is. `scripts/fixtures.test.ts` asserts both, along with the
row, point, and call counts.

## Tests

`src/routes.test.tsx` renders the whole app at each route against a fixture snapshot
embedded in the page, the same path an exported report takes. It covers loading, empty,
not-found, unavailable, and recorded-before-dataset. `scripts/fixtures.test.ts` replays
every call in the two committed fixtures through the static source. Run both from the
repository root with `pnpm test`.
