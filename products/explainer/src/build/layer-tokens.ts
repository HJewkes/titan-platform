import { generateTokensCss } from "@titan-design/react-ui/theme/tokens-css";

/** One line of a built layer's source that paints with a colour token the theme does not define. */
export interface TokenFinding {
  line: number;
  token: string;
}

// A CSS declaration, or an inline style key that JSX quotes, as "--color-lane": "#1e6fd9".
const DEFINED = /--(color-[a-zA-Z0-9-]+)["'`]?\s*:/g;
const USED = /var\(\s*--(color-[a-zA-Z0-9-]+)/g;

const definedIn = (css: string): Set<string> => new Set([...css.matchAll(DEFINED)].map((m) => m[1]!));

let themeTokens: ReadonlySet<string> | undefined;

/** The colour tokens of the react-ui theme the composition page loads, from that package's own token generator. */
export const themeColorTokens = (): ReadonlySet<string> => (themeTokens ??= definedIn(generateTokensCss()));

/**
 * Every line of a layer's source that reads a `var(--color-…)` the theme does not define and the layer does not set
 * itself. Such a colour computes to nothing, so the fill is transparent and qa's probe never sees the shape it paints.
 */
export function undefinedTokenFindings(module: string, defined: ReadonlySet<string> = themeColorTokens()): TokenFinding[] {
  const own = definedIn(module);
  return module.split("\n").flatMap((text, index) =>
    [...new Set([...text.matchAll(USED)].map((m) => m[1]!))].filter((token) => !defined.has(token) && !own.has(token)).map((token) => ({ line: index + 1, token })),
  );
}

/** What a rebuild is told about the colour tokens the last build named that the theme lacks, as a field of its packet. */
export const tokenHint = (findings: readonly TokenFinding[]): string =>
  `the last build paints with colour tokens the theme does not define, so those fills and colours paint nothing: ${findings.map(({ line, token }) => `line ${line} (--${token})`).join(", ")}: ` +
  "use only the theme's defined tokens, as var(--color-border-prominent), var(--color-background-subtle) or var(--color-brand-primary-solid)";
