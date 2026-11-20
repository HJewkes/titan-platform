---
"@titan-design/owner-queue": minor
"titan-console": minor
---

A sitting deposit: a `do` deposit may carry `steps` (1 to 20, each a title, a command, an optional op and an optional verify hint), filed as one item that counts once against the 5-per-asker cap. The new `@titan-design/owner-queue/sitting` entry records a step done or skipped (`recordStep`, asker only, first outcome stands) and closes the sitting with a tally answer when every step has an outcome; `withStepOutcomes` reads them back. `titan-console inbox step <id> <n> --done|--skipped --as <asker> --actor <seat>` runs it, and the inbox page lists a sitting's steps in order with each status and a copy button per command; the row's tap is the current step's op, through the existing owner-op tap.
