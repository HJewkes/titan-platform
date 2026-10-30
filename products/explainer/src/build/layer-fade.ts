/** One element of a built layer that renders text and whose opacity is animated, computed or set below 1. */
export interface FadeFinding {
  line: number;
  /** The element's `id` when it has one, else its tag name. */
  element: string;
  /** The first text the element renders, trimmed. */
  text: string;
}

/** The rule a rebuild is told, and the contrast hint repeats for an element that fades. */
export const FULL_COLOUR_RULE = "enter text at full colour, by translate, scale or clip-path, never an opacity fade";

interface Frame {
  element: string;
  line: number;
  text: string;
  fades: boolean;
}

// A `<` opens JSX, not a comparison or a generic, after one of these.
const OPENS_JSX = /(?:^|[(,=?:&|>}{;[]|\breturn)$/;
const OPACITY = /\bopacity\s*:\s*/g;

const lineAt = (source: string, index: number): number => source.slice(0, index).split("\n").length;

/** The index just past a string, template or comment that starts at `i`, or `i` when none does. */
function skipQuoted(s: string, i: number): number {
  const c = s[i];
  if (c === "/" && s[i + 1] === "/") return s.indexOf("\n", i) < 0 ? s.length : s.indexOf("\n", i);
  if (c === "/" && s[i + 1] === "*") return s.indexOf("*/", i + 2) < 0 ? s.length : s.indexOf("*/", i + 2) + 2;
  if (c !== '"' && c !== "'" && c !== "`") return i;
  let j = i + 1;
  while (j < s.length && s[j] !== c) j += s[j] === "\\" ? 2 : 1;
  return j + 1;
}

/** The end of the tag that opens at `start` (just past its `>`), and whether it closes itself. */
function tagEnd(s: string, start: number): { end: number; selfClosing: boolean } {
  let depth = 0;
  for (let i = start; i < s.length; ) {
    const skipped = skipQuoted(s, i);
    if (skipped !== i) i = skipped;
    else {
      if (s[i] === "{") depth++;
      else if (s[i] === "}") depth--;
      else if (s[i] === ">" && depth === 0 && s[i - 1] !== "=") return { end: i + 1, selfClosing: s[i - 1] === "/" };
      i++;
    }
  }
  return { end: s.length, selfClosing: true };
}

/** The expression written from `from` to the next comma or closing bracket at its own depth. */
function valueAfter(s: string, from: number): string {
  let depth = 0;
  let i = from;
  for (; i < s.length; i++) {
    const c = s[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) break;
  }
  return s.slice(from, i).trim();
}

/** Only a literal 1 leaves an element at full opacity. */
const fadesOpacity = (attrs: string): boolean => [...attrs.matchAll(OPACITY)].some((m) => !/^1(?:\.0+)?$/.test(valueAfter(attrs, m.index + m[0].length)));

/** Names of the helpers (`const card = (p) => ({ ..., opacity: p })`) that hold an opacity outside any tag's attributes. */
function fadingHelpers(source: string, tagRanges: readonly [number, number][]): Set<string> {
  const names = new Set<string>();
  for (const m of source.matchAll(OPACITY)) {
    if (tagRanges.some(([from, to]) => m.index >= from && m.index < to)) continue;
    if (/^1(?:\.0+)?$/.test(valueAfter(source, m.index + m[0].length))) continue;
    const declared = [...source.slice(0, m.index).matchAll(/\b(?:const|let|var|function)\s+(\w+)/g)].pop();
    if (declared) names.add(declared[1]!);
  }
  return names;
}

interface Walk {
  tagRanges: [number, number][];
  frames: Frame[];
  helperUses: { name: string; frame: Frame }[];
}

// `child` modes read JSX text; `js` modes read an expression inside `{}` and end at its matching brace.
interface Mode {
  kind: "js" | "child";
  depth: number;
  from: number;
}

interface WalkState extends Walk {
  source: string;
  open: Frame[];
  modes: Mode[];
}

const top = <T,>(items: readonly T[]): T => items[items.length - 1]!;
const HELPER_USE = /\b([A-Za-z_]\w*)\s*\(|\.\.\.([A-Za-z_]\w*)|style=\{([A-Za-z_]\w*)\}/g;
const ELEMENT_ID = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`]*)["'`]\s*\})/;

/** Reads the closing tag at `i`; the element it closes hands its text up to its parent. */
function closeTag(st: WalkState, i: number): number {
  const close = st.source.indexOf(">", i);
  if (top(st.modes).kind === "child") {
    st.modes.pop();
    const frame = st.open.pop();
    const parent = st.open[st.open.length - 1];
    if (frame && parent && !parent.text) parent.text = frame.text;
  }
  return close < 0 ? st.source.length : close + 1;
}

/** Reads the opening tag at `i` into a frame, entering its children unless it closes itself. */
function openTag(st: WalkState, i: number): number {
  const name = /^<([A-Za-z][\w.]*)?/.exec(st.source.slice(i))![1] ?? "";
  const { end, selfClosing } = tagEnd(st.source, i + 1 + name.length);
  const attrs = st.source.slice(i + 1 + name.length, end);
  const id = ELEMENT_ID.exec(attrs);
  const frame: Frame = { element: id ? (id[1] ?? id[2] ?? id[3]!) : name || "fragment", line: lineAt(st.source, i), text: "", fades: fadesOpacity(attrs) };
  st.tagRanges.push([i, end]);
  st.frames.push(frame);
  st.helperUses.push(...[...attrs.matchAll(HELPER_USE)].map((m) => ({ name: m[1] ?? m[2] ?? m[3]!, frame })));
  if (!selfClosing) {
    st.open.push(frame);
    st.modes.push({ kind: "child", depth: 0, from: end });
  }
  return end;
}

/** One step through JSX children: text it renders is kept on the element, a `{` starts an expression. */
function childStep(st: WalkState, i: number): number {
  const frame = top(st.open);
  if (st.source[i] === "{") {
    st.modes.push({ kind: "js", depth: 0, from: i + 1 });
    return i + 1;
  }
  if (/\s/.test(st.source[i]!)) return i + 1;
  const run = /^[^<{]*/.exec(st.source.slice(i))![0];
  if (!frame.text) frame.text = run.trim();
  return i + run.length;
}

/** One character of an expression: braces nest, and the brace that closes a child expression leaves it. */
function expressionStep(st: WalkState, i: number): number {
  const mode = top(st.modes);
  const c = st.source[i];
  if (c === "{") mode.depth++;
  else if (c === "}" && mode.depth > 0) mode.depth--;
  else if (c === "}" && st.modes.length > 1) {
    st.modes.pop();
    const expression = st.source.slice(mode.from, i);
    const frame = st.open[st.open.length - 1];
    // An expression that draws no element prints a value, which is text.
    if (frame && !frame.text && !expression.includes("<") && expression.replace(/\/\*[\s\S]*?\*\//g, "").trim() !== "") frame.text = `{${expression.trim()}}`;
  }
  return i + 1;
}

/** Every element of the source, as frames that remember the text each renders and whether it fades. */
function walk(source: string): Walk {
  const st: WalkState = { source, tagRanges: [], frames: [], helperUses: [], open: [], modes: [{ kind: "js", depth: 0, from: 0 }] };
  for (let i = 0; i < source.length; ) {
    const mode = top(st.modes);
    const skipped = mode.kind === "js" || source[i] === "/" ? skipQuoted(source, i) : i;
    if (skipped !== i) i = skipped;
    else if (source[i] === "<" && (mode.kind === "child" || OPENS_JSX.test(source.slice(0, i).trimEnd()))) i = source[i + 1] === "/" ? closeTag(st, i) : openTag(st, i);
    else i = mode.kind === "child" ? childStep(st, i) : expressionStep(st, i);
  }
  return st;
}

/**
 * Every element of a layer's source that renders text (its own, or a descendant's) and whose opacity is animated,
 * computed or below 1, found by reading the JSX. A fading shape with no text is allowed. An opacity held by a helper
 * (`const card = (p) => ({ opacity: p })`) counts against each element that calls or spreads that helper.
 */
export function fadedTextFindings(module: string): FadeFinding[] {
  const { tagRanges, frames, helperUses } = walk(module);
  const helpers = fadingHelpers(module, tagRanges);
  const fading = new Set([...frames.filter((f) => f.fades), ...helperUses.filter((u) => helpers.has(u.name)).map((u) => u.frame)]);
  return frames.filter((f) => fading.has(f) && f.text !== "").map(({ line, element, text }) => ({ line, element, text: text.slice(0, 40) }));
}

/** What a rebuild is told about the text the last build faded in, as a field of its packet. */
export const fadeHint = (beatId: string, findings: readonly FadeFinding[]): string =>
  findings.map(({ element, text }) => `${beatId} ${element} ${JSON.stringify(text)}: ${FULL_COLOUR_RULE}`).join("; ");
