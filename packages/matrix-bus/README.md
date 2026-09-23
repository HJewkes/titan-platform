# @titan-design/matrix-bus

The Matrix mechanics behind the human queue: a client-server API client over global
`fetch`, the `io.titan.item` codec, the owner-only resolution fold, the `#queue` power
levels and bootstrap, and the per-machine appservice registration renderer.

Tier 1 of the titan-platform DAG. No dependencies. The root entry has no `node:` import,
so it loads in Node 20+, Workers and Deno alike.

Reference: [site/reference/matrix-bus.md](../../site/reference/matrix-bus.md).
