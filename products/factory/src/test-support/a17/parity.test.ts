import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RECONCILER_KINDS } from "../../reconciler/kinds.js";
import type { CiFact } from "./ci-shapes.js";
import type { Feed } from "./feed.js";
import { a17Event } from "./register.js";
import type { RepoFact } from "./repo-shapes.js";

const REPO = "o/r";
const sha = (c: string): string => c.repeat(40);
const [A, B, C, D, E, F, G, H, I] = [sha("a"), sha("b"), sha("c"), sha("d"), sha("e"), sha("f"), sha("1"), sha("2"), sha("3")];

const check = (over: Partial<CiFact>): CiFact => ({ type: "check", repo: REPO, head: A, context: "build", checkRunId: 101, outcome: "success", at: "2026-10-17T10:00:00Z", ...over });
const status = (over: Partial<CiFact>): CiFact => ({ type: "status", repo: REPO, head: A, context: "ci", outcome: "success", at: "2026-10-17T10:02:00Z", ...over });
const opened = (pr: number, head: string, action: "opened" | "synchronize" | "edited" = "opened", base = "main"): RepoFact => ({ type: "pr", repo: REPO, pr, head, base, action });

interface Scenario {
  name: string;
  run(feed: Feed): Promise<void>;
  /** Every key the scenario yields under webhook; a transition's `after:<seq>` reads as the value it moved from. */
  golden: string[];
}

/** Keys polling is declared not to yield, each with the reason. Polling's keys are webhook's minus exactly these. */
const DECLARED_TRANSIENTS: readonly { key: string; reason: string }[] = [
  { key: `v1|CIConcluded|o/r|status|${A}|ci|failure|2026-10-17T10:01:00Z`, reason: "the failure holds between two ticks, so only its delivery sees it (TP-3095 §2)" },
  { key: "v1|RulesChanged|o/r|7|2026-10-17T10:05:00Z", reason: "the reconciler hands observe no ruleset read until TP-3428's conditional reads land, so polling has no view of a ruleset" },
];

const SCENARIOS: readonly Scenario[] = [
  {
    name: "CI",
    run: async (feed) => {
      await feed.fact(check({}));
      await feed.transient(status({ outcome: "failure", at: "2026-10-17T10:01:00Z" }));
      await feed.fact(status({}));
    },
    golden: [
      `v1|CIConcluded|o/r|check|${A}|101|success|2026-10-17T10:00:00Z`,
      `v1|CIConcluded|o/r|status|${A}|ci|failure|2026-10-17T10:01:00Z`,
      `v1|CIConcluded|o/r|status|${A}|ci|success|2026-10-17T10:02:00Z`,
      `v1|HeadPushed|o/r|o/r#1|${A}|after:none`,
      "v1|BaseChanged|o/r|o/r#1|main|after:none",
    ],
  },
  {
    name: "PR",
    run: async (feed) => {
      await feed.fact(opened(2, B));
      await feed.fact(opened(2, B, "edited", "release"));
      await feed.fact({ type: "ended", repo: REPO, pr: 2, merged: true, mergeSha: C, mergedBy: "synthetic-merger", closedAt: "2026-10-17T10:10:00Z" });
      await feed.fact(opened(3, D));
      await feed.fact({ type: "ended", repo: REPO, pr: 3, merged: false, mergeSha: null, closedAt: "2026-10-17T10:20:00Z" });
    },
    golden: [
      `v1|HeadPushed|o/r|o/r#2|${B}|after:none`,
      "v1|BaseChanged|o/r|o/r#2|main|after:none",
      "v1|BaseChanged|o/r|o/r#2|release|after:main",
      `v1|PRMerged|o/r|2|${C}`,
      `v1|HeadPushed|o/r|o/r#3|${D}|after:none`,
      "v1|BaseChanged|o/r|o/r#3|main|after:none",
      "v1|PRClosed|o/r|3|2026-10-17T10:20:00Z",
    ],
  },
  {
    name: "review",
    run: async (feed) => {
      await feed.fact(opened(4, E));
      await feed.fact({ type: "review", repo: REPO, pr: 4, id: 41, action: "submitted" });
      await feed.fact({ type: "review", repo: REPO, pr: 4, id: 41, action: "dismissed" });
    },
    golden: [`v1|HeadPushed|o/r|o/r#4|${E}|after:none`, "v1|BaseChanged|o/r|o/r#4|main|after:none", "v1|ReviewSubmitted|o/r|4|41|submitted", "v1|ReviewDismissed|o/r|4|41|dismissed"],
  },
  {
    name: "ruleset",
    run: async (feed) => void (await feed.fact({ type: "ruleset", repo: REPO, id: 7, updatedAt: "2026-10-17T10:05:00Z" })),
    golden: ["v1|RulesChanged|o/r|7|2026-10-17T10:05:00Z"],
  },
  {
    name: "head",
    run: async (feed) => {
      await feed.fact(opened(5, F));
      await feed.fact(opened(5, G, "synchronize"));
      await feed.fact({ type: "push", repo: REPO, sha: H });
      await feed.fact({ type: "push", repo: REPO, sha: I });
    },
    golden: [
      `v1|HeadPushed|o/r|o/r#5|${F}|after:none`,
      "v1|BaseChanged|o/r|o/r#5|main|after:none",
      `v1|HeadPushed|o/r|o/r#5|${G}|after:${F}`,
      `v1|MainMoved|o/r|o/r:main|${H}|after:none`,
      `v1|MainMoved|o/r|o/r:main|${I}|after:${H}`,
    ],
  },
];

const RowKeys = z.record(z.string(), z.unknown());

interface KeyRow {
  seq: number;
  occurrence_key: string;
  keys: string;
}

/** A transition's key names the seq it follows, which depends on how the mode interleaved its inserts; its value does not. */
function canonicalKeys(feed: Feed, sinceSeq: number): string[] {
  const rows = feed.db.prepare<[], KeyRow>("SELECT seq, occurrence_key, keys FROM factory_event ORDER BY seq").all();
  const valueAt = new Map(rows.map((row) => [row.seq, String(RowKeys.parse(JSON.parse(row.keys)).value)]));
  return rows
    .filter((row) => row.seq > sinceSeq)
    .map((row) => row.occurrence_key.replace(/\|after:(\d+)$/, (_, seq: string) => `|after:${seq === "0" ? "none" : valueAt.get(Number(seq))}`))
    .sort();
}

const lessTransients = (keys: readonly string[]): string[] => keys.filter((key) => !DECLARED_TRANSIENTS.some((t) => t.key === key));

describe("the harness's own A17 cases (TP-3102 H5)", () => {
  a17Event("the same scenario yields the same occurrence keys in both modes, less the declared transients", async (feed) => {
    for (const scenario of SCENARIOS) {
      const since = feed.headSeq();

      await scenario.run(feed);

      const golden = [...scenario.golden].sort();
      expect({ scenario: scenario.name, keys: canonicalKeys(feed, since) }).toEqual({ scenario: scenario.name, keys: feed.pick({ webhook: golden, polling: lessTransients(golden) }) });
    }
  });

  a17Event("a re-observed occurrence is a duplicate, never a second row", async (feed) => {
    const once = feed.pick<string[]>({ webhook: ["inserted", "occurrence"], polling: ["inserted"] });

    const steps = [await feed.fact(check({})), await feed.fact({ type: "review", repo: REPO, pr: 1, id: 11, action: "submitted" }), await feed.fact({ type: "push", repo: REPO, sha: H })];
    const rows = feed.headSeq();
    await feed.advance();
    await feed.advance();

    expect(steps).toEqual([once, once, once]);
    expect(feed.headSeq()).toBe(rows);
  });

  it("covers every kind the reconciler declares, and declares only keys a scenario yields", () => {
    const kinds = new Set(SCENARIOS.flatMap((scenario) => scenario.golden.map((key) => key.split("|")[1])));
    const declared = new Set(RECONCILER_KINDS.flatMap((row) => row.kinds));
    const golden = SCENARIOS.flatMap((scenario) => scenario.golden);

    expect([...kinds].sort()).toEqual([...declared].sort());
    expect(DECLARED_TRANSIENTS.filter((t) => !golden.includes(t.key))).toEqual([]);
  });
});
