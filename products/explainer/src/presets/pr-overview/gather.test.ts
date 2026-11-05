import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProfiles, profileFor } from "../../profile-load.js";
import { factsJsonl, gatherPr, PR_OVERVIEW_ADAPTER, writeGather, type GatherPrOptions } from "./gather.js";
import { EDGES, fakeEdges, fakeGh, HEAD, PR, VIEW } from "./pr-fakes.test-helpers.js";
import { PrFactSchema } from "./schemas.js";

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function gather(overrides: Partial<GatherPrOptions> = {}) {
  return gatherPr({ pr: PR, clonePath: "/clone/widgets", gh: fakeGh(), callEdges: fakeEdges(), ...overrides });
}

async function okFacts(overrides: Partial<GatherPrOptions> = {}) {
  const result = await gather(overrides);
  if (!result.ok) throw new Error(`refused: ${result.diagnostics.map((d) => d.code).join(", ")}`);
  return result;
}

const codes = (result: Awaited<ReturnType<typeof gatherPr>>) => result.diagnostics.map((d) => d.code);

describe("gatherPr facts", () => {
  it("makes a pr fact, one change per file, one finding per review or comment with a body, and the cross-file calls", async () => {
    const { facts, head } = await okFacts();

    expect(head).toBe(HEAD);
    expect(facts.map((f) => f.id)).toEqual([
      "pr",
      "change:docs/b.md",
      "change:docs/old.md",
      "change:src/api.ts",
      "change:src/cache.ts",
      ...facts.filter((f) => f.kind === "finding").map((f) => f.id),
      "call:src/api.ts#handle->src/cache.ts#lookup",
    ]);
    expect(facts.filter((f) => f.kind === "finding")).toHaveLength(2);
    expect(facts.every((f) => PrFactSchema.safeParse(f).success)).toBe(true);
  });

  it("feeds each kind to its pr-overview block, calls to the interactions (sequence) slot", async () => {
    const { facts } = await okFacts();
    const slotOf = (id: string) => facts.find((f) => f.id === id)?.slot;

    expect([slotOf("pr"), slotOf("change:src/api.ts"), slotOf("call:src/api.ts#handle->src/cache.ts#lookup")]).toEqual(["summary", "changes", "interactions"]);
    expect(facts.filter((f) => f.kind === "finding").every((f) => f.slot === "shortcomings")).toBe(true);
  });

  it("keeps only calls between two different changed files", async () => {
    const { facts } = await okFacts();

    expect(facts.filter((f) => f.kind === "call").map((f) => [f.from, f.to])).toEqual([["src/api.ts#handle", "src/cache.ts#lookup"]]);
  });

  it("cites each change's head-side hunk lines and reads the task and the review verdict", async () => {
    const { facts } = await okFacts();

    expect(facts.find((f) => f.id === "change:src/api.ts")?.evidence).toEqual([{ path: "src/api.ts", lineStart: 1, lineEnd: 5 }]);
    expect(facts.find((f) => f.id === "pr")?.task).toBe("DEMO-12");
    expect(facts.find((f) => f.text.startsWith("Eviction"))?.verdict).toBe("FIX_FIRST");
  });

  it("asks gh only for the PR's view and diff", async () => {
    const gh = fakeGh();

    await okFacts({ gh });

    expect(gh.calls.map((c) => c.slice(0, 2).join(" ")).sort()).toEqual(["pr diff", "pr view"]);
  });
});

describe("gatherPr fact ids", () => {
  it("writes the same facts.jsonl bytes over two runs", async () => {
    const first = factsJsonl((await okFacts()).facts);
    const second = factsJsonl((await okFacts()).facts);

    expect(second).toBe(first);
  });

  it("keeps every earlier fact id when a new comment and a new call edge arrive", async () => {
    const before = (await okFacts()).facts.map((f) => f.id);
    const view = { ...VIEW, comments: [{ body: "A new comment." }, ...VIEW.comments] };
    const edges = [{ from: "src/cache.ts#lookup", to: "src/api.ts#handle", sites: 2 }, ...EDGES];

    const after = (await okFacts({ gh: fakeGh(view), callEdges: fakeEdges(edges) })).facts.map((f) => f.id);

    expect(after).toEqual(expect.arrayContaining(before));
    expect(after).toHaveLength(before.length + 2);
  });
});

describe("gatherPr refusals", () => {
  it("refuses a ref that is not owner/repo#N before calling gh", async () => {
    const gh = fakeGh();

    const result = await gather({ pr: "widgets#7", gh });

    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["E-PR-REF"]);
    expect(gh.calls).toEqual([]);
  });

  it("refuses with E-PR-READ when gh fails", async () => {
    const result = await gather({ gh: async () => Promise.reject(new Error("HTTP 404")) });

    expect(codes(result)).toEqual(["E-PR-READ"]);
  });

  it("lists every refusal at once: no linked task, empty diff and an unindexable head", async () => {
    const view = { ...VIEW, title: "Cache widget lookups", body: "", headRefName: "feat/widget-cache" };

    const result = await gather({ gh: fakeGh(view, ""), callEdges: async () => Promise.reject(new Error("bad object")) });

    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(expect.arrayContaining(["E-EMPTY-DIFF", "E-LINKED-TASK", "E-CALLGRAPH"]));
  });

  it("finds a task id in the branch name when the title and body name none", async () => {
    const view = { ...VIEW, title: "Cache widget lookups", body: "", headRefName: "feat/demo-12-widget-cache" };

    const { facts } = await okFacts({ gh: fakeGh(view) });

    expect(facts.find((f) => f.id === "pr")?.task).toBe("DEMO-12");
  });

  it("gathers with warnings when there are no findings and no cross-file calls", async () => {
    const view = { ...VIEW, reviews: [], comments: [] };

    const result = await gather({ gh: fakeGh(view), callEdges: fakeEdges([]) });

    expect(result.ok).toBe(true);
    expect(codes(result).sort()).toEqual(["W-NO-EDGES", "W-NO-FINDINGS"]);
  });
});

describe("writeGather", () => {
  it("writes facts.jsonl on success and only gather.json on a refusal", async () => {
    const ok = await mkdtemp(join(tmpdir(), "gather-pr-"));
    const refused = await mkdtemp(join(tmpdir(), "gather-pr-"));
    temps.push(ok, refused);

    await writeGather(ok, await gather());
    await writeGather(refused, await gather({ gh: fakeGh(VIEW, "") }));

    expect((await readFile(join(ok, "facts.jsonl"), "utf8")).trim().split("\n")).toHaveLength(8);
    expect(existsSync(join(refused, "facts.jsonl"))).toBe(false);
    expect(JSON.parse(await readFile(join(refused, "gather.json"), "utf8"))).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: "E-EMPTY-DIFF" })]) });
  });
});

describe("the pr-overview profile", () => {
  it("names gatherPr as its gather adapter", () => {
    expect(profileFor(loadProfiles(), "pr-overview").inputs.adapters).toContain(PR_OVERVIEW_ADAPTER);
  });
});
