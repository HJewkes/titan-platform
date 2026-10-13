import { describe, expect, it } from "vitest";
import { reviewAblation } from "./review-ablation.js";
import { type ThroughputRow } from "./rows.js";

let seq = 0;
function row(overrides: Partial<ThroughputRow> = {}): ThroughputRow {
  seq += 1;
  return {
    taskId: `T-${String(seq).padStart(4, "0")}`,
    initiative: "web",
    doneAt: "2026-09-10",
    firstImplAt: "2026-09-09",
    implAgentHours: { capped: 1 },
    reviewAgentHours: { capped: 1 },
    usd: 1,
    kind: "feature",
    estimate: 2,
    prClass: "standard",
    touches: [],
    changedLines: 50,
    ...overrides,
  };
}

const ORIGIN = "2026-09-20";
const trained = { doneAt: "2026-09-10", firstImplAt: "2026-09-09" };
const tested = { doneAt: "2026-09-23", firstImplAt: "2026-09-21" };

function corpus(make: (i: number, when: Partial<ThroughputRow>) => ThroughputRow): ThroughputRow[] {
  return [...Array.from({ length: 40 }, (_, i) => make(i, trained)), ...Array.from({ length: 40 }, (_, i) => make(i, tested))];
}

const options = { origins: [ORIGIN], horizonDays: 7, config: { minN: 5 } };

describe("reviewAblation", () => {
  it("scores the diff key better when review hours depend only on the large touch", () => {
    const rows = corpus((i, when) =>
      i % 2 === 0 ? row({ ...when, prClass: "g10", touches: ["large"], reviewAgentHours: { capped: 3 } }) : row({ ...when, reviewAgentHours: { capped: 0.3 } }),
    );

    const { pooled } = reviewAblation(rows, options);

    expect(pooled.reviewAgentHours.n).toBe(40);
    expect(pooled.reviewAgentHours.insufficient).toBe(false);
    expect(pooled.reviewAgentHours.diff.pinball.p50!).toBeLessThan(pooled.reviewAgentHours.base.pinball.p50!);
    expect(pooled.reviewAgentHours.deltaP50!).toBeLessThan(0);
    expect(pooled.reviewAgentHours.diff.coverage.hits).toBe(40);
  });

  it("scores the base key no worse when review hours depend only on the size band", () => {
    const rows = corpus((i, when) => (i % 2 === 0 ? row({ ...when, estimate: 1, reviewAgentHours: { capped: 0.3 } }) : row({ ...when, estimate: 4, reviewAgentHours: { capped: 3 } })));

    const { pooled } = reviewAblation(rows, options);

    expect(pooled.reviewAgentHours.base.pinball.p50!).toBeLessThanOrEqual(pooled.reviewAgentHours.diff.pinball.p50!);
  });

  it("keeps a row in flight across the origin out of both that origin's train and test sets", () => {
    const rows = [
      row({ ...trained, reviewAgentHours: { capped: 1 } }),
      row({ doneAt: "2026-09-22", firstImplAt: "2026-09-18", reviewAgentHours: { capped: 100 } }),
      row({ ...tested, reviewAgentHours: { capped: 1 } }),
    ];

    const [origin] = reviewAblation(rows, { origins: [ORIGIN], config: { minN: 0 } }).origins;

    expect(origin).toMatchObject({ trainN: 1, testN: 1 });
    expect(origin?.targets?.reviewAgentHours.diff.pinball.p50).toBe(0);
  });

  it("leaves rows without PR features out of both arms and counts them", () => {
    const rows = [row(trained), row({ ...tested, prClass: null, touches: null }), row(tested)];

    const result = reviewAblation(rows, { origins: [ORIGIN], config: { minN: 0 } });

    expect(result.skippedMissingFeatures).toBe(1);
    expect(result.pooled.reviewAgentHours.n).toBe(1);
    expect(result.pooled.reviewAgentHours.insufficient).toBe(true);
  });

  it("counts a null target as skipped and reports an origin with no training rows as unfitted", () => {
    const rows = [row({ ...trained, reviewRounds: 1 }), row({ ...tested, reviewRounds: null })];

    const result = reviewAblation(rows, { origins: ["2026-09-01", ORIGIN], config: { minN: 0 } });

    expect(result.origins[0]?.targets).toBeNull();
    expect(result.pooled.reviewRounds).toMatchObject({ n: 0, skippedNull: 1 });
    expect(result.pooled.reviewRounds.deltaP50).toBeNull();
  });
});
