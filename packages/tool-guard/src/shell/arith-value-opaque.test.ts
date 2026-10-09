import { describe, expect, it } from "vitest";
import { nodeContext } from "../context.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";

const PUSH = "git push origin HEAD:main";
const SECRET = `X='a[$(${PUSH})]'`;

const port: HookPort = {
  context: nodeContext("/home/you", { realpath: (p) => p, readHead: () => { throw new Error("ENOENT"); }, isFile: () => false }),
  now: () => new Date("2026-01-02T03:04:05.000Z"),
  loadDecide: async () => decide,
};

async function verdict(command: string): Promise<"deny" | "pass"> {
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: "/home/you/projects/app", tool_input: { command } });
  const { stdout } = await handle(input, {}, port);
  return stdout === "" ? "pass" : "deny";
}

const chain = (length: number) => Array.from({ length }, (_, i) => `N${i}=N${i + 1}`).join("; ");

describe("a value arithmetic surely reads that cannot be walked denies through the hook (TP-1624)", () => {
  it.each([
    ["a push before a value that cannot be lexed", `${PUSH}; X='$('; (( X ))`],
    ["a push after a backquote value", `X='\`'; (( X )); ${PUSH}`],
    ["a push after a backquote in a subscript written", `X='a[\`]'; a[X]=1; ${PUSH}`],
    ["a push after an unlexable bash -c in a value", `X='a[$(bash -c "echo \\"")]'; (( X )); ${PUSH}`],
    ["a push in a later value once the budget is spent", `X='a[${"$(:)".repeat(1500)}]'; (( X )); Y='a[$(${PUSH})]'; (( Y ))`],
  ])("denies %s", async (_, command) => {
    expect(await verdict(command)).toBe("deny");
  });

  it("passes a quote-bearing value only a [[ -n ]] names", async () => {
    expect(await verdict(`msg="don't"; [[ -n $msg ]]`)).toBe("pass");
  });
});

describe("a sure read the walk used to skip (TP-1624)", () => {
  it.each([
    ["a chain of twenty names", `${chain(20)}; N20='a[$(${PUSH})]'; (( N0 ))`],
    ["seventeen names and a last link", `${chain(17)}; N17='a[$(${PUSH})]'; (( N0 ))`],
    ["a numeric test after &&", `${SECRET}; [[ 1 -eq 1 && X -gt 0 ]]`],
    ["a numeric test in parentheses", `${SECRET}; [[ ( X -eq 0 ) ]]`],
    ["a declare -i that assigns a name", `${SECRET}; declare -i Y=X`],
    ["a let with the value as a prefix", `X='a[$(${PUSH})]' let X`],
  ])("denies %s", async (_, command) => {
    expect(await verdict(command)).toBe("deny");
  });
});

describe("every place bash evaluates arithmetic reads a value (TP-1624)", () => {
  it.each([
    ["an arithmetic for header", `${SECRET}; for ((i=0; i<X; i++)); do :; done`],
    ["an arithmetic for condition read with >", `${SECRET}; for ((i=9; i>X; i--)); do :; done`],
    ["a bare name in a for header", `${SECRET}; for ((;X;)); do :; done`],
    ["a (( )) that compares with <", `${SECRET}; (( i<X ))`],
    ["a (( )) that compares with >", `${SECRET}; (( X>1 ))`],
    ["an arithmetic for with a split header", `${SECRET}; for ((i=0;\\ni<X;\\ni++)); do :; done`],
  ])("denies a push in a value named in %s", async (_, command) => {
    expect(await verdict(command)).toBe("deny");
  });
});

describe("a value that cannot run anything costs no hop (TP-1624)", () => {
  const plain = (count: number) => Array.from({ length: count }, (_, i) => `v${i}=${i}`).join("; ");
  const sum = (count: number) => Array.from({ length: count }, (_, i) => `v${i}`).join(" + ");

  it.each([16, 17, 40])("passes an arithmetic line over %i plain numbers", async (count) => {
    expect(await verdict(`${plain(count)}; echo $(( ${sum(count)} ))`)).toBe("pass");
  });

  it("passes plain numbers read by a for header and a (( ))", async () => {
    expect(await verdict(`${plain(30)}; for ((i=0; i<v29; i++)); do (( ${sum(30)} )); done`)).toBe("pass");
  });

  it("still denies a push at the end of a chain of twenty names", async () => {
    expect(await verdict(`${chain(20)}; N20='a[$(${PUSH})]'; (( N0 ))`)).toBe("deny");
  });

  it("still denies a push behind plain numbers", async () => {
    expect(await verdict(`${plain(30)}; ${SECRET}; (( ${sum(30)} + X ))`)).toBe("deny");
  });
});
