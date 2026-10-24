import type { L0Result } from "./eval-l0.js";
import type { GatheredFact } from "./lint-claims.js";
import type { ScriptBeat, ScriptV1 } from "./script-schema.js";
import type { SpineV1 } from "./spine-schema.js";

/** What a failing L0 row found, in words a script repair can act on; undefined when the row alone says enough. */
export type Hint = (script: ScriptV1, row: L0Result, facts?: readonly GatheredFact[], spine?: SpineV1) => string | undefined;

export const percent = (share: number): string => `${Math.round(share * 100)} %`;
export const listed = (ids: readonly string[]): string => (ids.length ? ids.join(", ") : "none");
export const quoted = (items: readonly string[]): string => items.map((item) => `"${item}"`).join(", ");

const MAX_QUOTE = 90;
/** A sentence short enough to quote in a prompt, cut at a word. */
export const clipped = (text: string): string => (text.length <= MAX_QUOTE ? text : `${text.slice(0, MAX_QUOTE).replace(/\s+\S*$/, "")}…`);

/** The script's beats a row names, in script order. */
export const namedBeats = (script: ScriptV1, row: L0Result): ScriptBeat[] => script.beats.filter((beat) => row.detail_beats.includes(beat.id));

/** The chapter ids a row names, by chapter id or by any beat of the chapter. */
export const namedChapters = (script: ScriptV1, row: L0Result): string[] =>
  script.chapters.filter((c) => row.detail_beats.includes(c.id) || script.beats.some((b) => b.chapter === c.id && row.detail_beats.includes(b.id))).map((c) => c.id);
