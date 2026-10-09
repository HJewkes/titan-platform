# @titan-design/titan

The titan host CLI. Private; never published. Bin: `titan`.

`titan health sample` takes one tick: it probes every target in parallel with `probeHttp`
from `@titan-design/health`, adds a `self` row with the sampler's own cost, and stores all
rows with one `appendSamples` call. It is meant to run as a oneshot once a minute; it starts
no daemon and makes no model or tool calls.

```sh
pnpm build
node products/titan/dist/bin.js health sample [--db <path>]
```

Reference: [titan](https://hjewkes.github.io/titan-platform/reference/titan).

| File | Holds |
|---|---|
| `src/cli.ts` | the commander program; `bin.ts` runs it |
| `src/health/cli-health.ts` | the `titan health` group and `sample` |
| `src/health/targets.ts` | the default `factory` target and the `host.json` overlay |
| `src/health/sample-tick.ts` | one tick: probes, self row, one append |
| `src/health/self-cost.ts` | the `self` row from `process.cpuUsage()` and `process.resourceUsage()` |
