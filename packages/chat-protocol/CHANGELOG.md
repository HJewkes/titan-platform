# @titan-design/chat-protocol

## 0.3.0

### Minor Changes

- 73ffaaa: Rename the two `agents` schemas that carried a `Schema` suffix to the package's suffix-free convention: `activityCategorySchema` is now `agentActivityCategory` and `nodeActivitySchema` is now `agentGraphNodeActivity`. The bare names stay with the `activityCategory` and `nodeActivity` functions. The `ActivityCategory` and `NodeActivity` types are unchanged.

## 0.2.0

### Minor Changes

- 9172151: Add the `./agents` subpath: zod schemas and types for the agent roster and agent graph, `foldRoster` and `foldAgentGraph` over the agent-chat broker's `/api/sessions` and `/api/history`, and the spawn-tree layout and spark helpers moved from agent-chat's dashboard.

## 0.1.0

### Minor Changes

- 26ef3d7: Add the chat-protocol package: one canonical message document for every agent-chat
  surface. The document is the Vercel AI SDK `UIMessage` / `parts[]` model with zero
  new part types, vendored as a byte-compatible subset so a tier-0 package keeps no
  runtime dependency beyond `zod`. On top of it sits a thin envelope — thread,
  participant, per-recipient delivery state, broker-set provenance — plus pure
  adapters to and from `@titan-design/messaging` and `@titan-design/hitl`, and a
  delivery-status cap that clamps a claim to what a transport can actually observe.
