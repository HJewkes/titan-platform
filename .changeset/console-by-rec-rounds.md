---
"titan-console": minor
---

Answer rounds the owner left silent past the by-rec wait (24 h by default) with their recommendations (TP-6773). The daemon sweeps hourly through `rounds.submit`'s pipeline, marks the feedback `auto-by-rec` and credits the decisions bullet to the `automation` resolver. The decider's ledger (`answers.jsonl`) now records only owner answers, so a sweep answer is never read back as the owner's precedent. It skips after-answer rounds, Ship and plan-approval questions, and any question without a recommendation. An `auto-by-rec.json` marker, written once, stops repeats. It runs in shadow by default, writing only would-resolve rows to `auto-by-rec.jsonl`, until `auto-by-rec-policy.json` in the console state dir sets `mode: live`.
