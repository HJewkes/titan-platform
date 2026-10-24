---
"titan-console": minor
---

The factory joins the console's `/events` relay as a third source, `factory`: the console dials `127.0.0.1:<factoryPort>/events` with the same backoff, dial timeout, silence limit and frame cap as the others, and passes the browser only each frame's name and run id. A factory frame refetches only `autoresearch.runs` and `autoresearch.run`, coalesced to one refetch per 300 ms window. The autoresearch run page no longer refetches a running run every 15 s.
