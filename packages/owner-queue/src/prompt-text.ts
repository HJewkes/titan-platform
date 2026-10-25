/**
 * Author-, reviewer- and agent-written text reaches an owner's prompt, terminal or decisions file, so nothing in it may
 * move the cursor, reorder or hide what is shown, or start a line the caller did not draw.
 */
// eslint-disable-next-line no-control-regex -- ANSI sequences are exactly what a prompt must not render
const ANSI_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/gu;

/** Every break a renderer or reader may start a new line at, not only `\n`: split on this to keep a caller's own lines. */
export const PROMPT_LINE_BREAK = /\r\n|[\n\r\u0085\u2028\u2029]/;
const LINE_BREAKS = new RegExp(PROMPT_LINE_BREAK.source, "gu");

/** C0 and C1 controls and every format character: bidi overrides, embeddings, marks and isolates, zero-width and tag characters. */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

export interface PromptLineOptions {
  /** What a line break becomes; a space unless the caller marks breaks visibly. */
  lineBreak?: string;
}

/** One line safe to show: escape sequences and invisible characters go, a tab becomes a space, a break becomes `lineBreak`. */
export function promptLine(text: string, { lineBreak = " " }: PromptLineOptions = {}): string {
  return text.replace(ANSI_SEQUENCE, "").replace(LINE_BREAKS, lineBreak).replace(/\t/g, " ").replace(INVISIBLE, "");
}
