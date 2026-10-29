export type FontRule = "@font-face" | "font import" | "font url" | "remote font host" | "font family";

/** One line of a built layer's source that loads or names a font the theme does not provide. */
export interface FontFinding {
  line: number;
  rule: FontRule;
  text: string;
}

const FONT_FILE = String.raw`\.(?:woff2?|ttf|otf|eot)\b`;
const THEME_FAMILY = /^(?:inherit|var\(--font-family-(?:body|heading|mono|sans)\s*(?:,[^)]*)?\))$/;

const LINE_RULES: readonly (readonly [FontRule, RegExp])[] = [
  ["@font-face", /@font-face/],
  ["font import", new RegExp(`\\bimport\\b[^\\n]*(?:${FONT_FILE}|@fontsource|font-?source)`, "i")],
  ["font url", new RegExp(`url\\([^)]*${FONT_FILE}`, "i")],
  ["remote font host", /fonts\.(?:googleapis|gstatic)\.com|use\.typekit\.net/],
];
// A quoted literal after `fontFamily:` or a bare value after `font-family:`; a computed value is left alone.
const FAMILY_VALUE = /\bfontFamily\s*:\s*(["'`])(.*?)\1|\bfont-family\s*:\s*([^;"'`}]+(?:'[^']*'[^;"'`}]*)*)/g;

function namesOwnFamily(text: string): boolean {
  return [...text.matchAll(FAMILY_VALUE)].some((m) => !THEME_FAMILY.test((m[2] ?? m[3] ?? "").trim()));
}

/** Every line of a layer's source that loads a font or names one outside the theme's font tokens. */
export function fontFindings(module: string): FontFinding[] {
  return module.split("\n").flatMap((text, index): FontFinding[] => {
    const rules = LINE_RULES.filter(([, pattern]) => pattern.test(text)).map(([rule]) => rule);
    if (namesOwnFamily(text)) rules.push("font family");
    return rules.map((rule) => ({ line: index + 1, rule, text: text.trim() }));
  });
}

/** What a rebuild is told about the fonts the last build set, as a field of its packet. */
export const fontHint = (findings: readonly FontFinding[]): string =>
  `the last build set its own fonts: ${findings.map(({ line, rule }) => `line ${line} (${rule})`).join(", ")}: load no font and name none; ` +
  `style text with the theme font tokens, fontFamily: "var(--font-family-body)", "var(--font-family-heading)", "var(--font-family-mono)" or "var(--font-family-sans)"`;
