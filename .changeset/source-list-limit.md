---
'@titan-design/active-work': minor
---

`active-work source list --limit N` returns the N newest sources by mtime (nulls last), capped after the `--type` filter, with `total` and `truncated` in the result. Without it the listing is unchanged.
