---
"@titan-design/coordinator": minor
---

Add the `SeatState` schema, the seat event union (`seatEventSchema`) and `foldSeatEvents`, a pure fold from a seat's event log to its state: generation, agents, holds, claims, background commands and the authored block. Claims and holds are replaced by their latest event; a background command under `/tmp`, `/private/tmp`, the passed `tmpdir` or a `scratchpad` directory is refused into `errors`; unknown event kinds are counted, never thrown.
