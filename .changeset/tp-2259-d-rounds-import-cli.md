---
"titan-console": patch
---

Add `titan-console rounds import <round-dir> [--json]`. It imports a review round into the rounds dir and prints the round id, the frame count, the feedback outcome (`copied`, `kept` or `none`), the loopback `/#/rounds/<id>` URL and, when `TITAN_CONSOLE_HOST` is set, the LAN URL. With `--json` it prints one JSON line instead: `{id, created, frames, feedback, url, lanUrl}`. A refusal prints its reason to stderr, prints no URL and exits non-zero. The verb is local only; no `/rpc` command imports a round.

The importer now also copies a CI packet's `packet.json` and `prose.json` beside `round.json` when `frames/frames.json` names them. Each file is opened with O_NOFOLLOW, must be a regular file of at most 1 MiB, must match its sha256 and must be valid JSON. The packet's repo, PR and head must equal every merge-bound Ship question in the round, or the whole import is refused. A frames@1 record may carry an `after` image, which is copied and sha-checked like `base` and `diff`.
