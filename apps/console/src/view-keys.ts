/** The rail, in rail order. A plain module so the server can validate against the same list without loading the router. */
export const VIEW_KEYS = ["home", "inbox", "initiatives", "tasks", "sessions", "agents", "knowledge", "rounds", "reviews", "theater", "shepherd", "autoresearch", "config"] as const;
export type ViewKey = (typeof VIEW_KEYS)[number];
