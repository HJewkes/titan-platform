import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeContext } from "../context.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import { extractCommands } from "./commands.js";

const home = mkdtempSync(join(tmpdir(), "tool-guard-arith-quote-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const PUSH = "git push origin HEAD:main";

const port: HookPort = {
  context: nodeContext(home, { realpath: (p) => p, readHead: () => { throw new Error("ENOENT"); }, isFile: () => false }),
  now: () => new Date("2026-01-02T03:04:05.000Z"),
  loadDecide: async () => decide,
};

async function handled(command: string): Promise<"deny" | "pass"> {
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: home, tool_input: { command } });
  const { stdout } = await handle(input, {}, port);
  return stdout === "" ? "pass" : "deny";
}

const names = (src: string): string[] => extractCommands(src).map((c) => [c.name, ...c.args.map((a) => a.value)].join(" "));

// bash and zsh expand an arithmetic body as if it were double-quoted, so a single quote there is a literal character.
const HIDDEN: [string, string][] = [
  ["a single-quoted $( ) in (( ))", `(( '$(${PUSH})' ))`],
  ["a single-quoted backtick in (( ))", `(( '\`${PUSH}\`' ))`],
  ["a single-quoted $( ) in $(( ))", `$(( '$(${PUSH})' ))`],
  ["a single-quoted $( ) in an assignment inside (( ))", `((x='$(${PUSH})'))`],
  ["a single-quoted $( ) holding its own quotes", `(( '$(${PUSH} 'a')' ))`],
  ["a single-quoted $( ) after other text", `(( 1 + '$(${PUSH})' ))`],
  ["a single-quoted $( ) in a for ((;;))", `for (('$(${PUSH})'; 0; )); do :; done`],
  ["an ANSI-C $'' $( ) in (( ))", `(( $'$(${PUSH})' ))`],
  ["an ANSI-C $'' backtick in (( ))", `(( $'\`${PUSH}\`' ))`],
  ["an ANSI-C $'' $( ) in an assignment inside (( ))", `((x=$'$(${PUSH})'))`],
  ["an ANSI-C $'' $( ) in a for ((;;))", `for ((;$'$(${PUSH})';)); do :; done`],
  ["an ANSI-C $'' $( ) in $(( ))", `$(( $'$(${PUSH})' ))`],
  ["a locale $\"\" $( ) in (( ))", `(( $"$(${PUSH})" ))`],
  ["a '$' then an ANSI-C $( ) in $(( ))", `$(( '$'$'$(${PUSH})' ))`],
  ["a '$' + an ANSI-C $( ) in $(( ))", `$(( '$' + $'$(${PUSH})' ))`],
  ["a \"$'\" + an ANSI-C $( ) in $(( ))", `$(( "$'" + $'$(${PUSH})' ))`],
  ["a subscript holding '$' + an ANSI-C $( ) in $(( ))", `$(( a['$'] + $'$(${PUSH})' ))`],
  ["an ANSI-C $( ) in a ${:-} inside (( ))", `(( \${x:-$'$(${PUSH})'} ))`],
  ["an ANSI-C $( ) in a quoted ${:-} inside (( ))", `(( "\${x:-$'$(${PUSH})'}" ))`],
  ["an ANSI-C $( ) in a quoted ${:-} outside arithmetic", `echo "\${x:-$'$(${PUSH})'}"`],
  ["an ANSI-C $( ) after an escaped quote", `(( $'\\'$(${PUSH})' ))`],
  ["an ANSI-C $( ) after a hex quote", `(( $'\\x27$(${PUSH})' ))`],
];

describe("a single-quoted command substitution in arithmetic runs (TP-3290)", () => {
  it.each(HIDDEN)("denies %s", async (_, src) => {
    expect(await handled(src)).toBe("deny");
  });

  it.each(HIDDEN)("extracts git push from %s", (_, src) => {
    expect(names(src).some((n) => n.startsWith(PUSH))).toBe(true);
  });

  it.each([
    ["an ANSI-C $( ) in $[ ]", `x=$[ $'$(${PUSH})' ]`],
    ["an ANSI-C backtick in $[ ]", `x=$[ $'\`${PUSH}\`' ]`],
  ])("denies %s", async (_, src) => {
    expect(await handled(src)).toBe("deny");
  });

  it("denies the older $[ ] spelling", async () => {
    const src = `x=$[ '$(${PUSH})' ]`;
    expect(await handled(src)).toBe("deny");
  });

  it("leaves a double-quoted substitution in (( )) denied", async () => {
    expect(await handled(`(( "$(${PUSH})" ))`)).toBe("deny");
  });

  it("keeps a parenthesis inside the quotes from closing the arithmetic", () => {
    expect(names("(( ')' )); echo after")).toContain("echo after");
  });
});

describe("single quotes outside arithmetic keep their reading (TP-3290)", () => {
  it.each([
    [`echo '$(${PUSH})'`],
    [`echo x '$(${PUSH})' y`],
    [`x='$(${PUSH})'; (( 1 ))`],
    [`(( 1 )); echo '$(${PUSH})'`],
    [`echo $'$(${PUSH})'`],
  ])("allows %s", async (src) => {
    expect(await handled(src)).toBe("pass");
    expect(names(src)).not.toContain(PUSH);
  });
});

describe("ANSI-C quoting outside arithmetic keeps its reading (TP-3290)", () => {
  it("decodes $'\\n' to a newline", () => {
    expect(extractCommands("echo $'a\\nb'")[0]?.args[0]?.value).toBe("a\nb");
  });
});

describe("the end of (( )) is found with bash's rule, which takes a quote whole (TP-3290)", () => {
  it.each([
    ["on three lines", `(( '$(' ))\n${PUSH}\n: ')' ))`],
    ["on one line", `(( '$(' )); ${PUSH}; : ')' ))`],
    ["with an ANSI-C quote", `(( $'$(' ))\n${PUSH}\n: ')' ))`],
    ["with an ANSI-C quote on one line", `(( $'$(' )); ${PUSH}; : ')' ))`],
  ])("denies the push after a span holding an open $( %s", async (_, src) => {
    expect(await handled(src)).toBe("deny");
  });
});
