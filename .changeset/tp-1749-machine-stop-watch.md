---
"@titan-design/factory": patch
---

Add the Shepherd machine-stop watch: `stopReason` names a load5, memory pressure or free memory breach at the spawn gate's limits, `machineStopWatch` keeps an in-memory ledger of stops seen so a review round can ask whether one applied while it ran, and `awaitLift` polls until the stop clears or the hold ceiling passes. Nothing calls it yet; a later change counts a no-verdict review under a stop as throttled rather than failed.
