/** The decorative styling a custom layer's source carries, counted without rendering it. */
export interface StyleTells {
  /** CSS gradient layers: linear-, radial- and conic-gradient, repeating forms included. */
  gradients: number;
  /** Zero-offset blurred shadows, plus every filter drop-shadow or blur. */
  glows: number;
}

const GRADIENT = /\b(?:linear|radial|conic)-gradient\s*\(/g;
// A shadow value is a quoted string (JSX, template) or the rest of a CSS declaration.
const SHADOW = /\b(?:box-?shadow|text-?shadow)\s*:\s*(?:(["'`])((?:(?!\1).)*)\1|([^;\n}]*))/gi;
const FILTER = /(?<![-\w])filter\s*:\s*(?:(["'`])((?:(?!\1).)*)\1|([^;\n}]*))/gi;
const FILTER_GLOW = /\b(?:drop-shadow|blur)\s*\(/g;
const FUNCTION_CALL = /[\w-]+\([^)]*\)/g;
const NUMBER = /-?\d*\.?\d+/g;
const MAX_GRADIENTS = 1;

const count = (source: string, pattern: RegExp): number => [...source.matchAll(pattern)].length;
const valueOf = (m: RegExpMatchArray): string => m[2] ?? m[3] ?? "";

/** A shadow layer is a glow when it sits dead centre (x and y both 0) and blurs. */
function isGlowLayer(layer: string): boolean {
  const [x, y, blur] = (layer.match(NUMBER) ?? []).map(Number);
  return x === 0 && y === 0 && blur !== undefined && blur > 0;
}

const glowShadows = (value: string): number => value.replace(FUNCTION_CALL, "c").split(",").filter(isGlowLayer).length;

/**
 * The gradient layers and glow effects in a layer's source, found by reading its text, so a style written as an
 * object, a CSS string or a template literal counts the same.
 */
export function styleTells(module: string): StyleTells {
  const shadows = [...module.matchAll(SHADOW)].reduce((sum, m) => sum + glowShadows(valueOf(m)), 0);
  const filters = [...module.matchAll(FILTER)].reduce((sum, m) => sum + count(valueOf(m), FILTER_GLOW), 0);
  return { gradients: count(module, GRADIENT), glows: shadows + filters };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** A reported note, not a gate: a layer with more than one gradient or any glow, else nothing. */
export function styleTellNote(beatId: string, tells: StyleTells): string | undefined {
  const found = [
    ...(tells.gradients > MAX_GRADIENTS ? [plural(tells.gradients, "gradient", "gradients")] : []),
    ...(tells.glows > 0 ? [plural(tells.glows, "glow effect", "glow effects")] : []),
  ];
  return found.length === 0 ? undefined : `${beatId} uses ${found.join(" and ")}: decorative styling, kept as built`;
}
