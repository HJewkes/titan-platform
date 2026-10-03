---
"@titan-design/decider": minor
---

Add `condense(store, rows, reflector)`: the condensation run. It feeds each domain's ledger rows since its watermark to an injected `Reflector`, validates the deltas with zod, records owner feedback (an overrule marks the decider's cited principles harmful; decider answers are never evidence), curates proposals as candidates, and can re-render the principle docs. Question text carrying an instruction can neither ground a principle nor confirm one.
