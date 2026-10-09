---
"titan-console": patch
---

Harden `inbox.deposit`. Its request body is capped at 128 KB before the daemon buffers it, and a larger one gets 413. Once the spool holds 2000 open deposits across all askers, the next deposit gets 429, so invented asker names no longer get around the 200-per-asker cap. An asker or depositId holding a lone surrogate gets 400, and `Bob` and `bob` file as two deposits.
