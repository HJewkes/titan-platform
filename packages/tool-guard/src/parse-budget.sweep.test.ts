import { describe, expect, it } from "vitest";
import { nodeContext } from "./context.js";
import type { ReadFs } from "./context.js";
import { decide } from "./decide.js";
import { handle, MAX_COMMAND_BYTES } from "./hook.js";
import type { HookPort } from "./hook.js";
import { SPELLINGS } from "./spellings.js";
import type { FamilyName } from "./spellings.js";
import { bashEvent, withinParseBudget } from "./test-support/parse-budget.js";
import type { HookRun } from "./test-support/parse-budget.js";

const HOME = "/home/you";
const DEPTH = 8;
const PAD = "echo hi;";
// The helper's 250 ms default holds: the worst case measured 47 ms of CPU (secret inside cmd-subst, 2026-10-14).

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
  // `let a` would be refused as a possible rebinding before the value is walked; a numeric `[[` still walks it.
  "arith-subscript": (inner, depth) => `a='x[${substValue(inner, depth)}]'; [[ a -eq 0 ]]`,
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
  it.each(sentinels)("%s denies on its own", async (_family, sentinel) => {
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
  it.each(grid)("%s inside %s denies under budget", async (_family, _name, shape, sentinel) => {
    const line = padToCeiling(shape, sentinel);

    const result = await withinParseBudget(run, line, { mustDeny: true });

    expect(Buffer.byteLength(line)).toBeGreaterThan(MAX_COMMAND_BYTES - 512);
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_COMMAND_BYTES);
    expect(result.problems).toEqual([]);
  });

  it.each(shapes)("benign %s stays under budget", async (_name, shape) => {
    const line = padToCeiling(shape, "echo ok");

    const result = await withinParseBudget(run, line);

    expect(result.problems).toEqual([]);
  });
});
