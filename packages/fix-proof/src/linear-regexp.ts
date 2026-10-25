type CharTest = (char: string) => boolean;

type Node =
  | { readonly kind: "char"; readonly test: CharTest }
  | { readonly kind: "start" | "end" }
  | { readonly kind: "seq"; readonly items: readonly Node[] }
  | { readonly kind: "alt"; readonly options: readonly Node[] }
  | { readonly kind: "repeat"; readonly item: Node; readonly min: 0 | 1; readonly unbounded: boolean };

type State =
  | { readonly kind: "char"; readonly test: CharTest; readonly next: number }
  | { kind: "split"; next: number[] }
  | { readonly kind: "start" | "end"; readonly next: number }
  | { readonly kind: "match" };

const LINE_TERMINATORS = new Set(["\n", "\r", " ", " "]);
// Escapes that read more than one character or assert a position, which the NFA does not model.
const UNSUPPORTED_ESCAPE = /[0-9bBcxukpP]/;

/** One character, tested by the native engine: a single-character RegExp cannot backtrack. */
function nativeChar(source: string, flags: string): CharTest {
  const regexp = new RegExp(`^(?:${source})$`, flags);
  return (char) => regexp.test(char);
}

// Parses the subset glob compilers emit into a tree; anything outside it is a SyntaxError, as RegExp throws for bad source.
class Parser {
  private at = 0;
  private readonly source: string;
  private readonly flags: string;
  private readonly charFlags: string;

  constructor(source: string, flags: string) {
    this.source = source;
    this.flags = flags;
    this.charFlags = flags.replace(/[^is]/g, "");
  }

  parse(): Node {
    const node = this.alternation();
    if (this.at < this.source.length) throw this.error("unmatched )");
    return node;
  }

  private error(what: string): SyntaxError {
    return new SyntaxError(`LinearRegExp /${this.source}/: ${what} at ${this.at}`);
  }

  private alternation(): Node {
    const options = [this.sequence()];
    while (this.source[this.at] === "|") {
      this.at += 1;
      options.push(this.sequence());
    }
    return options.length === 1 ? options[0]! : { kind: "alt", options };
  }

  private sequence(): Node {
    const items: Node[] = [];
    while (this.at < this.source.length && this.source[this.at] !== "|" && this.source[this.at] !== ")") items.push(this.quantified());
    return { kind: "seq", items };
  }

  private quantified(): Node {
    const item = this.atom();
    const quantifier = this.source[this.at];
    if (quantifier === "{" && /^\{\d/.test(this.source.slice(this.at, this.at + 2))) throw this.error("{n,m} is not supported");
    if (quantifier !== "*" && quantifier !== "+" && quantifier !== "?") return item;
    if (item.kind === "start" || item.kind === "end") throw this.error("nothing to repeat");
    this.at += 1;
    // A lazy quantifier changes which match is found, never whether one is.
    if (this.source[this.at] === "?") this.at += 1;
    return { kind: "repeat", item, min: quantifier === "+" ? 1 : 0, unbounded: quantifier !== "?" };
  }

  private atom(): Node {
    const char = this.source.charAt(this.at);
    this.at += 1;
    if (char === "(") return this.group();
    if (char === "[") return this.charClass();
    if (char === "\\") return this.escape();
    if (char === "^") return { kind: "start" };
    if (char === "$") return { kind: "end" };
    if (char === "*" || char === "+" || char === "?") throw this.error("nothing to repeat");
    if (char === ".") return { kind: "char", test: this.dot() };
    return { kind: "char", test: this.literal(char) };
  }

  private dot(): CharTest {
    return this.flags.includes("s") ? () => true : (char) => !LINE_TERMINATORS.has(char);
  }

  private literal(char: string): CharTest {
    return this.flags.includes("i") ? nativeChar(char.replace(/[.*+?^${}()|[\]\\/]/, "\\$&"), this.charFlags) : (c) => c === char;
  }

  private group(): Node {
    if (this.source.startsWith("?:", this.at)) this.at += 2;
    else if (this.source[this.at] === "?") throw this.error("lookaround and named groups are not supported");
    const inner = this.alternation();
    if (this.source[this.at] !== ")") throw this.error("unterminated group");
    this.at += 1;
    return inner;
  }

  private escape(): Node {
    const char = this.source[this.at];
    if (char === undefined) throw this.error("\\ at end of pattern");
    if (UNSUPPORTED_ESCAPE.test(char)) throw this.error(`\\${char} is not supported`);
    this.at += 1;
    return { kind: "char", test: nativeChar(`\\${char}`, this.charFlags) };
  }

  // A non-unicode class closes at the first unescaped `]`, even right after `[` or `[^`, where it is empty.
  private charClass(): Node {
    const open = this.at - 1;
    let index = this.source[this.at] === "^" ? this.at + 1 : this.at;
    while (index < this.source.length && this.source[index] !== "]") index += this.source[index] === "\\" ? 2 : 1;
    if (index >= this.source.length) throw this.error("unterminated character class");
    this.at = index + 1;
    return { kind: "char", test: nativeChar(this.source.slice(open, this.at), this.charFlags) };
  }
}

// Thompson's construction, built back to front: each node is compiled with the state it continues to.
function build(node: Node, next: number, states: State[]): number {
  const add = (state: State): number => states.push(state) - 1;
  switch (node.kind) {
    case "char":
      return add({ kind: "char", test: node.test, next });
    case "start":
    case "end":
      return add({ kind: node.kind, next });
    case "seq":
      return node.items.reduceRight((after, item) => build(item, after, states), next);
    case "alt":
      return add({ kind: "split", next: node.options.map((option) => build(option, next, states)) });
    case "repeat":
      return buildRepeat(node, next, states);
  }
}

function buildRepeat(node: Extract<Node, { kind: "repeat" }>, next: number, states: State[]): number {
  if (!node.unbounded) return states.push({ kind: "split", next: [build(node.item, next, states), next] }) - 1;
  const loop: State = { kind: "split", next: [] };
  const loopAt = states.push(loop) - 1;
  const body = build(node.item, loopAt, states);
  loop.next = [body, next];
  return node.min === 1 ? body : loopAt;
}

interface Run {
  readonly states: readonly State[];
  readonly marks: Uint32Array;
  readonly length: number;
  generation: number;
}

/** Adds `from` and every state it reaches without reading a character at `position`; true once the match state is among them. */
function close(run: Run, from: number, position: number, into: number[]): boolean {
  let matched = false;
  const stack = [from];
  while (stack.length > 0) {
    const at = stack.pop()!;
    if (run.marks[at] === run.generation) continue;
    run.marks[at] = run.generation;
    const state = run.states[at]!;
    if (state.kind === "match") matched = true;
    else if (state.kind === "char") into.push(at);
    else if (state.kind === "split") for (let k = state.next.length - 1; k >= 0; k -= 1) stack.push(state.next[k]!);
    else if (state.kind === "start" ? position === 0 : position === run.length) stack.push(state.next);
  }
  return matched;
}

function compile(source: string, flags: string): (input: string) => boolean {
  const states: State[] = [{ kind: "match" }];
  const start = build(new Parser(source, flags).parse(), 0, states);
  return (input) => {
    const run: Run = { states, marks: new Uint32Array(states.length), length: input.length, generation: 1 };
    let current: number[] = [];
    let matched = close(run, start, 0, current);
    for (let position = 0; position < input.length && !matched; position += 1) {
      const char = input.charAt(position);
      const next: number[] = [];
      run.generation += 1;
      for (const at of current) {
        const state = states[at] as Extract<State, { kind: "char" }>;
        if (state.test(char)) matched = close(run, state.next, position + 1, next) || matched;
      }
      // `test` searches, so a match may also begin here.
      matched = close(run, start, position + 1, next) || matched;
      current = next;
    }
    return matched;
  };
}

/**
 * A RegExp whose `test` costs input length times pattern length, for patterns built from untrusted globs. A backtracking
 * RegExp goes polynomial on runs such as `[^/]*` twenty times or `(?:.*\/)?` twelve times, which one config line or
 * command word can hold (TP-1756, TP-4223). The source is simulated as a Thompson NFA instead. It accepts the subset glob
 * compilers emit: literals, escapes, `.`, classes, `(?:)` and `()` groups, `|`, `*`, `+`, `?`, `^` and `$`, under the
 * `i` and `s` flags; other syntax throws a SyntaxError. `matches` replaces the compiled test when given. `exec` reports
 * a match as the whole input, which is what an anchored glob matches; capture groups are not reported.
 */
export class LinearRegExp extends RegExp {
  readonly #matches: (input: string) => boolean;

  constructor(source: string, flags = "", matches?: (input: string) => boolean) {
    if (/[gy]/.test(flags)) throw new SyntaxError("LinearRegExp keeps no lastIndex, so the g and y flags are refused");
    super(source, flags);
    this.#matches = matches ?? compile(source, flags);
  }

  override test(input: string): boolean {
    return this.#matches(String(input));
  }

  override exec(input: string): RegExpExecArray | null {
    const text = String(input);
    if (!this.#matches(text)) return null;
    const match: [string] = [text];
    return Object.assign(match, { index: 0, input: text, groups: undefined });
  }
}
