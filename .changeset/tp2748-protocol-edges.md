---
"@titan-design/code-graph": minor
"@titan-design/graph-layout": minor
---

code-graph adds `extractProtocolEdges`, which reads HTTP routes, SSE streams and MCP tools from source text and links each to the files that call it, plus a `NO_PROTOCOL_SOURCE` diagnostic when a repo declares none. graph-layout's `emitRepoMap` takes those edges as `protocolEdges` and draws one labelled one-way `protocol` arrow per container pair, or labels the container import arrows "imports only" when there is no arrow to draw.
