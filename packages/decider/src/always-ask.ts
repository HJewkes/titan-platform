export interface AlwaysAskEntry {
  id: string;
  description: string;
}

/** Fixed, never learned and never demotable: no principle and no confidence can answer these. */
export const ALWAYS_ASK: readonly AlwaysAskEntry[] = Object.freeze([
  { id: "visual_taste", description: "Visual taste and design review rounds" },
  { id: "info_request", description: "Information only the owner knows" },
  { id: "external_action", description: "An action that needs the owner's own hand" },
  { id: "money", description: "Spending or committing money" },
  { id: "personal_data", description: "Anything touching personal data" },
  { id: "third_party_message", description: "A message sent to a third party" },
  { id: "irreversible", description: "An action that cannot be undone" },
  { id: "human_only", description: "Anything in a human-only initiative" },
].map((entry) => Object.freeze(entry)));

export const HARD_STOP_PREFIX = "hard_stop:";

/** The fixed list plus the charter's hard stops, which the caller passes in; the package never reads a charter. */
export function alwaysAskList(hardStops: readonly string[]): AlwaysAskEntry[] {
  const stops = [...new Set(hardStops.map((s) => s.trim()).filter((s) => s.length > 0))];
  return [...ALWAYS_ASK, ...stops.map((stop) => ({ id: `${HARD_STOP_PREFIX}${stop}`, description: stop }))];
}

/** Whether a question's category or hard-stop id is on the list. */
export function isAlwaysAsk(id: string, list: readonly AlwaysAskEntry[] = ALWAYS_ASK): boolean {
  return list.some((entry) => entry.id === id);
}
