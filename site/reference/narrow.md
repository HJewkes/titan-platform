# narrow

**Tier 0.** No titan dependencies, and no runtime dependencies at all, so any package may use it.

```sh
npm install @titan-design/narrow
```

## The problem it solves

Reading a field off an `unknown` needs a guard, so packages each wrote their own `isRecord` and
`errorCode`. The copies drifted: some refuse arrays, some accept them, and some return the code
as `unknown`. This package holds one named guard for each meaning.

## When to reach for it

When you have parsed JSON or a caught value and want one or two fields. For a whole shape, use a
zod schema.

## Example

```ts
import { errorCode, isRecord } from "@titan-design/narrow";

export function nameOf(parsed: unknown): string | undefined {
  return isRecord(parsed) && typeof parsed.name === "string" ? parsed.name : undefined;
}

export function isMissing(caught: unknown): boolean {
  return errorCode(caught) === "ENOENT";
}
```

## What it deliberately does not do

It validates no schema and does not coerce. It has no `errorMessage`: packages disagree on what
a non-`Error` thrown value should print.

## Gotchas

`isRecord` and `isObjectLike` differ only on arrays. Both narrow to `Record<string, unknown>`, so
the type does not show which one ran. Neither accepts a function. Both accept class instances
such as `Date`.

`errorCode` is not an `instanceof Error` test: it reads `code` from any object, and returns
`undefined` for a numeric `code`, such as an HTTP status.

## Where it came from

Extracted from the package-local copies under TP-4631.
