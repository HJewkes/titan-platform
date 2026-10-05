import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import { tokenize } from "./lexer.js";
import type { WordToken } from "./lexer.js";
import { unwrap } from "./unwrap.js";
import type { ClassifyContext } from "../types.js";

const REPO = "/home/you/projects/app";
const ctx: ClassifyContext = { home: "/home/you", readLink: () => null, readHead: () => "feat/x", readScript: () => null };

const verdicts = (command: string) =>
  classify({ kind: "bash", command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null }, ctx).map((a) => [a.spelling, a.subject]);

const PUSH = "bash.merge.git-push-protected";
const spellings = (command: string) => verdicts(command).map(([s]) => s);

describe("a dynamic word in a wrapper's option position", () => {
  it.each([
    ["timeout, unquoted", "timeout $O 5 git push origin HEAD:main"],
    ["timeout, quoted", "timeout \"$O\" 5 git push origin HEAD:main"],
    ["timeout, substitution", "timeout $(echo -s) 5 git push origin HEAD:main"],
    ["sudo", "sudo $O git push origin HEAD:main"],
    ["nice, quoted", "nice \"$O\" git push origin HEAD:main"],
    ["env", "env $O git push origin HEAD:main"],
    ["a second dynamic word", "sudo $A $B git push origin HEAD:main"],
    ["after a static option", "sudo -n $O git push origin HEAD:main"],
    ["a dynamic option value", "timeout -s $S 5 git push origin HEAD:main"],
    ["a nested wrapper", "sudo $O timeout 5 git push origin HEAD:main"],
  ])("reads every placement and fails closed: %s", (_how, command) => {
    expect(spellings(command)).toContain(PUSH);
  });

  it("keeps the single exact reading of a tracked value", () => {
    expect(verdicts("O=--signal=KILL; timeout $O 5 git push origin HEAD:main")).toContainEqual([PUSH, { branch: "main" }]);
    expect(spellings("O=--signal=KILL; timeout $O 5 ls")).not.toContain(PUSH);
  });

  it.each([
    ["timeout $T ls"],
    ["sudo $O git status"],
    ["nice \"$O\" git status"],
    ["timeout $T 5 git log"],
  ])("does not flag a harmless command: %s", (command) => {
    expect(spellings(command)).not.toContain(PUSH);
  });
});

describe("a dynamic word in an xargs option position", () => {
  it.each([
    ["a cluster", "printf 'HEAD:main\\n' | xargs -0 -$O % git push origin %"],
    ["a quoted cluster", "printf 'HEAD:main\\n' | xargs -0 -\"$O\" % git push origin %"],
    ["a replace string", "printf 'HEAD:main\\n' | xargs -I $R git push origin $R"],
    ["a quoted replace string", "printf 'HEAD:main\\n' | xargs -I \"$R\" git push origin \"$R\""],
    ["a dynamic option word", "printf 'HEAD:main\\n' | xargs $O git push origin HEAD:main"],
  ])("gets a push verdict: %s", (_how, command) => {
    expect(spellings(command)).toContain(PUSH);
  });
});

describe("a dynamic word after xargs", () => {
  it("keeps failing closed on a dynamic command word behind a wrapper", () => {
    expect(spellings("xargs env \"$G\" push origin HEAD:main")).toContain(PUSH);
  });
});

describe("a dynamic word past the wrapper's options", () => {
  it.each([
    ["three dynamic arguments", "sudo $O git push origin HEAD:main $A $B $C"],
    ["many dynamic arguments", "sudo $O git push origin HEAD:main $A $B $C $D $E $F"],
    ["many dynamic arguments, timeout", "timeout $O 5 git push origin HEAD:main $A $B $C $D $E"],
  ])("still reads the option position: %s", (_how, command) => {
    expect(spellings(command)).toContain(PUSH);
  });
});

describe("more dynamic option words than the exact reading takes", () => {
  it.each([
    ["sudo", "sudo $A $B $C $D $E git push origin HEAD:main"],
    ["timeout", "timeout $A $B $C $D $E 5 git push origin HEAD:main"],
    ["sudo with a dynamic argument", "sudo $A $B $C $D $E git push origin HEAD:main $X"],
  ])("fails closed: %s", (_how, command) => {
    expect(spellings(command)).toContain(PUSH);
  });

  it("does not flag a harmless command", () => {
    expect(spellings("sudo $A $B $C $D $E git status")).not.toContain(PUSH);
  });
});

describe("a dynamic word's literal text in the readings", () => {
  it.each([
    ["the reviewer's substitution in single quotes", "sudo $O $X $P'$(echo ' git push origin HEAD:main -o$Q')'"],
    ["an unterminated substitution in single quotes", "sudo $O $P'$(' git push origin HEAD:main"],
    ["a parameter expansion in single quotes", "sudo $O $P'${' git push origin HEAD:main"],
    ["a backtick in single quotes", "sudo $O $P'`' git push origin HEAD:main"],
    ["a double quote in single quotes", "sudo $O $P'\"' git push origin HEAD:main"],
    ["a backslash in single quotes", "sudo $O $P'\\' git push origin HEAD:main"],
    ["a semicolon in single quotes", "sudo $O $P';' git push origin HEAD:main"],
    ["a single quote in double quotes", "sudo $O \"$P'\" git push origin HEAD:main"],
    ["a newline in single quotes", "sudo $O $P'\n' git push origin HEAD:main"],
    ["a substitution in a trailing word", "sudo $O git push origin HEAD:main $P'$('"],
    ["a literal word with a quote", "sudo $O git push origin HEAD:main 'a\"b'\\''c'"],
  ])("keeps it literal and still reads the push: %s", (_how, command) => {
    expect(spellings(command)).toContain(PUSH);
  });

  it("does not flag a harmless command", () => {
    expect(spellings("sudo $O $P'$(' git status")).not.toContain(PUSH);
  });
});

describe("a computed expansion inside a word after the wrapper's options", () => {
  const words = [
    ["a substitution", "$(git branch --show-current):main"],
    ["a backtick substitution", "`git branch --show-current`:main"],
    ["a parameter expansion with an operator", "${R:-x}:main"],
    ["an arithmetic expansion", "$((1)):main"],
    ["a quoted substitution", "\"$(git rev-parse HEAD)\":refs/heads/main"],
  ];
  const wrappers = [
    ["sudo $O", "sudo $O"],
    ["timeout $T 5", "timeout $T 5"],
    ["over the cap", "sudo $A $B $C $D $E"],
  ];

  it.each(wrappers.flatMap(([w, prefix]) => words.map(([how, word]) => [`${how} after ${w}`, `${prefix} git push origin ${word}`])))(
    "still reads the push: %s",
    (_how, command) => {
      expect(spellings(command)).toContain(PUSH);
    },
  );
});

describe("a reading's stand-in for a dynamic word", () => {
  it.each([
    ["a plain assignment", "__dynamic=x; timeout $A $B $C 5 git push origin HEAD:main"],
    ["an export", "export __dynamic=x; timeout $A $B $C 5 git push origin HEAD:main"],
    ["a declare", "declare __dynamic=x; timeout $A $B $C 5 git push origin HEAD:main"],
    ["a readonly", "readonly __dynamic=x; timeout $A $B $C 5 git push origin HEAD:main"],
    ["a plain assignment before sudo", "__dynamic=x; sudo $A $B $C git push origin HEAD:main"],
  ])("cannot be steered by a variable of the same name: %s", (_how, command) => {
    expect(spellings(command)).toContain(PUSH);
  });
});

describe("the one-pass reading over the cap", () => {
  it.each([
    ["sudo -u", "sudo $A $B $C $D $E -u git push origin HEAD:main"],
    ["sudo -g", "sudo $A $B $C $D $E -g git push origin HEAD:main"],
    ["sudo -p", "sudo $A $B $C $D $E -p git push origin HEAD:main"],
    ["timeout -k", "timeout $A $B $C $D $E -k 5 git push origin HEAD:main"],
    ["timeout -s", "timeout $A $B $C $D $E -s git push origin HEAD:main"],
    ["nice -n", "nice $A $B $C $D $E -n git push origin HEAD:main"],
    ["timeout with a dynamic duration", "timeout $A $B $C $D $E git push origin HEAD:main"],
  ])("lets a dynamic word take the next option or stand as the positional: %s", (_how, command) => {
    expect(spellings(command)).toContain(PUSH);
  });
});

describe("one budget for dynamic option words across a nested wrapper chain", () => {
  const vars = (name: string, n: number) => Array.from({ length: n }, (_, i) => `$${name}${i}`).join(" ");
  const chain = (counts: number[], tail: string) =>
    [["sudo", counts[0]], ["nice", counts[1]], ["timeout", counts[2]], ["env", counts[3]]]
      .filter(([, n]) => n !== undefined)
      .map(([w, n], i) => `${w} ${vars(String.fromCharCode(97 + i), n as number)}${w === "timeout" ? " 5" : ""}`)
      .join(" ") + ` ${tail}`;
  const timed = (command: string) => {
    const started = performance.now();
    const found = spellings(command);
    expect(performance.now() - started).toBeLessThan(1000);
    return found;
  };

  it("reads four dynamic words in each of three wrappers without a nesting error", () => {
    expect(timed("sudo $a0 $a1 $a2 $a3 nice $b0 $b1 $b2 $b3 timeout $c0 $c1 $c2 $c3 5 git push origin HEAD:main")).toContain(PUSH);
  });

  it("reads twenty dynamic words in each of three wrappers in time", () => {
    expect(timed(chain([20, 20, 20], "git push origin HEAD:main"))).toContain(PUSH);
  });

  it("does not flag the same chain ending in a harmless command", () => {
    expect(timed(chain([20, 20, 20], "ls"))).not.toContain(PUSH);
  });

  it("reads four wrappers of eight dynamic words in time", () => {
    expect(timed(chain([8, 8, 8, 8], "git push origin HEAD:main"))).toContain(PUSH);
  });

  it.each([[[4, 4, 4]], [[20, 20, 20]], [[8, 8, 8, 8]]])("keeps the readings linear in the dynamic words: %j", (counts) => {
    const words = tokenize(chain(counts, "git push origin HEAD:main")).filter((t): t is WordToken => t.type === "word");
    const total = counts.reduce((a, b) => a + b, 0);
    const readings = (unwrap(words)?.script ?? "").split("\n").length;
    expect(readings).toBeGreaterThan(0);
    expect(readings).toBeLessThanOrEqual(4 * total + 1);
  });
});

describe("a reading's budget survives its reparse", () => {
  const stages = (n: number) => "sudo $A1 -u timeout 5 ".repeat(n);
  const PUSH_TAIL = "git push origin HEAD:main";
  const HIDDEN = "sudo $A -u timeout 5 timeout $c1 $c2 $c3 $c4 5 sudo $E -u timeout 5";
  const timed = (command: string) => {
    const started = performance.now();
    const found = spellings(command);
    expect(performance.now() - started).toBeLessThan(1000);
    return found;
  };
  const words = (command: string) => tokenize(command).filter((t): t is WordToken => t.type === "word");

  /** Readings and reparse depth across every level: each line of a script is parsed and unwrapped again, as classify does. */
  function reparses(command: string, limit = 5000): { readings: number; depth: number } {
    const walk = (line: string, depth: number): { readings: number; depth: number } => {
      const script = unwrap(words(line))?.script;
      if (script === undefined) return { readings: 1, depth };
      const out = { readings: 0, depth };
      for (const next of script.split("\n")) {
        if (out.readings > limit) break;
        const inner = walk(next, depth + 1);
        out.readings += inner.readings;
        out.depth = Math.max(out.depth, inner.depth);
      }
      return out;
    };
    return walk(command, 0);
  }

  it("reads nine stages as a push without a nesting error", () => {
    expect(timed(`${stages(9)}${PUSH_TAIL}`)).toContain(PUSH);
  });

  it.each([[12], [20]])("reads %i stages as a push in time", (n) => {
    expect(timed(`${stages(n)}${PUSH_TAIL}`)).toContain(PUSH);
  });

  it("does not flag nine stages ending in a harmless command", () => {
    expect(timed(`${stages(9)}ls`)).not.toContain(PUSH);
  });

  it("reads a chain that hides wrappers behind dynamic words as a push", () => {
    expect(timed(`${HIDDEN} ${PUSH_TAIL}`)).toContain(PUSH);
  });

  it("reads a hidden chain that repeats its stages as a push", () => {
    expect(timed(`${HIDDEN} ${"sudo $E -u timeout 5 ".repeat(9)}${PUSH_TAIL}`)).toContain(PUSH);
  });

  it("does not throw on the hidden chain ending in a harmless command", () => {
    expect(timed(`${HIDDEN} ls`)).not.toContain(PUSH);
  });

  it.each([[9], [20]])("keeps the readings and the reparse depth bounded: %i stages", (n) => {
    const { readings, depth } = reparses(`${stages(n)}${PUSH_TAIL}`);
    expect(readings).toBeLessThanOrEqual(4 * n + 1);
    expect(depth).toBeLessThanOrEqual(2);
  });
});
