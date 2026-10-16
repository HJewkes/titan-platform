import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { envSplitWords } from "./env-split.js";
import { tokenize } from "./lexer.js";
import type { WordToken } from "./lexer.js";
import { unwrap } from "./unwrap.js";

function argv0(src: string): Array<string | null> | undefined {
  const words = tokenize(src).filter((t): t is WordToken => t.type === "word");
  return unwrap(words)?.argv0;
}

describe("argv0 of a wrapped command", () => {
  it.each([
    ["exec -a ksh zsh -c x", ["ksh"]],
    ["exec -aksh zsh -c x", ["ksh"]],
    ["exec -cla -ksh zsh -c x", ["-ksh"]],
    ["env --argv0 sh zsh -c x", ["sh"]],
    ["env --argv0=sh zsh -c x", ["sh"]],
    ["env -a sh zsh -c x", ["sh"]],
    ["env -u FOO -a sh zsh -c x", ["sh"]],
    ["env -a sh -S 'zsh -c x'", ["sh"]],
    ["env -L x -a sh zsh -c x", ["sh"]],
    ["ARGV0=sh env -S 'zsh -c x'", ["sh"]],
    ["ARGV0=sh zsh -c x", ["sh"]],
    ["exec -a $a zsh -c x", [null]],
    ["exec -a =sh zsh -c x", [null]],
    ["ARGV0==sh zsh -c x", [null]],
    ["env -S '-a \"sh\" zsh -c x'", ["sh"]],
    ["env -S \"-a 'sh' zsh -c x\"", ["sh"]],
    ["env -S '-a s\"h\" zsh -c x'", ["sh"]],
    ["env -S '-a ${A} zsh -c x'", [null]],
    ["env -S '-a \"sh zsh'", [null]],
    ["env -S '-a s\\h zsh'", [null]],
  ])("reads %s", (src, expected) => {
    expect(argv0(src)).toEqual(expected);
  });

  it.each([
    ["env -uabc zsh -c x"],
    ["env -Uabc zsh -c x"],
    ["env -L a zsh -c x"],
    ["env -u a zsh -c x"],
    ["env -Sabc zsh -c x"],
    ["env -C a zsh -c x"],
    ["exec zsh -c x"],
    ["git status"],
  ])("finds none in %s", (src) => {
    expect(argv0(src)).toBeUndefined();
  });
});

describe("envSplitWords", () => {
  it("splits on blanks, groups quotes and ends at a word-initial #", () => {
    expect(envSplitWords(`a  "b c" d'e f'g # x`)).toEqual([
      { value: "a", dynamic: false },
      { value: "b c", dynamic: false },
      { value: "de fg", dynamic: false },
    ]);
  });

  it("marks ${NAME} outside single quotes dynamic", () => {
    expect(envSplitWords("${A} '${B}' \"${C}\" $D")).toEqual([
      { value: "${A}", dynamic: true },
      { value: "${B}", dynamic: false },
      { value: "${C}", dynamic: true },
      { value: "$D", dynamic: false },
    ]);
  });

  it.each([['a "b'], ["a 'b"], ["a\\ b"]])("refuses %j", (text) => {
    expect(envSplitWords(text)).toBeNull();
  });
});

const zshOnPath = spawnSync("zsh", ["-f", "-c", "true"]).status === 0;

describe.skipIf(!zshOnPath)("zsh under each argv0 form", () => {
  let scratch = "";
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "argv0-"));
    writeFileSync(join(scratch, "probe.zsh"), "[[ -o globsubst ]] && print on || print off\n");
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const run = (line: string) =>
    spawnSync("zsh", ["-f", "-c", line], { cwd: scratch, encoding: "utf-8", input: "", timeout: 5000 }).stdout.trim();

  it.each([
    ["exec -a =sh zsh -f probe.zsh"],
    [`env -S '-a "sh" zsh -f probe.zsh'`],
    [`env -S "-a 'sh' zsh -f probe.zsh"`],
    [`env -S '-a s"h" zsh -f probe.zsh'`],
  ])("turns GLOB_SUBST on for %s", (line) => {
    expect(run(line)).toBe("on");
  });

  it("leaves GLOB_SUBST off without an sh argv0", () => {
    expect(run("zsh -f probe.zsh")).toBe("off");
  });
});
