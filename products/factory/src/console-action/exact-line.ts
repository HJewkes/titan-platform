/**
 * A reversible, visible rendering of one raw line for the owner's evidence card. Unlike `shownLine`, the prompt's lossy
 * renderer, it cuts nothing and strips nothing: every character a screen could hide, reorder or break on is written as
 * `\u{HEX}`, a backslash as `\\`, and `unexactLine` gives back the exact string.
 */

/**
 * Controls (C0, DEL, C1), format characters (bidi and zero-width marks, the BOM), line and paragraph separators, lone
 * surrogates, default-ignorable characters (variation selectors, Hangul fillers, tags), every space but U+0020, the
 * braille blank, and the backslash itself. A variation-selector run can smuggle a payload past the eye, and `run:\u{A0}x`
 * reads as `run: x` while YAML parses it as a plain string.
 */
const HIDDEN = /[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]|(?! )\p{Zs}|\p{Cs}/gu;
const ESCAPE = /\\(?:\\|u\{([0-9A-F]{1,6})\})/g;

export function exactLine(raw: string): string {
  return raw.replace(HIDDEN, (char) => (char === "\\" ? "\\\\" : `\\u{${char.codePointAt(0)!.toString(16).toUpperCase()}}`));
}

export function unexactLine(shown: string): string {
  return shown.replace(ESCAPE, (_, hex: string | undefined) => (hex === undefined ? "\\" : String.fromCodePoint(Number.parseInt(hex, 16))));
}
