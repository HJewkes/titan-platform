/** One shell word; a quoted word is data and never names a subcommand. */
export interface ShellWord {
  readonly text: string;
  readonly quoted: boolean;
}

/** Splits a raw command into simple commands on `&&`, `||`, `;`, `|`, `&` and newlines, honouring quotes and heredocs. */
export function splitCommands(raw: string): ShellWord[][] {
  return new Scanner(raw).run();
}

/** An unquoted `&` right after `>` or `<` is an fd dup (`2>&1`), and `&>` is a redirect, not a separator. */
function operatorAt(src: string, i: number, word: string): string | null {
  const two = src.slice(i, i + 2);
  if (two === "&&" || two === "||") return two;
  const c = src[i];
  if (c === "|" || c === ";" || c === "\n") return c;
  if (c !== "&" || src[i + 1] === ">" || /[<>]$/.test(word)) return null;
  return c;
}

class Scanner {
  private readonly segments: ShellWord[][] = [];
  private words: ShellWord[] = [];
  private text = "";
  private quoted = false;
  private started = false;
  private heredocs: string[] = [];
  private i = 0;

  constructor(private readonly src: string) {}

  run(): ShellWord[][] {
    while (this.i < this.src.length) this.step();
    this.endSegment();
    return this.segments;
  }

  private step(): void {
    const c = this.src[this.i] ?? "";
    if (c === "'" || c === '"') return this.quote(c);
    if (c === "\\") return this.escape();
    if (c === "`") return this.consumeUntil(this.src.indexOf("`", this.i + 1) + 1);
    if (this.src.startsWith("$(", this.i)) return this.consumeUntil(this.closingParen());
    if (this.src.startsWith("<<", this.i) && !this.src.startsWith("<<<", this.i)) return this.heredoc();
    const op = operatorAt(this.src, this.i, this.text);
    if (op) return this.separator(op);
    if (c === " " || c === "\t") return this.skipBlank();
    if ((c === ">" || c === "<") && !/^(\d*|&)$/.test(this.text) && !/[<>]$/.test(this.text)) this.endWord();
    this.append(c);
    this.i++;
  }

  private quote(q: string): void {
    let j = this.i + 1;
    let body = "";
    while (j < this.src.length && this.src[j] !== q) {
      if (q === '"' && this.src[j] === "\\") j++;
      body += this.src[j] ?? "";
      j++;
    }
    this.append(body);
    this.quoted = true;
    this.i = j + 1;
  }

  private escape(): void {
    const next = this.src[this.i + 1] ?? "";
    if (next === "\n") this.endWord();
    else this.append(next);
    this.i += 2;
  }

  private closingParen(): number {
    let depth = 0;
    for (let j = this.i + 1; j < this.src.length; j++) {
      if (this.src[j] === "(") depth++;
      if (this.src[j] === ")" && --depth === 0) return j + 1;
    }
    return this.src.length;
  }

  private consumeUntil(end: number): void {
    const stop = end > this.i ? end : this.src.length;
    this.append(this.src.slice(this.i, stop));
    this.i = stop;
  }

  private heredoc(): void {
    this.endWord();
    const match = /^<<-?[^\S\n]*(?:'([^']*)'|"([^"]*)"|([^\s;&|<>)]+))/.exec(this.src.slice(this.i));
    if (!match) {
      this.i += 2;
      return;
    }
    this.heredocs.push(match[1] ?? match[2] ?? match[3] ?? "");
    this.i += match[0].length;
  }

  private separator(op: string): void {
    this.endSegment();
    this.i += op.length;
    if (op === "\n") this.skipHeredocBodies();
  }

  private skipHeredocBodies(): void {
    for (const delimiter of this.heredocs) {
      while (this.i < this.src.length) {
        const end = this.src.indexOf("\n", this.i);
        const lineEnd = end === -1 ? this.src.length : end;
        const line = this.src.slice(this.i, lineEnd);
        this.i = lineEnd + 1;
        if (line.trim() === delimiter) break;
      }
    }
    this.heredocs = [];
  }

  private skipBlank(): void {
    this.endWord();
    this.i++;
  }

  private append(s: string): void {
    this.text += s;
    this.started = true;
  }

  private endWord(): void {
    if (this.started) this.words.push({ text: this.text, quoted: this.quoted });
    this.text = "";
    this.quoted = false;
    this.started = false;
  }

  private endSegment(): void {
    this.endWord();
    if (this.words.length > 0) this.segments.push(this.words);
    this.words = [];
  }
}
