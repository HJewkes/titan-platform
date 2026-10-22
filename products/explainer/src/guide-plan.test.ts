import { describe, expect, it } from "vitest";
import { guidePlan } from "./guide-plan.js";
import { parseSpine } from "./spine-schema.js";

describe("guidePlan", () => {
  it("gives the plan stage the journey-first planner rule and the template's journey header", () => {
    const guide = guidePlan("plan");

    expect(guide).toContain("Open on the problem, then follow one task's journey");
    expect(guide).toContain("## 3. Journey: one task from");
    expect(guide).toContain("## Rules for the plan stage");
  });

  it("keeps code-enforced owner rules and their thresholds out of the guide", () => {
    const guide = guidePlan("plan");

    expect(guide).not.toContain("at most 4");
    expect(guide).not.toContain("Show only a few new on-screen items");
    expect(guide).not.toContain("owner-FB3");
  });

  it("tells every stage to write for the ear: contractions, varied length, you, and we but never I", () => {
    const guide = guidePlan("script");

    expect(guide).toContain("## Write it to be spoken");
    expect(guide).toContain("Contract as people talk");
    expect(guide).toContain("Put a short sentence beside a long one");
    expect(guide).toContain("let some sentences run");
    expect(guide).toContain('Talk to the viewer as "you"');
    expect(guide).toContain('never as "I"');
    expect(guidePlan("plan")).toContain("## Write it to be spoken");
  });

  it("gives the script stage, and only it, the contrast-as-a-sentence craft line", () => {
    expect(guidePlan("script")).toContain("**register-N6**: Narration, a FENCE beat above all, states a contrast as its own sentence");
    expect(guidePlan("plan")).not.toContain("register-N6");
  });

  it("states spoken register as direction, with none of the Q-V11 bands", () => {
    const guide = guidePlan("script");
    const register = guide.split("## Write it to be spoken")[1]?.split("## Rules for")[0] ?? "";
    const craftLine = /\*\*register-N6\*\*: (.*)/.exec(guide)?.[1] ?? "";

    expect(register).not.toBe("");
    expect(craftLine).not.toBe("");
    expect(`${register}${craftLine}`).not.toMatch(/\d/);
  });
});

const SPINE = `# Story spine: parcel-desk-v1

## 3. Journey: one task from "a parcel arrives" to "a label prints"
| # | Step | What happens (one clause) | Why it is needed (what goes wrong without it) | Invariant it must keep | Today: how it breaks (fact id) |
|---|---|---|---|---|---|
| 1 | Scan | the scanner reads the barcode | no barcode, no parcel record | — | — |

## 4. Architecture that carries the task
| Part (map node) | Carries step(s) | Mechanism for each invariant it keeps | Constraint that forces it |
|---|---|---|---|
| Desk server | 1 | — | — |

## 5. Constraints (fixed, not chosen)
| Constraint | The mechanism it forces (a part from §4) |
|---|---|

## 6. Item ledger: every name the viewer will meet
| Item | Kind | Defined in beat | Reused in beats |
|---|---|---|---|
| Desk server | part | c2-2 | c3-1 |

## 8. Chapter order
| Ch | Question | Spine rows it covers |
|---|---|---|
| ch2 | How does a parcel get a label? | §3.1, Desk server |
`;

describe("guidePlan with a spine", () => {
  it("appends each act's spine rows and the ledger", () => {
    const guide = guidePlan("plan", { spine: parseSpine(SPINE) });

    expect(guide).toContain("### ch2: How does a parcel get a label?");
    expect(guide).toContain("- §3.1: Scan: the scanner reads the barcode");
    expect(guide).toContain("- Desk server (part; defined in c2-2; reused in c3-1)");
  });

  it("stays byte-identical to the spine-free guide when no spine is passed", () => {
    expect(guidePlan("plan", {})).toBe(guidePlan("plan"));
    expect(guidePlan("plan")).not.toContain("Spine rows per act");
  });
});
