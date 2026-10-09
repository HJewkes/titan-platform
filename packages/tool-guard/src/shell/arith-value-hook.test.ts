import { describe, expect, it } from "vitest";
import { nodeContext } from "../context.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";
const PUSH = "git push origin HEAD:main";
// A line the guard cannot parse denies only when it names something guarded, and a push is not named.
const MERGE = "gh pr merge 1";

const port: HookPort = {
  context: nodeContext(HOME, {
    realpath: (p) => p,
    readHead: () => {
      throw new Error("ENOENT");
    },
    isFile: () => false,
  }),
  now: () => new Date("2026-01-02T03:04:05.000Z"),
  loadDecide: async () => decide,
};

async function verdict(command: string): Promise<"deny" | "pass"> {
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
  const { stdout } = await handle(input, {}, port);
  return stdout === "" ? "pass" : "deny";
}

describe("the hook verdict on a value that arithmetic reads (TP-1624)", () => {
  it("denies a push after a quote-bearing value named in a [[ ]]", async () => {
    expect(await verdict(`msg="don't"; [[ -n $msg ]] && ${PUSH}`)).toBe("deny");
  });

  it("denies a push after a quote-bearing value named in a (( )) and in a let", async () => {
    expect(await verdict(`msg="don't"; (( msg )); ${MERGE}`)).toBe("deny");
    expect(await verdict(`t='\`'; let t; ${MERGE}`)).toBe("deny");
  });

  it("passes a benign line whose value holds a quote", async () => {
    expect(await verdict(`msg="don't publish"; [[ -n $msg ]]`)).toBe("pass");
  });

  it("denies a push after a value that holds many substitutions read again and again", async () => {
    const value = `X='a[${"$(echo 1)".repeat(200)}]'`;
    const command = `${value}${";a[X]=1".repeat(800)}; ${MERGE}`;
    const started = performance.now();

    const result = await verdict(command);

    expect(result).toBe("deny");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("denies a merge when a variable the value uses changes before every read", async () => {
    const head = `X='a[${"$(echo $C)".repeat(150)}]'`;
    const reads = Array.from({ length: 450 }, (_, i) => `;C=${i};a[X]=1`).join("");
    const started = performance.now();

    const result = await verdict(`${head}${reads}; ${MERGE}`);

    expect(result).toBe("deny");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("denies a push hidden in a value that also holds an unbalanced quote", async () => {
    expect(await verdict(`X="it's a[\\$(${PUSH})]"; (( X ))`)).toBe("deny");
  });

  it.each([
    ["bash -c", `X='a[$(bash -c "echo \\"")]'; (( X )); ${MERGE}`],
    ["eval", `X='a[$(eval "echo \\"")]'; (( X )); ${MERGE}`],
    ["sh -c", `X='a[$(sh -c "a=\\$(")]'; (( X )); ${MERGE}`],
    ["a here-string to bash", `X='a[$(bash <<<"echo \\"")]'; (( X )); ${MERGE}`],
    ["find -exec bash -c", `X='a[$(find . -exec bash -c "echo \\"" \\;)]'; (( X )); ${MERGE}`],
    ["a bash -c inside an unlexable value", `X="it's a[\\$(bash -c \\"echo \\\\\\"\\")]"; (( X )); ${MERGE}`],
  ])("denies a later push when the value holds %s that cannot be lexed", async (_, command) => {
    expect(await verdict(command)).toBe("deny");
  });
});

describe("the hook verdict when the walk of a value cannot finish (TP-1624)", () => {
  it.each([
    ["a push after an unlexable bash -c", `X='a[$(bash -c "echo \\""; ${MERGE})]'; (( X ))`],
    ["a push on the first line of a bash -c that then fails to lex", `X='a[$(bash -c $'${MERGE}\\necho "')]'; (( X ))`],
    ["a push in a later value after a substitution budget is spent", `X='a[${"$(:)".repeat(1500)}]'; (( X )); Y='a[$(${MERGE})]'; (( Y ))`],
    ["an unlexable value read by let", `X='a[$(bash -c "echo \\""; ${MERGE})]'; let X`],
    ["an unlexable value read by a [[ -eq ]]", `X='a[$(bash -c "echo \\""; ${MERGE})]'; [[ X -eq 1 ]]`],
  ])("refuses %s", async (_, command) => {
    expect(await verdict(command)).toBe("deny");
  });

  it("still passes names that arithmetic only maybe reads", async () => {
    expect(await verdict(`msg="don't"; [[ -n $msg ]]`)).toBe("pass");
  });
});
