---
"titan-console": patch
---

Add the `reviews.get` read. It returns one repo review: its SUMMARY markdown capped at 256 KB with a `truncated` flag, the coverage line, the recommendations (or a gap line when the SUMMARY has no recommendations heading), every topic row and the claims rows. The name is looked up in the scanned set of review folders and never joined as given, so an unknown name or a `../` path gets a NOT FOUND refusal that does not echo it.
