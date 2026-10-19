import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeContext } from "../context.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";

const home = mkdtempSync(join(tmpdir(), "tool-guard-arith-paren-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

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

// zsh reads `$(( … ))` as `$( ( … ) )` when a quote in the body holds a paren, so it runs the body as a command.
describe("a quoted paren in $(( ))", () => {
  it.each([
    ["a single-quoted close paren", "echo $(( git push origin HEAD:main ')' ))"],
    ["a double-quoted open paren", `echo $(( git push origin HEAD:main "(" ))`],
    ["an ANSI-C close paren", "echo $(( git push origin HEAD:main $')' ))"],
    ["inside double quotes", `echo "$(( git push origin HEAD:main ')' ))"`],
    ["an assignment value", "x=$(( git push origin HEAD:main ')' ))"],
    ["a backquote holding a case arm", "echo $(( git push origin HEAD:main `case a in a) ;; esac` ))"],
    ["a backquote holding a quoted paren", "echo $(( git push origin HEAD:main `echo ')'` ))"],
    ["a backquote in an assignment", "x=$(( git push origin HEAD:main `case a in a) ;; esac` ))"],
    ["a backquote inside double quotes", 'echo "$(( git push origin HEAD:main `case a in a) ;; esac` ))"'],
    ["a locale string holding a paren", 'echo $(( git push origin HEAD:main $"(" ))'],
    ["a span only the command reading reaches, past a comment", `echo $(( true; ] #))'\necho $(( git push origin HEAD:main "(" )) #' "\n)) #"`],
    ["a heredoc body", "cat <<EOF\n$(( git push origin HEAD:main `case a in a) ;; esac` ))\nEOF"],
    ["a comment holding a paren", "echo $(( git push origin HEAD:main #)\n ))"],
    ["a lone close paren across a newline", "echo $(( git push origin HEAD:main )\n( ))"],
  ])("denies %s", async (_name, command) => {
    expect(await handled(command.replaceAll("\\n", "\n"))).toBe("deny");
  });

  it.each([["plain arithmetic", "echo $(( 1 + 2 ))"], ["a subscript", "echo $(( a[1] ))"], ["double-quoted arithmetic", `echo "$(( x ))"`], ["arithmetic across a newline", "echo $(( 1 +\\n 2 ))"], ["a variable", "echo $(( $a + 1 ))"], ["a braced name", "echo $(( ${a} + 1 ))"], ["a braced length", "echo $(( ${#a} + 1 ))"], ["a braced length in an assignment", "x=$(( ${#s} * 2 ))"]])(
    "passes %s",
    async (_name, command) => {
      expect(await handled(command.replaceAll("\\n", "\n"))).toBe("pass");
    },
  );

  // The unbounded readings this guards against take ten seconds or run out of memory; slow CI runners need the slack.
  const BOUNDED_MS = 2000;

  it.each([
    ["at the limit", 4, "pass"],
    ["past the limit", 5, "deny"],
    ["far past the limit", 24, "deny"],
  ] as const)("reads quoted-paren arithmetic nested %s (%i deep) in bounded time and %ss it", async (_name, depth, verdict) => {
    let body = `x${" + 1".repeat(1000)}`;
    for (let i = 0; i < depth; i++) body = `$(( '(' ${body} ))`;
    const started = Date.now();
    expect(await handled(`echo ${body}`)).toBe(verdict);
    expect(Date.now() - started).toBeLessThan(BOUNDED_MS);
  });

  // A heredoc body, a backquote or a quoted span is lexed with trials of its own, which must not restart the count.
  const throughHeredoc = (body: string, i: number): string => `$(( '(' $(cat <<E${i}\n${body}\nE${i}\n) ))`;
  const throughBackquote = (body: string): string => `$(( '(' \`echo ${body.replaceAll("\\", "\\\\").replaceAll("`", "\\`")}\` ))`;
  const throughQuotes = (body: string): string => `$(( '(' "${body.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" ))`;
  it.each([
    ["a heredoc", 5, throughHeredoc],
    ["a heredoc", 22, throughHeredoc],
    ["a backquote", 5, throughBackquote],
    ["a backquote", 12, throughBackquote],
    ["double quotes", 5, throughQuotes],
    ["double quotes", 22, throughQuotes],
  ] as const)("refuses quoted-paren arithmetic nested through %s, %i deep, in bounded time", async (_name, depth, wrap) => {
    let body = "true";
    for (let i = 0; i < depth; i++) body = wrap(body, i);
    const started = Date.now();
    expect(await handled(`echo ${body}`)).toBe("deny");
    expect(Date.now() - started).toBeLessThan(BOUNDED_MS);
  });

  it.each([
    ["a heredoc", throughHeredoc],
    ["a backquote", throughBackquote],
    ["double quotes", throughQuotes],
  ] as const)("reads quoted-paren arithmetic nested through %s at the limit", async (_name, wrap) => {
    let body = "true";
    for (let i = 0; i < 4; i++) body = wrap(body, i);
    expect(await handled(`echo ${body}`)).toBe("pass");
  });
});

// A nested span holding only plain text, a defaulted or subscripted length, or a base number hides no paren.
describe("plain spans and words in a $(( )) body", () => {
  it.each([
    ["a command substitution", "echo $(( $(date +%s) - $start ))"],
    ["a command substitution with a redirect", "echo $(( $(wc -l < f) - $n ))"],
    ["a backquote", "echo $(( `date +%s` - $start ))"],
    ["nested arithmetic", "echo $(( $(( a + 1 )) * $b ))"],
    ["arithmetic nested in a command substitution", "echo $(( $(echo $(( a + 1 ))) * $b ))"],
    ["a defaulted name", "echo $(( ${start:-0} - $n ))"],
    ["an array length", "echo $(( ${#files[@]} * 2 ))"],
    ["a base number", "echo $(( 16#ff ))"],
  ])("passes %s", async (_name, command) => {
    expect(await handled(command)).toBe("pass");
  });

  it.each([
    ["a command substitution holding a quoted paren", "echo $(( git push origin HEAD:main $(echo ')') ))"],
    ["a command substitution holding a separator", "echo $(( git push origin HEAD:main $(true; true) ))"],
    ["a backquote holding a comment", "echo $(( git push origin HEAD:main `true #` ))"],
    ["a default holding a quoted paren", "echo $(( git push origin HEAD:main ${x:-')'} ))"],  ])("denies %s", async (_name, command) => {
    expect(await handled(command.replaceAll("\\n", "\n"))).toBe("deny");
  });
});

// A character is safe in a body when no shell can read it as hiding a paren; every other one makes zsh (and for some
// bash) read `$(( … ))` as `$( ( … ) )`, so the command in the body must be walked.
const SAFE = new Set("_+-*/%<>=!&|^~?:,.$");
const PUNCTUATION = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i))].filter((c) => /[^\w\s()[\]]/.test(c));

describe("a punctuation character in a $(( )) body", () => {
  it.each(PUNCTUATION.map((c) => [c]))("%s decides the reading as the safe set says", async (c) => {
    const verdict = SAFE.has(c) ? "pass" : "deny";
    expect(await handled(`echo $(( git push origin HEAD:main ${c} ))`)).toBe(verdict);
    expect(await handled(`echo $(( ( git push origin HEAD:main ${c} ) ))`)).toBe(verdict);
  });
});

// zsh also reads a body with an unbalanced bracket as a command; balanced brackets stay math.
describe("brackets in a $(( )) body", () => {
  it.each([
    ["an open bracket after a semicolon", "echo $(( git push origin HEAD:main; [ ))"],
    ["a close bracket after a semicolon", "echo $(( git push origin HEAD:main; ] ))"],
    ["a close then an open bracket", "echo $(( git push origin HEAD:main ][ ))"],
    ["an open bracket on a name", "echo $(( git push origin HEAD:main a[ ))"],
    ["an unclosed subscript", "echo $(( git push origin HEAD:main a[1 ))"],
    ["an unbalanced bracket without a separator", "echo $(( git push origin HEAD:main [ ))"],
    ["an assignment value", "x=$(( git push origin HEAD:main; [ ))"],
    ["double quotes", 'echo "$(( git push origin HEAD:main; [ ))"'],
    ["a ${ } default", "echo ${x:-$(( git push origin HEAD:main; [ ))}"],
    ["a heredoc body", "cat <<EOF\n$(( git push origin HEAD:main; [ ))\nEOF"],
  ])("denies %s", async (_name, command) => {
    expect(await handled(command.replaceAll("\\n", "\n"))).toBe("deny");
  });

  it.each([["balanced brackets", "echo $(( a[1] + b[2] ))"], ["a double bracket", "echo $(( [[ 1 ]] ))"]])("passes %s", async (_name, command) => {
    expect(await handled(command)).toBe("pass");
  });
});
