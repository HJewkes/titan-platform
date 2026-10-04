// Reads TypeScript source as text for dead-code-check.mjs: code-graph has no edge for a namespace import's members
// or for a use inside the declaring file, so those are found in the source with comments and string text blanked.

// A `/` after one of these (or at the start) opens a regex literal rather than dividing.
const REGEX_PRECEDERS = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

function stringEnd(src, start, quote) {
  for (let j = start + 1; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === quote) return j + 1;
    else if (src[j] === "\n") return j;
  }
  return src.length;
}

function regexEnd(src, start) {
  let inClass = false;
  for (let j = start + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (c === "\n") return j;
    else if (c === "[" || c === "]") inClass = c === "[";
    else if (c === "/" && !inClass) return j + 1;
  }
  return src.length;
}

/** From a template's opening backtick or an expression's closing brace, to the next `${` or closing backtick. */
function templateEnd(src, start) {
  for (let j = start + 1; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === "`") return { stop: j + 1, opensExpression: false };
    else if (src[j] === "$" && src[j + 1] === "{") return { stop: j + 2, opensExpression: true };
  }
  return { stop: src.length, opensExpression: false };
}

function lastCodeChar(out, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(out[j])) j--;
  return j < 0 ? "" : out[j];
}

/** One lexical token at i: the index after it, and the span inside it to blank, if any. */
function scanToken(src, out, i, templates, depth) {
  const c = src[i];
  const next = src[i + 1];
  if (c === "/" && next === "/") {
    const end = src.indexOf("\n", i);
    return { stop: end < 0 ? src.length : end, blankFrom: i, blankTo: end < 0 ? src.length : end };
  }
  if (c === "/" && next === "*") {
    const end = src.indexOf("*/", i + 2);
    const stop = end < 0 ? src.length : end + 2;
    return { stop, blankFrom: i, blankTo: stop };
  }
  if (c === '"' || c === "'") {
    const stop = stringEnd(src, i, c);
    return { stop, blankFrom: i + 1, blankTo: stop - 1 };
  }
  if (c === "/" && REGEX_PRECEDERS.has(lastCodeChar(out, i))) {
    const stop = regexEnd(src, i);
    return { stop, blankFrom: i + 1, blankTo: stop - 1 };
  }
  if (c === "`" || (c === "}" && templates.at(-1) === depth.value)) return templateToken(src, i, templates, depth);
  if (c === "{") depth.value++;
  if (c === "}") depth.value--;
  return { stop: i + 1 };
}

function templateToken(src, i, templates, depth) {
  if (src[i] === "}") templates.pop();
  const { stop, opensExpression } = templateEnd(src, i);
  if (opensExpression) templates.push(depth.value);
  return { stop, blankFrom: i + 1, blankTo: stop - (opensExpression ? 2 : 1) };
}

/** The source with comments and string, template and regex text blanked to spaces; offsets still index the original. */
export function maskSource(src) {
  const out = src.split("");
  const templates = [];
  const depth = { value: 0 };
  for (let i = 0; i < src.length; ) {
    const { stop, blankFrom, blankTo } = scanToken(src, out, i, templates, depth);
    for (let k = blankFrom ?? stop; k < (blankTo ?? stop); k++) if (out[k] !== "\n") out[k] = " ";
    i = stop;
  }
  return out.join("");
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NAMESPACE_IMPORT = /import\s+(?:type\s+)?\*\s*as\s+[\w$]+\s+from\s*(["'])/g;
const DYNAMIC_IMPORT = /import\(\s*(["'])/g;

/** Specifiers of the string literals each match of pattern opens, read from the original at the masked offsets. */
function matchedSpecifiers(src, masked, pattern) {
  const out = [];
  for (const m of masked.matchAll(pattern)) {
    const open = m.index + m[0].length - 1;
    const close = masked.indexOf(m[1], open + 1);
    if (close > open) out.push(src.slice(open + 1, close));
  }
  return out;
}

/** The specifiers this file imports whole: `import * as ns from "x"` and `import("x")`, never inside a comment or string. */
export function wholeImportSpecifiers(src, masked = maskSource(src)) {
  return { namespace: matchedSpecifiers(src, masked, NAMESPACE_IMPORT), dynamic: matchedSpecifiers(src, masked, DYNAMIC_IMPORT) };
}

/**
 * How often name appears as an identifier in the masked source, its declaration included. Property names after a
 * single dot and names inside an `export { … }` list are not uses.
 */
export function identifierMentions(masked, name) {
  const code = masked.replace(/export\s+(?:type\s+)?\{[^}]*\}/g, "");
  const pattern = new RegExp(`(?<![\\w$])(?<!(?<!\\.)\\.)${escapeRegExp(name)}(?![\\w$])`, "g");
  return [...code.matchAll(pattern)].length;
}
