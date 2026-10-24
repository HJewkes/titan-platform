---
"@titan-design/factory": patch
---

A seat digest rerouted from a seat with no live session no longer replays that seat's whole backlog. It lists finished runs only since the seat's last digest, never more than 24 h back. Older rows are settled, so a later sweep neither sends nor reads them. A digest to a live seat is unchanged. Seat memory now records when each seat was last sent a digest.
