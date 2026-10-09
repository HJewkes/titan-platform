# @titan-design/coordinator

Tier 2 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

Exports `seatConfigSchema` (zod) and its inferred types for `autonomy-seat/v1` seat front
matter, `charterPolicySchema` and `parseCharterPolicy` for `autonomy-charter/v1` charter
front matter, and `foldSeatEvents`, a pure fold from a seat's event log (`seatEventSchema`) to
`SeatState`. Pure code: no fs, process, network or broker. See `site/reference/coordinator.md`.

The first npm publish is pending and owner-only; trusted publishing is set up after it.
