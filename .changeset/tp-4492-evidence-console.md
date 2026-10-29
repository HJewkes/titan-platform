---
"@titan-design/factory": minor
"titan-console": minor
---

The console's confirm sheet for an owner-at-head merge gate shows the factory's evidence card (TP-4492). `inbox.prepare` reads `gate.ownerEvidence` for a merge tap. A `missing` card, or one read at another head, offers no tap and names the terminal command. A ready card goes into the read-back and so into the confirm digest, and the record posts its `evidenceDigest`. The sheet heads each CI-policy section with the evidence's own reading (kind and keys). It lists every labelled line and the verdict text, and shows each changed file's rows. Every string renders verbatim, wrapped, never clamped or cut. In the factory, a card's CI-policy section now carries `verdictLines` and labelled lines through `exactLine`, in place of the raw `verdictText`, so a hidden or bidi character shows as its code point.
