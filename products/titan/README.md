# @titan-design/titan

The titan host CLI. Private; never published. Bin: `titan`.

`titan health sample` takes one tick: it probes every target in parallel with `probeHttp`
from `@titan-design/health`, adds a `self` row with the sampler's own cost, and stores all
rows with one `appendSamples` call. It is meant to run as a oneshot once a minute; it starts
no daemon and makes no model or tool calls.

```sh
pnpm build
node products/titan/dist/bin.js health sample [--db <path>]
node products/titan/dist/bin.js health uptime factory --window 24h [--min 0.99] [--json]
node products/titan/dist/bin.js health cost --window 24h [--json]
node products/titan/dist/bin.js health import <stopgap.jsonl> [--target factory]
```

`uptime` and `cost` open the store read-only. `import` is idempotent: each row is keyed by
the file name and the raw line, so importing the same file twice adds nothing.

Reference: [titan](https://hjewkes.github.io/titan-platform/reference/titan).

| File | Holds |
|---|---|
| `src/cli.ts` | the commander program; `bin.ts` runs it |
| `src/health/cli-health.ts` | the `titan health` group and `sample` |
| `src/health/targets.ts` | the default `factory` target and the `host.json` overlay |
| `src/health/sample-tick.ts` | one tick: probes, self row, one append |
| `src/health/cli-uptime.ts` | `uptime`, plus the window options and read-only store shared with `cost` |
| `src/health/cli-cost.ts` | `cost`: the self rows folded per tick, and the store size |
| `src/health/import-stopgap.ts` | `import`: stopgap JSONL rows mapped to samples with a dedup key |
| `src/health/self-cost.ts` | the `self` row from `process.cpuUsage()` and `process.resourceUsage()` |
