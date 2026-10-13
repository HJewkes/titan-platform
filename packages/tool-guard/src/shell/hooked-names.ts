/** Parameters whose value a shell later runs as code: the bash/zsh trace prompt and zsh's module search path. */
export const HOOKED: ReadonlySet<string> = new Set(["PS4", "PROMPT4", "module_path", "MODULE_PATH"]);

/** A hooked name as a whole identifier: `PS4` in `PS4=1` or `x+PS4`, not in `PS44` or `MY_PS4`. */
const HOOKED_MENTION_RE = new RegExp(`(?<![A-Za-z0-9_])(?:${[...HOOKED].join("|")})(?![A-Za-z0-9_])`, "g");
/** What makes a mention a write in math: an assignment operator, an increment, or a subscript, read as a write. */
const WRITTEN_AFTER_AT_RE = /\s*(?:\[|(?:\*\*|<<|>>|[-+*/%&^|])?=(?!=)|\+\+|--)/y;
const WRITTEN_BEFORE_RE = /(?:\+\+|--)\s*$/;

/** The first hooked name the text mentions at or after `from`. */
export function mentionedIn(text: string, from = 0): string | null {
  HOOKED_MENTION_RE.lastIndex = from;
  return HOOKED_MENTION_RE.exec(text)?.[0] ?? null;
}

/**
 * The first hooked name the text assigns if a shell evaluates it as math: `PS4=1`, `MODULE_PATH+=1`, `PS4++`,
 * `--PS4`. A text stored now and evaluated later, as in `x='PS4=1'; (( x ))`, writes then.
 */
export function assignedInMath(text: string): string | null {
  HOOKED_MENTION_RE.lastIndex = 0;
  for (let mention = HOOKED_MENTION_RE.exec(text); mention !== null; mention = HOOKED_MENTION_RE.exec(text)) {
    WRITTEN_AFTER_AT_RE.lastIndex = mention.index + mention[0].length;
    const before = text.slice(Math.max(0, mention.index - 16), mention.index);
    if (WRITTEN_AFTER_AT_RE.test(text) || WRITTEN_BEFORE_RE.test(before)) return mention[0];
  }
  return null;
}
