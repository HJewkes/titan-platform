# @titan-design/coordinator

## 0.1.0

### Minor Changes

- 2789dfd: Add `charterPolicySchema` and `parseCharterPolicy` for `autonomy-charter/v1` front matter: seats, hub, the twelve hard-stop classes and scorer defaults. Pools and funds pass through untyped. The parse never throws; errors name the missing or invalid key path.
- 5faeb32: New tier-2 package with the zod seat config schema (`autonomy-seat/v1`) and its inferred types. Pure code: no fs, process, network or broker. Unknown seat keys pass through.
- 2b94628: Add the `SeatState` schema, the seat event union (`seatEventSchema`) and `foldSeatEvents`, a pure fold from a seat's event log to its state: generation, agents, holds, claims, background commands and the authored block. Claims and holds are replaced by their latest event; a background command under `/tmp`, `/private/tmp`, the passed `tmpdir` or a `scratchpad` directory is refused into `errors`; unknown event kinds are counted, never thrown.
- 5273f3b: Add `projectSeatGeneration`, a pure projection of a seat generation to one `SessionFacts` record per initiative it touched.
