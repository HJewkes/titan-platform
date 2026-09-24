---
"@titan-design/session-analytics": patch
---

`readEpisodeInput` ranks request copies only for the request ids its session holds, instead of reading `request_dedup`, which ranks every request in the graph. The rows are the same; one session's input on a 120k-request graph drops from about 240 ms to under 10 ms.
