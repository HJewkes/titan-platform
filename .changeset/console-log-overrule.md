---
"titan-console": minor
---

Add the Overrule tap on `#/log` (TP-6778). A live auto-by-rec round or deposit answer offers its other picks (`log.overrule-options`); `log.overrule`, owner-write and once per decision, appends an `overruled` row naming both picks, records the pick in the decision log as an owner-remote answer and tells the asker to reverse. An overruled row shows both picks. A live gate row whose PR is known gets the PR's revert link.
