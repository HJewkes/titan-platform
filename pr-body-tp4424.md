## What

Slice a3 of the console perf epic (TP-4403), task TP-4424: client route and query timing, reported to a new `perf.report` command.

- `@titan-design/react-app`: `RpcProvider` and `createQueryStore` take an optional `onSettle({ command, ms, ok, fromCache })`, fired once per finished call (never for a superseded or aborted one). Minor changeset.
- Console: `src/data/perf.ts` times each route from the route change until every query the page started in its first 100 ms has finished, then records `{ kind: "route", view, detail, ms, queries }`. `view` is the `ViewKey`; the id and query never leave the browser.
- Rows batch every 10 s or when the tab hides, via `navigator.sendBeacon`, at most 100 rows a post; overflow is dropped and counted.
- `perf.report` is a deposit-class command: 16 KB body limit through `rpcBodyLimit.perCommand`, a strict schema that accepts only known view keys and registered command names, writes to the a1 recorder, default auth gate on the LAN, no owner-write flag. Registered through `daemon.ts` `extraCommands`, as a1 did, so `commands.ts` is untouched.

## Stacking

Stacked on #2682 (a1) and #2675 (b4). b4's commits show in this diff until #2675 merges. When a parent squash-merges, expect CONFLICTING; the fix is to merge origin/main.

## Tests

- `query-store-settle.test.ts`: "onSettle fires once per call with the elapsed time from the injected clock"
- `perf-route.test.tsx`: "a detail route reports its view key and never its id"
- `perf-report.test.ts`: "perf.report refuses an unknown view or command name"

Sidecars sit beside each. Local gates: build, typecheck, lint, dag:check, docs:build, `verify:changed`, and vitest over apps/console, packages/react-app, packages/daemon and scripts all pass.

Last slice: yes

🤖 Generated with [Claude Code](https://claude.com/claude-code)
