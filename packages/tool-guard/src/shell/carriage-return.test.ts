import { describe, expect, it } from "vitest";
import type { ClassifyContext } from "../types.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import { type RedirectToken, tokenize } from "./lexer.js";

const REPO = "/home/you/projects/app";

const context: ClassifyContext = {
  home: "/home/you",
  readLink: () => null,
  readHead: (dir) => (dir === REPO ? "main" : null),
  readScript: () => null,
};

const PUSH = "git push origin HEAD:main";
const CRLF_HEREDOC = `cat <<-E\r\n\tE\r\n${PUSH};\r\nE\r`;

/** The hook's own verdict, which is what the agent meets: a ParseError denies. */
async function hookDenies(command: string): Promise<boolean> {
  const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
  const result = await handle(input, { PATH: "/usr/bin" }, port);
  return result.stdout !== "";
}

// Bash splits words only on space and tab, so a CR stays inside the word that precedes it.
describe("a carriage return in a command", () => {
  it("keeps a following # inside the word instead of starting a comment", () => {
    const tokens = tokenize(`echo x\r#; ${PUSH}`).map((t) => (t.type === "word" || t.type === "op" ? t.value : t.type));

    expect(tokens).toEqual(["echo", "x\r#", ";", "git", "push", "origin", "HEAD:main"]);
  });

  it.each([
    ["a push", `echo x\r#; ${PUSH}`],
    ["a merge", "echo x\r#; gh pr merge 1 --squash"],
    ["a push after a CRLF heredoc", CRLF_HEREDOC],
  ])("does not let a CR hide %s", async (_form, command) => {
    expect(await hookDenies(command)).toBe(true);
  });

  it("keeps the CR in a heredoc delimiter so the body ends where bash ends it", () => {
    const heredoc = tokenize(CRLF_HEREDOC).find((t): t is RedirectToken => t.type === "redirect");

    expect(heredoc).toMatchObject({ op: "<<-", target: { value: "E\r" }, body: "" });
  });

  it("does not deny a harmless command that ends in a CR", async () => {
    expect(await hookDenies("git status\r")).toBe(false);
  });
});
