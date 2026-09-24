/**
 * The rendered context blocks a session was served, read back out of its first
 * user turn.
 *
 * Two renderers write them. active-work's bootstrap prints `see: <ref> "<title>"`
 * under each open loop; agent-chat's broker prints a "## Related to this
 * assignment" list of `- <ref> "<title>"` lines. Both may prefix a ref from
 * another initiative with ``[from `<slug>`]``.
 */

export type Trigger = "bootstrap" | "spawn";
export type RefClass = "note" | "source" | "task" | "session";

export interface ServedRef {
  trigger: Trigger;
  refClass: RefClass;
  /** The ref as rendered, e.g. `source:codewatch/handoff-archive.md`. */
  ref: string;
  /** The first path segment of a note, source or session ref; tasks carry none. */
  initiative?: string;
  /** What a later tool input must contain for the ref to count as opened: its filename or task id. */
  key: string;
  /** Rendered with a ``[from `slug`]`` prefix, i.e. served into another initiative's session. */
  foreign: boolean;
}

const BOOTSTRAP_MARKER = "    see: ";
const SPAWN_HEADING = "## Related to this assignment";
const FOREIGN = "(\\[from `[^`]+`\\] )?";
const CLASSES = "(note|source|task|session)";
const SEE_LINE = new RegExp(`see: ${FOREIGN}${CLASSES}:([^\\s"]+)`, "g");
const SPAWN_LINE = new RegExp(`^- ${FOREIGN}${CLASSES}:(\\S+)`, "gm");

export function hasBootstrapBlock(text: string): boolean {
  return text.includes(BOOTSTRAP_MARKER);
}

export function hasSpawnBlock(text: string): boolean {
  return text.includes(SPAWN_HEADING);
}

/** Every `see:` ref in a bootstrap turn, once each. */
export function parseBootstrapBlock(text: string): ServedRef[] {
  if (!hasBootstrapBlock(text)) return [];
  return uniqueRefs("bootstrap", text.matchAll(SEE_LINE));
}

/** Every ref line between the spawn heading and the next heading, once each. */
export function parseSpawnBlock(text: string): ServedRef[] {
  const at = text.indexOf(SPAWN_HEADING);
  if (at < 0) return [];
  const body = text.slice(at + SPAWN_HEADING.length);
  const end = body.indexOf("\n#");
  return uniqueRefs("spawn", (end < 0 ? body : body.slice(0, end)).matchAll(SPAWN_LINE));
}

function uniqueRefs(trigger: Trigger, matches: Iterable<RegExpMatchArray>): ServedRef[] {
  const byRef = new Map<string, ServedRef>();
  for (const [, foreign, refClass, rest] of matches) {
    const ref = `${refClass}:${rest}`;
    if (!byRef.has(ref)) byRef.set(ref, servedRef(trigger, refClass as RefClass, rest!, foreign !== undefined));
  }
  return [...byRef.values()];
}

function servedRef(trigger: Trigger, refClass: RefClass, rest: string, foreign: boolean): ServedRef {
  const segments = rest.split("/");
  const hasInitiative = refClass !== "task" && segments.length > 1;
  return {
    trigger,
    refClass,
    ref: `${refClass}:${rest}`,
    ...(hasInitiative ? { initiative: segments[0] } : {}),
    key: segments[segments.length - 1]!,
    foreign,
  };
}
