export interface TwinRoute {
  /** The frame's file stem; stable, so a before/after pair of one route shares a name. */
  name: string;
  hash: string;
}

/** One list route per rail view and one detail route per view that has one, each naming a record the twin fixtures hold. */
export const TWIN_ROUTES: readonly TwinRoute[] = [
  { name: "home", hash: "#/" },
  { name: "inbox", hash: "#/inbox" },
  { name: "inbox-focused", hash: "#/inbox/gate-12" },
  { name: "initiatives", hash: "#/initiatives" },
  { name: "initiative-detail", hash: "#/initiatives/orbit-relay" },
  { name: "tasks", hash: "#/tasks" },
  { name: "tasks-initiative", hash: "#/tasks?initiative=orbit-relay" },
  { name: "task-detail", hash: "#/tasks/OR-12" },
  { name: "sessions", hash: "#/sessions" },
  { name: "session-detail", hash: "#/sessions/relay-retry" },
  { name: "agents", hash: "#/agents" },
  { name: "agent-messages", hash: "#/agents?tab=messages" },
  { name: "agent-detail", hash: "#/agents/relay-builder" },
  { name: "agent-detail-messages", hash: "#/agents/relay-builder?tab=messages" },
  { name: "coordinator", hash: "#/coordinator" },
  { name: "knowledge", hash: "#/knowledge" },
  { name: "knowledge-search", hash: "#/knowledge?tab=search&q=backoff" },
  { name: "knowledge-record", hash: `#/knowledge/${encodeURIComponent("note:orbit-relay/2031-03-03-backoff-ceiling.md")}` },
  { name: "rounds", hash: "#/rounds" },
  { name: "round-detail", hash: "#/rounds/ship-tile-r1" },
  { name: "round-questions", hash: "#/rounds/kiln-schedule-r2" },
  { name: "round-design", hash: "#/rounds/lantern-cards-r1" },
  { name: "reviews", hash: "#/reviews" },
  { name: "review-detail", hash: "#/reviews/widget-kit" },
  { name: "theater", hash: "#/theater" },
  { name: "theater-search", hash: "#/theater?q=relay" },
  { name: "theater-empty", hash: "#/theater?q=zzz&tag=plan" },
  { name: "theater-player", hash: "#/theater/v-relay-intro" },
  { name: "theater-beat-editor", hash: "#/theater/v-relay-intro?t=2&edit=1" },
  { name: "shepherd", hash: "#/shepherd" },
  { name: "shepherd-detail", hash: `#/shepherd/${encodeURIComponent("orbit/relay#12")}` },
  { name: "autoresearch", hash: "#/autoresearch" },
  { name: "autoresearch-run", hash: "#/autoresearch/ar-7c1e" },
  { name: "autoresearch-idea", hash: "#/autoresearch/ar-7c1e?idea=i-77aa2b4c6d8e" },
  { name: "autoresearch-idea-decided", hash: "#/autoresearch/ar-7c1e?idea=i-5b3c7e9a1d0f" },
  { name: "autoresearch-idea-reeval", hash: "#/autoresearch/ar-7c1e?idea=i-0d4e8f2a6b1c" },
  { name: "autoresearch-run-pre-s3a", hash: "#/autoresearch/ar-2b90" },
  { name: "config", hash: "#/config" },
];

export const TWIN_VIEWPORTS = {
  phone: { width: 375, height: 812 },
  desktop: { width: 1440, height: 900 },
} as const;
