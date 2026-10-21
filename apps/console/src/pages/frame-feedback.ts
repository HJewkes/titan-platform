import type { ConsoleCommands } from "../../server/commands.js";
import type { RoundNotes } from "../../server/rounds.js";
import type { Pin } from "./frame-pins.js";

/** A port of the review harness's per-frame verdict (titan-design review-harness `page/state.ts`) onto `rounds.submit`'s `variants`. */
export type PostedVariant = NonNullable<ConsoleCommands["rounds.submit"]["args"]["variants"]>[number];
export type Verdict = NonNullable<PostedVariant["verdict"]>;

/**
 * The harness's three verdicts, each set by a letter while a frame is active. The harness used 1/2/3, but digits answer
 * the active question here, so a frame takes letters that no question key uses.
 */
export const VERDICTS = [
  { verdict: "chosen", label: "Chosen", key: "c" },
  { verdict: "rejected", label: "Rejected", key: "x" },
  { verdict: "maybe", label: "Maybe", key: "m" },
] as const satisfies readonly { verdict: Verdict; label: string; key: string }[];

const CLEAR_KEY = "u";

/** The verdict a key sets on the active frame, null for the clear key, undefined for any other key. */
export function verdictForKey(key: string): Verdict | null | undefined {
  if (key === CLEAR_KEY) return null;
  return VERDICTS.find((each) => each.key === key)?.verdict;
}

/** A second press of the held verdict clears it, as the harness's did. */
export const toggledVerdict = (held: Verdict | null, pressed: Verdict): Verdict | null => (held === pressed ? null : pressed);

export interface FrameDraft {
  verdict: Verdict | null;
  comment: string;
  pins: readonly Pin[];
  /** The highest pin number this frame has handed out, removed pins included. */
  pinsIssued: number;
}

export const EMPTY_DRAFT: FrameDraft = { verdict: null, comment: "", pins: [], pinsIssued: 0 };

/** The frames that hold a verdict, a comment or a pin, in round order; a frame left out is echoed undecided by the server. */
export function frameDrafts(keys: readonly string[], drafts: Readonly<Record<string, FrameDraft>>): PostedVariant[] {
  return keys.flatMap((key): PostedVariant[] => {
    const { verdict, comment, pins } = drafts[key] ?? EMPTY_DRAFT;
    const text = comment.trim();
    if (verdict === null && text === "" && pins.length === 0) return [];
    return [{ key, ...(verdict === null ? {} : { verdict }), ...(text === "" ? {} : { comment: text }), ...(pins.length === 0 ? {} : { annotations: [...pins] }) }];
  });
}

/** A sent round's frame verdicts and comments as the page holds them, so a reload shows what was sent; its pins are drawn from `sent`. */
export function draftsFromSent(frames: RoundNotes["frames"]): Record<string, FrameDraft> {
  return Object.fromEntries(Object.entries(frames ?? {}).map(([key, { verdict, comment }]) => [key, { ...EMPTY_DRAFT, verdict, comment }]));
}
