---
"@titan-design/factory": minor
---

The reconciler now hands observe the ruleset read and a head and tip guard (TP-3431 part b). The gates carry the ruleset list when it changed, and the pass passes it to observe, so `RulesChanged` fires under polling. Before observe runs, `guardVerdicts` runs TP-3097's guard on each open PR's head and classifies the main tip against the cursor. Observe gets a sync `HeadTipGuard` over those verdicts, so it stays pure. A stale head appends no `HeadPushed` and logs `reconciler.disagree class=stale-read`. The guard's compare is a `core-read` pool claim (a new `ancestry` call); `ls-remote` comes from the new `BotPorts.lsRemote`. The start pass now reads the gates too, which saves the extra snapshot after each start. A pass keeps the gate ETags only once its snapshot lands, so a refused snapshot cannot hide a change. `Observe` takes the guard as a fifth argument and `createObserve` no longer takes one.
