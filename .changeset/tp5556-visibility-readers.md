---
"@titan-design/active-work": minor
"@titan-design/owner-queue": minor
---

Close the remaining initiative-visibility readers (TP-5556). `OwnerItem` gains an optional `ownerOnly` flag, separate from `personal`, for an item whose initiative `isAgentVisible` withholds. In active-work, `miner cost` and `miner outcomes` fold every owner-only initiative into one `owner-only` bucket for a non-owner caller, `doctor` leaves owner-only initiatives' findings out for a non-owner, `focus` and `unfocus` list no owner-only initiative among the moved ones for a non-owner (each warns with a count only), and `migrate` runs only for the owner.
