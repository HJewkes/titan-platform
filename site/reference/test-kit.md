# test-kit

**Tier 0.** No titan dependencies.

```sh
npm install --save-dev @titan-design/test-kit
```

Status: unpublished. The first version is published by hand.

## The problem it solves

A test often needs a value of a wide interface when the code under test reads two of its
fields. Writing every field is noise, so tests reached for `{ path } as unknown as ChangedFile`.
That double cast also hides real type errors, such as a misspelled field, and
`titan/no-chained-type-assertions` now reports it. `partialFake<T>()` keeps the one reviewed
cast inside the helper and type-checks the fields a test does write.

## When to reach for it

- A test needs a `T` and fakes only some of its fields.
- A test probes how code handles a missing field: leave that field out.

For a fake with behaviour, such as an in-memory GitHub, use the owning package's fake
(`fakeGitHub()` in `github`).

## Public API

| Export | What it does |
|---|---|
| `partialFake<T>(fields?)` | returns `fields` typed as `T`; `fields` is `Partial<T>`, so a field `T` does not declare fails the typecheck |
| `linearWork(prepare, { from, to, meter, steady? })` | counts the work `meter` reports (a running total, such as fix-proof's `linearRegExpSteps`) for one run at each size against `GROWTH` (4) runs at a quarter of it, climbing from `from` to `to`, and returns the worst ratio; it stops at the first rung past `LINEAR_WORK_LIMIT` (2), so a polynomial walk fails on a small input instead of hanging on a large one. A run the meter counts nothing for gives `Infinity`. Rungs below `steady` are only checked for being counted. Assert `ratio` below the limit |
| `countCalls(methods, run, cap?)` | the calls a synchronous `run` makes to `methods`, such as `[Array.prototype, "push"]` or `[Array.prototype, Symbol.iterator]`; every call past `cap` throws, so a quadratic walk stops there and the count comes back above `cap` |
| `callMeter(methods, cap?)` | the same count as a running total with `restore()`, for `linearWork`'s `meter` |
| `hostileGlobs(separator?)` | the hostile rows of tp#2491 as `[name, row]` pairs for `it.each`: `d/` and twenty `*`, and twelve `**/`, each with a path of a given size it does not match and the `steady` size from which a linear matcher's work per character stops growing |

The `@titan-design/test-kit/git` subpath holds real-git fixtures. It imports `vitest` for its `afterAll` cleanup.

| Export | What it does |
|---|---|
| `seedRepo(dir, files?)` | copies a repository on `main` with one seed commit of `files` (default `README.md`) into `dir`; `{}` leaves `main` unborn. The template is built once per test file, with auto-maintenance and gc off, `core.fsync=none` and an empty hooks directory |
| `seedRepoWithOrigin(dir, origin, files?)` | the same, plus a bare `origin` already holding `main`, set as the copy's `origin` remote |
| `withHistory(dir, commits)` | writes `{ files, message?, branch?, from?, date?, author? }` commits with one `git fast-import`, checks out the last commit's branch and returns the shas; dates are pinned unless a commit gives its own, so shas repeat across runs, and a `null` file deletes the path |
| `fixtureEnv()` | `process.env` without injected `GIT_CONFIG_*` entries or system and global config, with a fixed author and committer |
| `gitIn(cwd)` | `(...args) => string`: `git -C cwd` under `fixtureEnv`, trimmed stdout |
| `removeTemplates()`, `templateDirectory()` | the per-file template cleanup `afterAll` runs, for a test of that cleanup |

No test asserts milliseconds: counts are the same on every machine and under any load, where a timing ratio read 415 on a loaded hosted runner (TP-4262). The `titan/no-test-clock-budget` lint rule refuses a new clock comparison in a test outside a bench gate.

A glob compiler's growth test, from review-panel:

```ts
it.each(hostileGlobs())("grows linearly with the path for %s", (_name, { glob, path, steady }) => {
  const { ratio } = linearWork((size) => {
    const input = path(size);
    return () => matchesGlob(input, glob);
  }, { from: 1, to: 1024, steady, meter: linearRegExpSteps });
  expect(ratio).toBeLessThan(LINEAR_WORK_LIMIT);
});
```

## Example

```ts
import { partialFake } from "@titan-design/test-kit";

interface Client {
  name: string;
  send(body: string): Promise<number>;
}

const client = partialFake<Client>({ send: async (body) => body.length });
await client.send("four"); // 4
```

## What it deliberately does not do

- It does not throw when the code under test reads a field the test left out. Tests that probe
  missing input rely on reading `undefined`.
- It does not deep-fake nested objects. Nest a second `partialFake` call for a nested field.

## Gotchas

- `T` claims every field exists. A field left out reads as `undefined`, so a test that forgets a
  field the code needs fails with a `TypeError` far from the fake.

## Where it came from

New, for the anti-slop cast rules: it replaces `as unknown as T` fakes in test files.
