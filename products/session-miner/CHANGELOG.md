# @titan-design/session-miner

## 0.2.8

### Patch Changes

- Updated dependencies [0877916]
  - @titan-design/session-graph@0.7.0

## 0.2.7

### Patch Changes

- Updated dependencies [825b8b2]
- Updated dependencies [1035eb1]
- Updated dependencies [1e41479]
- Updated dependencies [79a855d]
- Updated dependencies [1a47098]
- Updated dependencies [38903dd]
- Updated dependencies [283d7e1]
- Updated dependencies [1035eb1]
- Updated dependencies [cb3b7e2]
- Updated dependencies [e3128f0]
- Updated dependencies [f2c70e0]
- Updated dependencies [a49eb2d]
  - @titan-design/store-sqlite@0.3.1
  - @titan-design/session-graph@0.6.0
  - @titan-design/session-read@0.5.0
  - @titan-design/registry@0.3.0
  - @titan-design/daemon@0.2.0

## 0.2.6

### Patch Changes

- Updated dependencies [e204012]
- Updated dependencies [3fea2d3]
- Updated dependencies [3e6a4af]
- Updated dependencies [18e3cf0]
- Updated dependencies [3fea2d3]
- Updated dependencies [e204012]
  - @titan-design/store-sqlite@0.3.0
  - @titan-design/embed@0.2.0
  - @titan-design/retrieval@0.3.0
  - @titan-design/daemon@0.1.4
  - @titan-design/session-graph@0.5.0
  - @titan-design/memory@0.1.2

## 0.2.5

### Patch Changes

- Updated dependencies [4ce40d1]
- Updated dependencies [1334f34]
  - @titan-design/registry@0.2.0
  - @titan-design/session-read@0.4.0
  - @titan-design/daemon@0.1.3
  - @titan-design/session-graph@0.4.1

## 0.2.4

### Patch Changes

- Updated dependencies [11b94a2]
- Updated dependencies [81b60ee]
- Updated dependencies [3bde552]
  - @titan-design/session-read@0.3.0
  - @titan-design/session-graph@0.4.0
  - @titan-design/store-sqlite@0.2.1
  - @titan-design/cluster@0.1.2
  - @titan-design/locator@0.2.1

## 0.2.3

### Patch Changes

- Updated dependencies [8153dd8]
- Updated dependencies [49360c2]
- Updated dependencies [8153dd8]
- Updated dependencies [0bdae32]
  - @titan-design/retrieval@0.2.0
  - @titan-design/cluster@0.1.1
  - @titan-design/store-sqlite@0.2.0
  - @titan-design/locator@0.2.0
  - @titan-design/session-graph@0.3.2
  - @titan-design/memory@0.1.1
  - @titan-design/session-read@0.2.1

## 0.2.2

### Patch Changes

- Updated dependencies [aac3473]
- Updated dependencies [87ae1ee]
  - @titan-design/session-graph@0.3.0
  - @titan-design/daemon@0.1.1

## 0.2.1

### Patch Changes

- Updated dependencies [fc7b58e]
  - @titan-design/session-read@0.2.0
  - @titan-design/session-graph@0.2.0

## 0.2.0

### Minor Changes

- 354538a: Wire `@titan-design/memory` in as a `playbook` command family (add, recall, reflect,
  status) on the existing registry, so it lands on the CLI, MCP, and HTTP at once. Provenance
  comes from the miner's own session refs and byte offsets, and `playbook reflect` builds a
  session diary deterministically from the subgraph with outcome labels derived from merged
  pull requests, task status, and clustered error signatures. The playbook stays strictly
  downstream of the index.

## 0.1.0

### Minor Changes

- 0ba860b: First product: `titan-miner` CLI, daemon, and MCP server composing registry, daemon,
  store-sqlite, locator, cluster, session-read, session-graph, and retrieval. Commands:
  refresh, status, search (FTS + graph expansion with read-back excerpts), session list/show,
  drain ingest/templates, serve, mcp.

### Patch Changes

- Updated dependencies [744fb7c]
- Updated dependencies [c9a2dd2]
- Updated dependencies [fbf473b]
- Updated dependencies [48eace6]
- Updated dependencies [6cea9aa]
- Updated dependencies [fdb3339]
- Updated dependencies [d33d861]
- Updated dependencies [aa5f694]
  - @titan-design/daemon@0.1.0
  - @titan-design/embed@0.1.0
  - @titan-design/locator@0.1.0
  - @titan-design/cluster@0.1.0
  - @titan-design/registry@0.1.0
  - @titan-design/retrieval@0.1.0
  - @titan-design/session-graph@0.1.0
  - @titan-design/session-read@0.1.0
  - @titan-design/store-sqlite@0.1.0
