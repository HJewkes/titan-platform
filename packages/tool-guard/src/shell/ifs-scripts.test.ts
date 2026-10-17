import { describe, expect, it } from "vitest";
import { extractCommands } from "./commands.js";
import { scriptsOf } from "./ifs-scripts.js";
import { tokenLists } from "./startup-file.js";
import { tokenize } from "./lexer.js";

const W = "R=origin,HEAD:main; for i in 1 2; do git push $R; declare $a$b=,; done";
const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

const LINES = [
  `bash -c ${q(W)}`,
  `sh -c ${q(W)}`,
  `bash <<'EOF'\n${W}\nEOF`,
  `bash <<< ${q(W)}`,
  `echo ${q(W)} | bash`,
  `echo ${q(W)} | tee log | bash`,
  `{ echo ${q(W)}; } | bash`,
  `(echo ${q(W)}) | bash`,
  `printf '%s' ${q(W)} | xargs -0 sh -c`,
  `sudo -u x bash -c ${q(W)}`,
  `timeout 5 env A=1 sh -c ${q(W)}`,
  `find . -exec bash -c ${q(W)} \\;`,
  `find -execdir sh -c ${q(W)} {} +`,
  `bash -c "$(printf %s ${q(W)})"`,
  `eval ${q(W)}`,
  `eval eval ${q(q(W))}`,
  `x=$(bash -c ${q(W)})`,
  `bash -c ${q(`sh -c ${q(W)}`)}`,
];

/** Every script text the walk reads, nested scripts included. */
function walkScripts(line: string): string[] {
  const texts: string[] = [];
  extractCommands(line, { cwd: "/home/you/app", home: "/home/you", onScript: (text) => texts.push(text) });
  return texts;
}

/** Every script scriptsOf finds in the line and, in turn, in each script it finds. */
function matcherScripts(line: string): string[] {
  const found: string[] = [];
  const visit = (text: string) => {
    for (const list of tokenLists(tokenize(text))) {
      for (const script of scriptsOf(list, text.length).texts.filter((t) => !found.includes(t))) {
        found.push(script);
        visit(script);
      }
    }
  };
  visit(line);
  return found;
}

describe("scriptsOf covers every script the walk runs", () => {
  it.each(LINES)("%s", (line) => {
    const walkTexts = walkScripts(line);
    const matcherTexts = matcherScripts(line);

    expect(walkTexts.length).toBeGreaterThan(0);
    for (const text of walkTexts) expect(matcherTexts.some((m) => m.includes(text))).toBe(true);
  });
});

describe("a shell running a descriptor the line cannot show (TP-3241)", () => {
  it.each(["bash < $F", "bash /dev/stdin <&3", "sh /dev/fd/3"])("reads %s as a run-time script", (line) => {
    expect(scriptsOf(tokenize(line), line.length).runTime).toBe(true);
  });

  it.each(["bash < ./x.sh", "bash -c 'echo hi' < $F", "bash /dev/fd/3 3< ./x.sh"])("reads %s as no run-time script", (line) => {
    expect(scriptsOf(tokenize(line), line.length).runTime).toBe(false);
  });
});
