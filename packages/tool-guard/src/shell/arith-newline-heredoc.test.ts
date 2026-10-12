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

async function hookDenies(command: string): Promise<boolean> {
  const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
  const result = await handle(input, { PATH: "/usr/bin" }, port);
  return result.stdout !== "";
}

describe("a newline inside an arithmetic command while a heredoc waits", () => {
  it.each([
    ["(( ))", `: <<E; (( 1\n)); ${PUSH}\nE`],
    ["for (( ))", `: <<E; for (( i=0;\ni<0; )); do :; done; ${PUSH}\nE`],
    ["for (( ;; )) with newlines around every clause", `: <<E; for ((\n;\n0;\n)); do :; done; ${PUSH}\nE`],
    ["a subscript in (( ))", `: <<E; (( a[\n1] )); ${PUSH}\nE`],
    ["(( )) inside a loose subscript", `: <<E; a[ ((1\n)) ]=1; ${PUSH}\nE`],
    ["(( )) after cat", `cat <<E; (( 1\n)); ${PUSH}\nE`],
    ["(( )) after a tab-stripping heredoc", `: <<-E; (( 1\n)); ${PUSH}\n\tE`],
    ["(( )) after a quoted delimiter", `: <<"E"; (( 1\n)); ${PUSH}\nE`],
    ["(( )) after two heredocs", `: <<E <<F; (( 1\n)); ${PUSH}\nE\nF`],
    ["(( )) after &&", `: <<E && (( 1\n)) && ${PUSH}\nE`],
    ["(( )) after a pipe", `: <<E | (( 1\n)); ${PUSH}\nE`],
    ["(( )) holding two newlines", `: <<E; (( 1\n\n)); ${PUSH}\nE`],
    ["(( )) holding CR LF", `: <<E; (( 1\r\n)); ${PUSH}\nE`],
    ["(( )) holding nested parentheses", `: <<E; (( (1\n) )); ${PUSH}\nE`],
    ["(( )) as an if condition", `: <<E; if (( 1\n)); then ${PUSH}; fi\nE`],
    ["(( )) as a while condition", `: <<E; while (( 0\n)); do :; done; ${PUSH}\nE`],
    ["(( )) in a group", `: <<E; { (( 1\n)); }; ${PUSH}\nE`],
    ["(( )) before a protected merge", `: <<E; (( 1\n)); gh pr merge 1 --squash\nE`],
  ])("the hook denies a push bash runs after %s", async (_name, command) => {
    expect(await hookDenies(command)).toBe(true);
  });

  it.each([
    ["(( ) ) before &&", `: <<E; ((true\n) ) && ${PUSH}\nE`],
    ["(( )| )", `: <<E; ((true\n)|${PUSH})\nE`],
    ["(( ) ) as an if condition", `: <<E; if ((true\n) ); then ${PUSH}; fi\nE`],
    ["(( ) ) before ;", `: <<E; ((true\n) ); ${PUSH}\nE`],
    ["(( ) ) holding two commands", `: <<E; ((echo a\necho b) ); ${PUSH}\nE`],
    ["a heredoc opened inside (( ) )", `((cat <<EOFX\n) ); ${PUSH}\nEOFX`],
  ])("the hook denies a push bash runs after a newline in %s, which bash reparses as subshells", async (_name, command) => {
    expect(await hookDenies(command)).toBe(true);
  });

  it.each([
    ["$(( ))", `: <<E; echo $(( 1\n)); ${PUSH}\nE`],
    ["$(( )) in a for (( ))", `: <<E; for (( i=$((0\n)); i<0; )); do :; done; ${PUSH}\nE`],
    ["$[ ]", `: <<E; echo $[ 1\n]; ${PUSH}\nE`],
    ["$(( )) inside (( ))", `: <<E; (( $((1\n)) )); ${PUSH}\nE`],
  ])("the hook still denies a push bash runs after %s", async (_name, command) => {
    expect(await hookDenies(command)).toBe(true);
  });
});

describe("where a heredoc's body starts after a multi-line arithmetic command", () => {
  it.each([
    ["(( ))", "cat <<E; (( 1\n))\nbody\nE"],
    ["for (( ;; ))", "cat <<E; for ((\n;\n0;\n)); do :; done\nbody\nE"],
    ["(( )) holding $(( ))", "cat <<E; (( $((1\n)) ))\nbody\nE"],
    ["(( ) ), which bash reparses as subshells", "cat <<E; ((true\n) )\nbody\nE"],
    ["(( ) ) that opened the heredoc", "((cat <<E\n) )\nbody\nE"],
  ])("reads the body from the line after %s closes", (_name, command) => {
    const heredoc = tokenize(command).find((t): t is RedirectToken => t.type === "redirect");
    expect(heredoc).toMatchObject({ op: "<<", target: { value: "E" }, body: "body\n" });
  });
});

describe("valid multi-line arithmetic", () => {
  it.each([
    ["(( )) over two lines", "x=0\n(( x +=\n1 ))\necho $x"],
    ["for (( ;; )) over three lines", "for (( i=0;\ni<2;\ni++ )); do echo $i; done"],
    ["$(( )) over two lines", "echo $(( 1 +\n2 ))"],
    ["(( )) over two lines before a heredoc's body", "cat <<E; (( 1\n)); echo ok\nbody\nE"],
    ["a push written in a heredoc body after (( ))", `cat <<E; (( 1\n))\n${PUSH}\nE`],
    ["for (( )) before a heredoc's body", "cat <<E; for (( i=0;\ni<1; i++ )); do :; done\nbody\nE"],
  ])("the hook passes %s", async (_name, command) => {
    expect(await hookDenies(command)).toBe(false);
  });
});
