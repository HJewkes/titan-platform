---
"@titan-design/factory": minor
---

Add `titan-factory dispatch shadow-tick [--rule-file <path>]` (TP-5760, TP-5755 S2). It reads the dispatcher rule file (`titan-dispatcher/v1`, default `dispatcher.json` beside the factory `config.json`; `mode` admits only `shadow`). With the file absent or `shadow.enabled` not true it prints `dispatcher shadow disabled` and writes nothing. Enabled, it judges each configured lane with the same eligibility and back-pressure `dispatch eligible` uses and appends one wake row, would-dispatch rows up to the lane's free slots, and a refused row per refused or held task to `<shadow.dir>/<UTC date>.jsonl`. It dispatches nothing; a fence test proves no launch path is imported or called.
