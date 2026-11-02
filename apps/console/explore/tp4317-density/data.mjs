// Synthetic board for the density exploration: invented initiatives, seats, tasks and loops only.

const loop = (id, title, status, days, tier, rest = {}) => ({
  id,
  title,
  status,
  daysSinceMotion: days,
  tier,
  initiative: rest.initiative ?? "atlas",
  ownerSeat: rest.seat ?? null,
  emphasis: rest.emphasis ?? null,
  source: rest.source ?? "ledger",
  tasks: rest.tasks ?? [],
  prsOpen: rest.prs ?? [],
  doneWhen: rest.doneWhen ?? null,
  ownerGated: rest.gated ?? [],
});

export const LOOPS = [
  loop("l01", "Weekly digest reads as one page, not three", "LOST", 9, null, { initiative: "lumen", emphasis: { score: 7, days: 4 }, tasks: ["LU-212"] }),
  loop("l02", "Field notes import for the garden journal", "MISSING", null, null, { initiative: "studio", source: "session" }),
  loop("l03", "Atlas map tiles load offline", "ACTIVE", 1, "S", { seat: "atlas-coord", emphasis: { score: 9, days: 6 }, tasks: ["AT-118", "AT-121"], prs: ["acme/atlas#412"], doneWhen: "a cold start with no network shows the last synced tiles" }),
  loop("l04", "Harbor deploys roll back on a failed probe", "STALLED", 8, "S", { initiative: "harbor", seat: "harbor-ops", emphasis: { score: 8, days: 5 }, tasks: ["HB-77"], doneWhen: "a failed health probe restores the previous release within 2 minutes", gated: ["approve the staging credentials"] }),
  loop("l05", "Search ranks recent notes first", "ACTIVE", 2, "S", { initiative: "lumen", seat: "lumen-search", tasks: ["LU-198", "LU-204", "LU-207"], prs: ["acme/lumen#88"] }),
  loop("l06", "Billing export matches the ledger to the cent", "LOST", 12, "A", { initiative: "harbor", emphasis: { score: 6, days: 3 }, tasks: ["HB-64"], doneWhen: "the monthly export and the ledger agree on every row" }),
  loop("l07", "Onboarding tour under two minutes", "ACTIVE", 3, "A", { initiative: "studio", seat: "studio-ux", tasks: ["ST-31"], prs: ["acme/studio#203", "acme/studio#207"] }),
  loop("l08", "Relay retries survive a restart", "ACTIVE", 4, "A", { initiative: "relay-kit", seat: "relay-core", tasks: ["RK-15", "RK-16"] }),
  loop("l09", "Photo picker keeps album order", "STALLED", 7, "A", { initiative: "studio", seat: "studio-ux", tasks: ["ST-40"] }),
  loop("l10", "Atlas route planner avoids closed trails", "ACTIVE", 2, "B", { seat: "atlas-coord", tasks: ["AT-130"] }),
  loop("l11", "Theme switch without a reload", "ACTIVE", 5, "B", { initiative: "studio", tasks: ["ST-22"] }),
  loop("l12", "Harbor cost report by service", "STALLED", 10, "B", { initiative: "harbor", seat: "harbor-ops", tasks: ["HB-81"], emphasis: { score: 3, days: 2 } }),
  loop("l13", "Relay message schema v2", "MISSING", null, "B", { initiative: "relay-kit", source: "session" }),
  loop("l14", "Lumen tags merge duplicates", "ACTIVE", 6, "C", { initiative: "lumen", tasks: ["LU-150"] }),
  loop("l15", "Atlas elevation shading", "STALLED", 15, "C", { tasks: ["AT-90"] }),
  loop("l16", "Studio keyboard shortcuts sheet", "ACTIVE", 3, "C", { initiative: "studio" }),
  loop("l17", "Relay dashboard latency chart", "DONE", 2, "parked", { initiative: "relay-kit", seat: "relay-core", tasks: ["RK-9"] }),
  loop("l18", "Harbor log retention to 30 days", "DONE", 6, "parked", { initiative: "harbor", tasks: ["HB-50"] }),
];

export const TIER_ROWS = [
  { key: "unsorted", label: "Unsorted", hint: "owner to place" },
  { key: "S", label: "S", hint: "focus now" },
  { key: "A", label: "A", hint: "next" },
  { key: "B", label: "B", hint: "when free" },
  { key: "C", label: "C", hint: "background" },
  { key: "parked", label: "Parked", hint: "done or on hold" },
];

export const tierOf = (row) => LOOPS.filter((item) => (item.tier ?? "unsorted") === row.key);
export const isStale = (item) => item.status !== "DONE" && (item.daysSinceMotion ?? 0) >= 7;

export const GOALS = [
  { id: "g1", title: "Offline-first maps" },
  { id: "g2", title: "Safe deploys" },
  { id: "g3", title: "Findable notes" },
  { id: "g4", title: "Calm onboarding" },
];

const node = (id, title, goal, state, dependsOn, churn, rest = {}) => ({
  id,
  title,
  goal,
  state,
  dependsOn,
  doneWhen: rest.doneWhen ?? "the capability is used in a weekly review",
  churn: { closed14d: churn[0], openNow: churn[1], doneWhenMoved: churn[2], highChurnNoProgress: churn[3] ?? false },
  loops: rest.loops ?? [],
});

export const NODES = [
  node("n01", "Tile cache", "g1", "done", [], [4, 0, true]),
  node("n02", "Sync queue", "g1", "done", [], [3, 1, true]),
  node("n03", "Offline tiles", "g1", "in progress", ["n01", "n02"], [6, 3, true], { loops: ["l03"], doneWhen: "a cold start with no network shows the last synced tiles" }),
  node("n04", "Route planner", "g1", "in progress", ["n03"], [2, 2, false], { loops: ["l10"] }),
  node("n05", "Elevation layer", "g1", "not started", ["n03"], [0, 1, false], { loops: ["l15"] }),
  node("n06", "Health probes", "g2", "done", [], [5, 0, true]),
  node("n07", "Release history", "g2", "in progress", [], [9, 4, false, true], { loops: ["l04"] }),
  node("n08", "Auto rollback", "g2", "not started", ["n06", "n07"], [0, 2, false], { loops: ["l04"] }),
  node("n09", "Cost by service", "g2", "not started", ["n06"], [1, 1, false], { loops: ["l12"] }),
  node("n10", "Full-text index", "g3", "done", [], [3, 0, true]),
  node("n11", "Recency ranking", "g3", "in progress", ["n10"], [5, 3, true], { loops: ["l05"] }),
  node("n12", "Tag merge", "g3", "in progress", ["n10"], [8, 5, false, true], { loops: ["l14"] }),
  node("n13", "Weekly digest", "g3", "not started", ["n11", "n12"], [0, 1, false], { loops: ["l01"] }),
  node("n14", "Guided tour", "g4", "in progress", [], [4, 2, true], { loops: ["l07"] }),
  node("n15", "Theme switch", "g4", "done", [], [2, 0, true], { loops: ["l11"] }),
  node("n16", "Shortcut sheet", "g4", "not started", ["n14"], [0, 0, false], { loops: ["l16"] }),
];

const byId = new Map(NODES.map((item) => [item.id, item]));

/** A not-started node with an unfinished dependency reads as locked, as on the live page. */
export const stateOf = (item) =>
  item.state === "not started" && item.dependsOn.some((dep) => byId.get(dep)?.state !== "done") ? "locked" : item.state;

/** Column = dependency depth, the layered layout's x. */
export function depthOf(item) {
  return item.dependsOn.length === 0 ? 0 : 1 + Math.max(...item.dependsOn.map((dep) => depthOf(byId.get(dep))));
}

export const SELECTED = "n03";
export const loopById = (id) => LOOPS.find((item) => item.id === id);
export const goalOf = (id) => GOALS.find((goal) => goal.id === id);
