---
"titan-console": patch
---

`self-update` now smokes a new release with that release's own check, through a new internal `self-update --smoke <release> <sha>` verb, so a fix to the smoke check deploys on the pass that builds it (TP-3938). A release without the verb falls back to the updater's own check. A smoke failure now ends with the last 20 lines of the smoke daemon's or verb's stderr, in the record and the owner-queue alarm, and a daemon that exits stops the wait at once (TP-3935).
