/**
 * Relation keys say two items are about the same thing without making them one item, so none of
 * them is a merge key. `ask:` is the same question across rounds; `component:`, `token:` and
 * `topic:` mark a shared component, design token or topic.
 */
export const RELATION_KEY_KINDS = ["ask", "component", "token", "topic"] as const;
export type RelationKeyKind = (typeof RELATION_KEY_KINDS)[number];

function relationKey(kind: RelationKeyKind, name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new Error(`${kind} key needs a name`);
  return `${kind}:${trimmed}`;
}

/** Component, token and topic names are matched by people's spelling, so case and spacing never split them. */
function normalName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

export function askKey(id: string): string {
  return relationKey("ask", id);
}

/** The default ask key of a round question, until question ids are stable per ask across rounds. */
export function roundAskKey(unit: string, questionId: string): string {
  return askKey(`${unit.trim()}/${questionId.trim()}`);
}

export function componentKey(name: string): string {
  return relationKey("component", normalName(name));
}

export function tokenKey(name: string): string {
  return relationKey("token", normalName(name));
}

export function topicKey(name: string): string {
  return relationKey("topic", normalName(name));
}

/** A PR key pinned to its head, in the canonical form `mergeByKeys` compares. */
export function prKey(repo: string, pr: number, headSha: string): string {
  return `pr:${repo.trim()}#${pr}@${headSha.trim()}`.toLowerCase();
}

/** The relation kind of a key, or null for a merge key or anything else. */
export function relationKind(key: string): RelationKeyKind | null {
  const parts = splitKey(key);
  if (parts === null) return null;
  const kind = RELATION_KEY_KINDS.find((each) => each === parts.prefix);
  return kind !== undefined && parts.rest.trim() !== "" ? kind : null;
}

function splitKey(key: string): { prefix: string; rest: string } | null {
  const colon = key.indexOf(":");
  return colon < 0 ? null : { prefix: key.slice(0, colon), rest: key.slice(colon + 1) };
}
