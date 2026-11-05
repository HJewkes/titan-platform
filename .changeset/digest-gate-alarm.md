---
"@titan-design/factory": minor
---

The owner digest leads with a stale-gate line when the approve-merge median wait passes 24 h or any owner gate has waited over 72 h, listing those gates with console resolve links built from the new `digest.consoleOrigin` key (https only; loopback origins are refused). Without an alarm the digest is unchanged (TP-4545, TP-4368).
