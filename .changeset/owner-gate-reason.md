---
"@titan-design/factory": minor
---

A Shepherd registration with merge `owner-gate` must name `ownerGateReason` (`gate-2-visual`, `g10-security`, `proof-fixture` or `owner-asked`) or it is refused with exit 65. The reason is stored in the effective policy and shown in the approve-merge gate prompt. `proof-fixture` runs stay out of the digest's owner-round asks; `shepherd status` still lists them. Runs registered before the field replay unchanged.
