/** Parameters whose value a shell later runs as code: the bash/zsh trace prompt and zsh's module search path. */
export const HOOKED: ReadonlySet<string> = new Set(["PS4", "PROMPT4", "module_path", "MODULE_PATH"]);

/** A name as a whole identifier: `PS4` in `PS4=1` or `x+PS4`, not in `PS44` or `MY_PS4`. */
const WORD_RE = /[A-Za-z0-9_]+/g;
/** What makes a mention a write in math: an assignment operator (zsh adds `&&=`, `||=`, `^^=`), an increment, or a subscript, read as a write. */
const WRITTEN_AFTER_AT_RE = /\s*(?:\[|(?:\*\*|<<|>>|&&|\|\||\^\^|[-+*/%&^|])?=(?!=)|\+\+|--)/y;
const WRITTEN_BEFORE_RE = /(?:\+\+|--)\s*$/;

/** The whole-identifier words of the text at or after `from`, with a word cut by `from` left out. */
function* wordsFrom(text: string, from: number): Generator<RegExpExecArray> {
  WORD_RE.lastIndex = from;
  for (let word = WORD_RE.exec(text); word !== null; word = WORD_RE.exec(text)) {
    if (word.index === from && from > 0 && /\w/.test(text.charAt(from - 1))) continue;
    yield word;
  }
}

/** The first name in `names` the text mentions at or after `from`. */
export function mentionedIn(text: string, from = 0, names: ReadonlySet<string> = HOOKED): string | null {
  for (const word of wordsFrom(text, from)) if (names.has(word[0])) return word[0];
  return null;
}

/**
 * The first name in `names` the text assigns if a shell evaluates it as math: `PS4=1`, `MODULE_PATH+=1`, `PS4++`,
 * `--PS4`. A text stored now and evaluated later, as in `x='PS4=1'; (( x ))`, writes then.
 */
export function assignedInMath(text: string, names: ReadonlySet<string> = HOOKED): string | null {
  for (const mention of wordsFrom(text, 0)) {
    if (!names.has(mention[0])) continue;
    WRITTEN_AFTER_AT_RE.lastIndex = mention.index + mention[0].length;
    const before = text.slice(Math.max(0, mention.index - 16), mention.index);
    if (WRITTEN_AFTER_AT_RE.test(text) || WRITTEN_BEFORE_RE.test(before)) return mention[0];
  }
  return null;
}
