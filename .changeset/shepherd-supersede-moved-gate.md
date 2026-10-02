---
"@titan-design/factory": patch
---

Shepherd supersedes an approve-merge gate whose pull request head moved. The serve sweep that ends merged-elsewhere runs now also cancels a shepherd-pr approve-merge gate when the open PR's head differs from the head the gate asks about. The run records the cancel, leaves the land round, and reviews the new head, so the owner is asked again only about a head that was reviewed. A conflict gate cancelled this way lands the next round the same way.
