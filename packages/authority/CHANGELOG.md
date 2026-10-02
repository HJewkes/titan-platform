# @titan-design/authority

## 0.2.2

### Patch Changes

- e54f34e: `evaluate` reads the actor class only from an own property, so a polluted `Object.prototype.class` can no longer supply one.

## 0.2.1

### Patch Changes

- 6e848b7: `evaluate()` now denies a request whose actor is missing, null, not an object, or carries no known actor class, instead of throwing.

## 0.2.0

### Minor Changes

- be51d27: Add row MRG-AU-RV (owner decision D-A): an automation merge is allowed when the run-dispatched reviewer's MERGE verdict names the exact full-length head sha, every required context has a `success` run at that head from a caller-supplied allowed app, no run from those apps is non-green, the merge-tree is clean, the repo is not frozen, no path under `.github`, root or `docs/` `CODEOWNERS`, or `.gitmodules` changes (compared case-insensitively, with any non-canonical or non-ASCII path, or a segment ending in a space or a dot, treated as protected), and the seat grants `merge-on-green-approve`. Otherwise, or unless `tainted` is an own property set to exactly `false`, MRG-AU still gates. Rules gain an optional `when` list of `CONDITION_KINDS`, checked against the new `AuthorityRequest.facts`; conditional rows are allow-only and do not count toward totality. `evaluate` reads each request field once and checks a `structuredClone` of the facts rebuilt as plain data; facts holding a function, a `toJSON` method, a Proxy, a Map, a Set, a Date, a BigInt, a cycle, a sparse array or a throwing getter fail every condition, the rebuild reads own properties only, and a class instance is copied as its own data. An inherited truthy `tainted` still escalates a `taintEscalates` row, as before. A missing or malformed fact fails its condition instead of throwing: booleans must be exactly `true` or `false`, ids non-empty strings, lists arrays, and a check run missing any field fails `no-non-green-run`. Adds `unmetConditions`, the `MergeFacts` types and the evidence kind `E-rev`.

## 0.1.0

### Minor Changes

- 1b02a8b: Add `@titan-design/authority`: the owner-approved authority decision table as data (`DEFAULT_TABLE` and `table.json`), `policyTableSchema` with totality and owner-only resolver checks, and the pure `evaluate` and `canResolve`.
