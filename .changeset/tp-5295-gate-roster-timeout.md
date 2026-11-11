---
"@titan-design/factory": patch
---

Shepherd: a spawn-gate roster read that times out before launch is now a not-launched, busy refusal (`ReviewerGateRosterUnread`) that the review step asks again after a minute, instead of a `ReviewerAskTimedOut` that waited 5 minutes for a reviewer that was never started (TP-5295). A timeout of the spawn itself is still `ReviewerAskTimedOut`.
