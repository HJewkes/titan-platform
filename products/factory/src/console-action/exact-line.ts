/**
 * A reversible, visible rendering of one raw line for the owner's evidence card. Unlike `shownLine`, the prompt's lossy
 * renderer, it cuts nothing and strips nothing: every character a screen could hide, reorder or break on is written as
 * `\u{HEX}`, a backslash as `\\`, and `unexactLine` gives back the exact string.
 */

/** C0 and C1 controls, DEL, bidi and zero-width marks, line and paragraph separators, the BOM, lone surrogates, and the backslash itself. */
const HIDDEN = /[\\\u{0}-\u{1f}\u{7f}-\u{9f}\u{61c}\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2060}-\u{2069}\u{feff}]|\p{Cs}/gu;
const ESCAPE = /\\(?:\\|u\{([0-9A-F]{1,6})\})/g;

export function exactLine(raw: string): string {
  return raw.replace(HIDDEN, (char) => (char === "\\" ? "\\\\" : `\\u{${char.codePointAt(0)!.toString(16).toUpperCase()}}`));
}

export function unexactLine(shown: string): string {
  return shown.replace(ESCAPE, (_, hex: string | undefined) => (hex === undefined ? "\\" : String.fromCodePoint(Number.parseInt(hex, 16))));
}
