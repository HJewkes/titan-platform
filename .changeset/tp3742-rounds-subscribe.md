---
"titan-console": minor
---

Add `titan-console rounds subscribe | unsubscribe | list-subscriptions`, so any seat hears over agent-chat when the owner answers a round, a unit glob, or the Ship rounds of an `owner/repo#N`, including rounds imported later. Subscriptions persist in the console state dir. The asker from `decisions file` is now the round's first subscriber, and `rounds import --seat <name>` records one too. Each seat gets one notice per answer (`notified-<seat>.json`; the start-up sweep retries a failed send), an answer with no asker or subscriber goes to tp-operator, and the notice says whether the answer carries free text. Notices still go through `agent-chat debug send` and carry human provenance, now behind one transport seam.
