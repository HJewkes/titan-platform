export interface TwinRoute {
  /** The frame's file stem; stable, so a before/after pair of one route shares a name. */
  name: string;
  hash: string;
}

/** One list route per rail view and one detail route per view that has one, each naming a record the twin fixtures hold. */
export const TWIN_ROUTES: readonly TwinRoute[] = [
  { name: "home", hash: "#/" },
  { name: "inbox", hash: "#/inbox" },
  { name: "initiatives", hash: "#/initiatives" },
  { name: "initiative-detail", hash: "#/initiatives/orbit-relay" },
  { name: "tasks", hash: "#/tasks" },
  { name: "task-detail", hash: "#/tasks/OR-12" },
  { name: "sessions", hash: "#/sessions" },
  { name: "session-detail", hash: "#/sessions/relay-retry" },
  { name: "agents", hash: "#/agents" },
  { name: "agent-messages", hash: "#/agents?tab=messages" },
  { name: "agent-detail", hash: "#/agents/relay-builder" },
  { name: "agent-detail-messages", hash: "#/agents/relay-builder?tab=messages" },
  { name: "knowledge", hash: "#/knowledge" },
  { name: "knowledge-record", hash: `#/knowledge/${encodeURIComponent("note:orbit-relay/2031-03-03-backoff-ceiling.md")}` },
  { name: "rounds", hash: "#/rounds" },
  { name: "round-detail", hash: "#/rounds/ship-tile-r1" },
  { name: "reviews", hash: "#/reviews" },
  { name: "review-detail", hash: "#/reviews/widget-kit" },
  { name: "theater", hash: "#/theater" },
  { name: "theater-player", hash: "#/theater/v-relay-intro" },
  { name: "shepherd", hash: "#/shepherd" },
  { name: "shepherd-detail", hash: `#/shepherd/${encodeURIComponent("orbit/relay#12")}` },
];

export const TWIN_VIEWPORTS = {
  phone: { width: 375, height: 812 },
  desktop: { width: 1440, height: 900 },
} as const;
