import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import type { ClassifyContext } from "../types.js";
import { type RedirectToken, tokenize } from "./lexer.js";

const REPO = "/home/you/projects/app";

const context: ClassifyContext = {
  home: "/home/you",
  readLink: () => null,
  readHead: (dir) => (dir === REPO ? "feat/x" : null),
  readScript: () => null,
};

function spellings(command: string): string[] {
  const event = { kind: "bash" as const, command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null };
  return classify(event, context).map((a) => a.spelling);
}

function redirects(command: string): RedirectToken[] {
  return tokenize(command).filter((t): t is RedirectToken => t.type === "redirect");
}

const PUSH = "git push origin HEAD:main";

describe("a shift operator inside an arithmetic context", () => {
  it.each([
    ["a shift in an arithmetic command", `(( Y<<1 ))\n${PUSH}`],
    ["a shift-assign in an arithmetic command", `(( Y<<=1 ))\n${PUSH}`],
    ["a shift with no blanks around it", `((Y<<1))\n${PUSH}`],
    ["a shift after &&", `true && (( Y<<1 ))\n${PUSH}`],
    ["a shift after if", `if (( Y<<1 )); then :; fi\n${PUSH}`],
    ["a shift in parentheses inside the command", `(( (Y<<1) ))\n${PUSH}`],
    ["a shift in an arithmetic command inside $(...)", `echo $( (( Y<<1 )) )\n${PUSH}`],
    ["a shift in an arithmetic expansion", `echo $(( 1<<2 ))\n${PUSH}`],
    ["a shift-assign in an arithmetic expansion", `echo $(( Y<<=2 ))\n${PUSH}`],
  ])("does not hide the next line's push behind %s", (_how, command) => {
    expect(spellings(command)).toContain("bash.merge.git-push-protected");
  });

  it("makes no redirect for the shift", () => {
    expect(redirects("(( Y<<1 ))")).toEqual([]);
  });
});

describe("a heredoc next to an arithmetic context", () => {
  it("keeps the body of a heredoc after the arithmetic command closes", () => {
    const [heredoc] = redirects("(( 1 )) && cat <<EOF\nx\nEOF");
    expect(heredoc).toMatchObject({ op: "<<", target: { value: "EOF" }, body: "x\n" });
  });

  it("keeps the body of a heredoc after an arithmetic expansion", () => {
    const [heredoc] = redirects("echo $(( 1<<2 )) <<EOF\nx\nEOF");
    expect(heredoc).toMatchObject({ op: "<<", target: { value: "EOF" }, body: "x\n" });
  });

  it.each([
    ["a subshell", "( cat <<EOF\nx\nEOF\n)"],
    ["nested subshells that open with ((", "((cat <<EOF) )\nx\nEOF"],
  ])("keeps the body of a heredoc inside %s", (_how, command) => {
    const [heredoc] = redirects(command);
    expect(heredoc).toMatchObject({ op: "<<", target: { value: "EOF" }, body: "x\n" });
  });

  it("still sees a push after a heredoc in nested subshells that open with ((", () => {
    expect(spellings(`((cat <<EOF) )\n'\nEOF\n${PUSH} #'`)).toContain("bash.merge.git-push-protected");
  });
});
