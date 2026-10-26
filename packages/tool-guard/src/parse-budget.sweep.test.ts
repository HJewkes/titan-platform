import { describe, expect, it } from "vitest";
import { nodeContext } from "./context.js";
import type { ReadFs } from "./context.js";
import { decide } from "./decide.js";
import { handle, MAX_COMMAND_BYTES } from "./hook.js";
import type { HookPort } from "./hook.js";
import { SPELLINGS } from "./spellings.js";
import type { FamilyName } from "./spellings.js";
import { cpuBudgetIt } from "./test-support/cpu-budget.js";
import { bashEvent, withinParseBudget } from "./test-support/parse-budget.js";
import type { HookRun } from "./test-support/parse-budget.js";

const HOME = "/home/you";
const DEPTH = 8;
const PAD = "echo hi;";
// The helper's work cap holds under pnpm test: the worst case, a sentinel inside sh-c, reads 808 characters a byte
// (TP-4047). Its 500 ms default holds under the bench: that row took 55 to 67 ms of CPU locally and 250.5 to 259.4 ms on
// CI (2026-10-21, TP-3898).
// Each test also pads its line to the cap; the slowest took 0.5 s of wall time on a green CI run.
const TEST_CPU_MS = 2_000;

const noFs: ReadFs = {
  realpath: () => {
    throw new Error("ENOENT");
  },
  readHead: () => {
    throw new Error("ENOENT");
  },
  isFile: () => false,
};
const port: HookPort = { context: nodeContext(HOME, noFs), now: () => new Date(0), loadDecide: async () => decide };
const run: HookRun = (input) => handle(input, {}, port);

/** One command per guarded family that the hook denies on its own, taken from that family's tests. */
const SENTINELS: Record<FamilyName, string> = {
  secret: "cat ~/.npmrc",
  config: "echo x >> ~/.claude/settings.local.json",
  merge: "git push origin HEAD:main",
  release: "npm publish",
  egress: "gh gist create notes.md --public",
};

type Shape = (inner: string, depth: number) => string;

/** Text quoted for the inside of a double-quoted word. */
const quoted = (text: string) => text.replace(/[\\"$`]/g, (c) => `\\${c}`);

const nestWith =
  (wrap: (body: string, level: number) => string): Shape =>
  (inner, depth) => {
    let body = inner;
    for (let level = 1; level <= depth; level++) body = wrap(body, level);
    return body;
  };

const cmdSubst = nestWith((body) => `echo "$(${body})"`);
const substValue = (inner: string, depth: number) => `${"$(".repeat(depth)}${inner}${")".repeat(depth)}`;

const SHAPES: Record<string, Shape> = {
  "eval-splice": nestWith((body) => `eval "$(echo :);${quoted(body)}"`),
  "cmd-subst": cmdSubst,
  "sh-c": nestWith((body) => `bash -c "${quoted(body)}"`),
  group: nestWith((body, level) => (level % 2 === 1 ? `( ${body} )` : `{ ${body}; }`)),
  "if-compound": nestWith((body) => `if true; then ${body}; fi`),
  "heredoc-shell": (inner, depth) => `bash <<'E'\n${cmdSubst(inner, depth)}\nE\n`,
  "xargs-sh-c": nestWith((body) => `echo x | xargs sh -c "${quoted(body)}"`),
  procsub: nestWith((body) => `cat <(${body})`),
  "arith-subscript": (inner, depth) => `a='x[${substValue(inner, depth)}]'; let a`,
};

/** The shape at `DEPTH` around `inner`, padded with benign commands to as close under the size cap as it gets. */
function padToCeiling(shape: Shape, inner: string): string {
  const build = (k: number) => shape(`${PAD.repeat(k)}${inner}`, DEPTH);
  const fits = (k: number) => Buffer.byteLength(build(k)) <= MAX_COMMAND_BYTES;
  let low = 0;
  let high = MAX_COMMAND_BYTES;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return build(low);
}

const sentinels = Object.entries(SENTINELS);
const shapes = Object.entries(SHAPES);
const grid = sentinels.flatMap(([family, sentinel]) => shapes.map(([name, shape]) => [family, name, shape, sentinel] as const));

describe("every guarded family's sentinel", () => {
  cpuBudgetIt.each(sentinels)("%s denies on its own", TEST_CPU_MS, async (_family, sentinel) => {
    const { problems } = await withinParseBudget(run, sentinel, { mustDeny: true });

    expect(problems).toEqual([]);
  });

  it("covers every family the classifier spells", () => {
    const spelled = new Set(Object.values(SPELLINGS).map((row) => row.family));

    expect([...spelled].sort()).toEqual(Object.keys(SENTINELS).sort());
  });
});

describe("each shape's generator", () => {
  it.each(shapes)("%s emits benign shell the guard reads and passes at depth 2", async (_name, shape) => {
    const { stdout } = await run(bashEvent(shape("echo ok", 2)));

    expect(stdout).toBe("");
  });
});

describe("the parse budget at depth 8, padded to the size cap", () => {
  cpuBudgetIt.each(grid)("%s inside %s denies under budget", TEST_CPU_MS, async (_family, _name, shape, sentinel) => {
    const line = padToCeiling(shape, sentinel);

    const result = await withinParseBudget(run, line, { mustDeny: true });

    expect(Buffer.byteLength(line)).toBeGreaterThan(MAX_COMMAND_BYTES - 512);
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_COMMAND_BYTES);
    expect(result.problems).toEqual([]);
  });

  cpuBudgetIt.each(shapes)("benign %s stays under budget", TEST_CPU_MS, async (_name, shape) => {
    const line = padToCeiling(shape, "echo ok");

    const result = await withinParseBudget(run, line);

    expect(result.problems).toEqual([]);
  });
});
