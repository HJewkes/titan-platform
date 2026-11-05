---
"titan-console": minor
---

Add the Knowledge Graph tab (TP-1064). `#/knowledge/<ref>?tab=graph` and `#/knowledge?tab=graph&ref=<ref>` draw a react-ui `NetworkGraph` ego, depth 2, from `graph.ego` around a task, note or session; pressing a node opens its record. A cap hit captions "Showing <n> of <m> neighbours.", a mention-only fallback warns that session links are unavailable, and an ego with no neighbours asks for a record.
