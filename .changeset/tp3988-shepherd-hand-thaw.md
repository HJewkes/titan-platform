---
"@titan-design/factory": minor
---

`titan-factory shepherd thaw <owner/repo> --red-sha <sha> --reason <text>` thaws a main-red freeze by hand, so the freeze keeps a manual way out once the `main-red-again` and `main-frozen` owner gates go. It refuses a repo with no open main-red episode, a `--red-sha` that is not the episode's current red sha, and a blank reason. A thaw goes through `FreezeStore.release`, the path the gates' `unfreeze` answer uses, and records a `thaw` event naming the caller and `hand thaw: <reason>`. It cancels the episode's pending `main-red-again` and `main-frozen` gates through the thawed-main-gates sweep, leaves the fix task open, and alerts the repo's red seat by the main CI watch's red-event route. An alert that cannot be sent is logged as an error line and never fails the thaw.
