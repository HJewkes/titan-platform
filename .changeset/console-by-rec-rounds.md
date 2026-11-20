---
"titan-console": minor
---

Answer rounds the owner left silent past the by-rec wait (24 h by default) with their recommendations (TP-6773). The wait runs from when the sweep first saw the round, not from a `round.json` mtime the asker can backdate. The daemon sweeps hourly through `rounds.submit`'s pipeline, which writes owner-queue's `auto-by-rec` mark into the feedback; the decision log and the owner queue read the answerer from that mark, so the decisions bullet and the queue credit the `automation` resolver. The decider's ledger (`answers.jsonl`) now records only owner answers, so a sweep answer is never read back as the owner's precedent. It skips after-answer rounds, Ship and plan-approval questions, and any question without a recommendation. An `auto-by-rec.json` marker, written once, stops repeats. It runs in shadow by default, writing only would-resolve rows to `auto-by-rec.jsonl`, until `auto-by-rec-policy.json` in the console state dir sets `mode: live`.
