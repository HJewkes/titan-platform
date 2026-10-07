import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import type { ClassifyContext } from "../types.js";
import { ParseError } from "./lexer.js";

const REPO = "/home/you/projects/app";

const context: ClassifyContext = {
  home: "/home/you",
  readLink: () => null,
  readHead: (dir) => (dir === REPO ? "main" : null),
  readScript: () => null,
};

const PUSH = "git push origin HEAD:main";

function classifyCommand(command: string): string[] {
  const event = { kind: "bash" as const, command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null };
  return classify(event, context).map((a) => a.spelling);
}

/** Pass when the push is seen or the command is refused as unparseable; fail when it is hidden. */
function seesPushOrFailsClosed(command: string): boolean {
  try {
    return classifyCommand(command).includes("bash.merge.git-push-protected");
  } catch (error) {
    return error instanceof ParseError;
  }
}

describe("a heredoc opened inside a process substitution", () => {
  it.each([
    ["<((cat <<EOF) )", "cat <((cat <<EOF) )"],
    [">((cat <<EOF) )", "cat >((cat <<EOF) )"],
    ["<( (cat <<EOF) )", "cat <( (cat <<EOF) )"],
    ["<(cat <<EOF)", "cat <(cat <<EOF)"],
    [">(cat <<EOF)", "cat >(cat <<EOF)"],
  ])("does not let a quote in the body of %s hide the push", (_form, opener) => {
    const command = `${opener}\nit's\nEOF\n${PUSH}\necho \\'`;
    expect(seesPushOrFailsClosed(command)).toBe(true);
  });

  it("does not hide a push written in the body of a heredoc fed to a shell", () => {
    expect(seesPushOrFailsClosed(`bash <(cat <<EOF)\n${PUSH}\nEOF\n`)).toBe(true);
  });

  it("keeps a heredoc whose body is inside the substitution", () => {
    expect(classifyCommand(`cat <(cat <<EOF\nbody\nEOF\n)\n${PUSH}`)).toContain("bash.merge.git-push-protected");
  });

  it("still reads a real arithmetic shift as a shift", () => {
    expect(classifyCommand(`(( x << 2 ))\n${PUSH}`)).toContain("bash.merge.git-push-protected");
  });
});
