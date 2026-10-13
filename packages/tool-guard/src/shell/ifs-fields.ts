/**
 * One slice of a word: literal text never splits, an unquoted expansion's value does. A `quoted`
 * part makes a field even when empty, as `""` and `"$e"` do in bash.
 */
export interface WordPart {
  text: string;
  splits: boolean;
  quoted?: boolean;
}

/** One character of the word, or the empty mark a quoted part leaves so its field exists. */
interface WordChar {
  c: string;
  splits: boolean;
}

/** The characters bash 5 treats as IFS whitespace when they are in IFS. */
const IFS_BLANKS = " \t\n\v\f\r";

const inIfs = (c: string, ifs: string): boolean => c !== "" && ifs.includes(c);

// Bash 5.3 matches some IFS characters byte by byte and others by locale character, so a multibyte
// IFS can split inside another character (IFS=" ã©" splits "é"). \x01 and \x7f are bash's internal
// quoting bytes (CTLESC, CTLNUL), so an IFS holding one splits at quotes too. None is modelled.
const UNMODELLED_IFS_CHARS = new Set(["\x01", "\x7f"]);

const isUnmodelledIfs = (ifs: string): boolean =>
  [...ifs].some((c) => (c.codePointAt(0) ?? 0) > 0x7f || UNMODELLED_IFS_CHARS.has(c));

/**
 * True when some character of `text` is in `ifs`, so splitting `text` could change it. Always true
 * for an unmodelled `ifs`, so a caller never skips the split that `ifsFields` refuses to model.
 */
export function hasIfsChar(text: string, ifs: string): boolean {
  return isUnmodelledIfs(ifs) || [...text].some((c) => inIfs(c, ifs));
}

/**
 * The fields bash 5 makes of a word under `ifs` (POSIX 2.6.5). Only characters from a splitting part
 * delimit. A run of IFS whitespace is one delimiter and is dropped at either end of the word; a
 * non-whitespace IFS character with the IFS whitespace around it is one delimiter that always ends a
 * field, even an empty one. A delimiter at the end adds no empty field. A word that comes to nothing
 * yields no field unless a quoted part, even an empty one, makes one.
 *
 * Null when `ifs` has a non-ASCII character, \x01 or \x7f: the split is unmodelled, and the caller must treat that
 * IFS as unknown and leave the word raw, which fails closed.
 */
export function ifsFields(parts: WordPart[], ifs: string): string[] | null {
  if (isUnmodelledIfs(ifs)) return null;
  const fields: string[] = [];
  let field = "";
  let started = false;
  const chars = wordChars(parts);
  for (let i = 0; i < chars.length; ) {
    const end = delimiterEnd(chars, i, ifs);
    if (end === i) {
      field += chars[i]?.c ?? "";
      started = true;
      i++;
      continue;
    }
    if (started || hasHardDelimiter(chars, i, end, ifs)) fields.push(field);
    field = "";
    started = false;
    i = end;
  }
  if (started) fields.push(field);
  return fields;
}

function wordChars(parts: WordPart[]): WordChar[] {
  return parts.flatMap((p) => {
    const chars = [...p.text].map((c) => ({ c, splits: p.splits }));
    return p.quoted === true ? [{ c: "", splits: false }, ...chars] : chars;
  });
}

/** Index just past the delimiter starting at `at`: IFS whitespace, at most one other IFS character, IFS whitespace. */
function delimiterEnd(chars: WordChar[], at: number, ifs: string): number {
  const isIfs = (i: number, blank: boolean): boolean => {
    const ch = chars[i];
    return ch !== undefined && ch.splits && inIfs(ch.c, ifs) && IFS_BLANKS.includes(ch.c) === blank;
  };
  let i = at;
  while (isIfs(i, true)) i++;
  if (isIfs(i, false)) i++;
  while (isIfs(i, true)) i++;
  return i;
}

function hasHardDelimiter(chars: WordChar[], from: number, to: number, ifs: string): boolean {
  return chars.slice(from, to).some((ch) => inIfs(ch.c, ifs) && !IFS_BLANKS.includes(ch.c));
}
