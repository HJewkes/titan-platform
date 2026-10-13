/** One slice of a word: literal text never splits, an unquoted expansion's value does. */
export interface WordPart {
  text: string;
  splits: boolean;
}

interface WordChar {
  c: string;
  splits: boolean;
}

const IFS_BLANKS = " \t\n";

/** True when some character of `text` is in `ifs`, so splitting `text` could change it. */
export function hasIfsChar(text: string, ifs: string): boolean {
  return [...text].some((c) => ifs.includes(c));
}

/**
 * The fields bash 5 makes of a word under `ifs` (POSIX 2.6.5). Only characters from a splitting part
 * delimit. A run of IFS whitespace is one delimiter and is dropped at either end of the word; a
 * non-whitespace IFS character with the IFS whitespace around it is one delimiter that always ends a
 * field, even an empty one. A delimiter at the end adds no empty field, and a word that comes to
 * nothing yields no field.
 */
export function ifsFields(parts: WordPart[], ifs: string): string[] {
  const chars = parts.flatMap((p) => [...p.text].map((c) => ({ c, splits: p.splits })));
  const fields: string[] = [];
  let field = "";
  for (let i = 0; i < chars.length; ) {
    const end = delimiterEnd(chars, i, ifs);
    if (end === i) {
      field += chars[i]?.c ?? "";
      i++;
      continue;
    }
    if (field !== "" || hasHardDelimiter(chars, i, end, ifs)) fields.push(field);
    field = "";
    i = end;
  }
  if (field !== "") fields.push(field);
  return fields;
}

/** Index just past the delimiter starting at `at`: IFS whitespace, at most one other IFS character, IFS whitespace. */
function delimiterEnd(chars: WordChar[], at: number, ifs: string): number {
  const isIfs = (i: number, blank: boolean): boolean => {
    const ch = chars[i];
    return ch !== undefined && ch.splits && ifs.includes(ch.c) && IFS_BLANKS.includes(ch.c) === blank;
  };
  let i = at;
  while (isIfs(i, true)) i++;
  if (isIfs(i, false)) i++;
  while (isIfs(i, true)) i++;
  return i;
}

function hasHardDelimiter(chars: WordChar[], from: number, to: number, ifs: string): boolean {
  return chars.slice(from, to).some((ch) => ifs.includes(ch.c) && !IFS_BLANKS.includes(ch.c));
}
