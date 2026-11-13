# @titan-design/seat-spec

Owner-held seat definitions: the `titan-seat/v1` schema, `parseSeat`, fail-closed file checks
and the pure launch resolver.

Tier 0 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

## Use

```ts
import { loadSeat, resolveLaunch } from "@titan-design/seat-spec";

const loaded = loadSeat({ name, seat, index, prompt, context }); // reader output: lstat facts + bytes
if (!loaded.ok) throw new Error(`seat_definition_unloadable: ${loaded.refusal.code}`);
const resolved = resolveLaunch(loaded.seat, request);
if (resolved.ok) launch(resolved.launch); // resolved.overridden lists the requester fields ignored
```

Every function returns `{ ok: false, refusal: { code, detail } }` instead of throwing. A file
that could not be read is a refusal, never "no seat".

## Gotchas

- `ownerOnlyRead` is honoured only for the one seat named in the index's `ownerOnlyReaders`.
- `resolveLaunch` gives a root seat depth 0 and any other seat depth 1, whatever the requester's depth.
- The prompt `path` is a bare `.md` file name; the reader resolves it beside the seat file.
