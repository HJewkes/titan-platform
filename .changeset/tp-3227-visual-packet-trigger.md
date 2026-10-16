---
"@titan-design/factory": minor
---

Shepherd can spawn a review packager when it opens a visual approve-merge gate (a `shepherd-merge-guard/visual-path` gate, or any land gate of a `gate-2-visual` registration), once per run and head, behind the new `shepherd.visualPacket` flag: `off` (default), `shadow` (records where it would spawn) or `on`. `shepherd.visualPacketProfile` names the profile, default `review-packager`. A refused spawn is recorded as `visual-packet-spawn-failed` and the gate opens as usual (TP-3227).
