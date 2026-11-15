# @titan-design/text-ingest

Tier 1 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

Deterministic transcript cleaning that keeps source spans. `cleanTranscript(source, options)`
returns the UTF-8 byte ranges of `source` to keep and the spans removed, each tagged
`sponsor-cut`, `filler`, `repeat` or `near-duplicate`.

```ts
import { cleanTranscript } from "@titan-design/text-ingest";

const { kept, removed } = cleanTranscript(source, {
  cutRanges: [{ start: 172, end: 266 }],
  nearDuplicateThreshold: 0.8,
});
```

- Fillers are `um`, `uh` and `you know`, with a trailing comma and spaces.
- A repeat is an immediately repeated word or phrase (up to four words); the second copy goes.
- A near-duplicate is a paragraph whose word-shingle Jaccard against an earlier paragraph is at
  or above `nearDuplicateThreshold`. Off when the option is unset.
- `cutRanges` are byte ranges the caller supplies, such as SponsorBlock segments it already
  mapped.
- Concatenating `source` slices at the kept ranges gives the cleaned text.
