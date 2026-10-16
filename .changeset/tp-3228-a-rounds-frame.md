---
"titan-console": patch
---

Add the `rounds.frame` read command: one PNG a review round lists, by frame key and view (head, base or diff), as base64 with its sha256. The key must be an image variant in `round.json` or a record in `frames/frames.json`; no path comes from the client. The read refuses a path outside the round, a symlink at any component, a non-regular file, a non-PNG, a file over 8 MiB and a sha256 that does not match the frames index.
