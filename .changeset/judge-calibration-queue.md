---
"@titan-design/explainer": minor
---

`eval calibrate queue <manifest>` builds a blind queue of about 20 judge outputs (cold probe, cold-viewer rubric J8 to J12, L1 beats) from judged benches, mixed across judges, video types and verdicts, with holdout and owner-named cases left out. It writes the queue as an owner console round (`round.json`, one section a video) and keeps the judges' verdicts in a separate answer key. `eval calibrate agreement --key <key> --feedback <feedback.json>` scores each judge against the owner's labels and can record the result; a judge with no recorded agreement, fewer than 5 labels or agreement below 0.8 is refused promotion. `eval calibrate --labels` is now checked when the command runs rather than by the option parser, so the subcommands can run without it.
