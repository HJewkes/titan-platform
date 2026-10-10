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
