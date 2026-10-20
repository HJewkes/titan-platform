import { describe, expect, it } from "vitest";
import { parseSpine } from "./spine-schema.js";

const LEDGER = `## 6. Item ledger: every name the viewer will meet
| Item | Kind (step / property / constraint / invariant / part / number) | Defined in beat | Reused in beats |
|---|---|---|---|
| Scan | step | c2-1 | c3-1, c4-2 |
| Desk server | Part | c2-2 | — |`;

const spine = (ledger = LEDGER) => `# Story spine: parcel-desk-v1

## 1. Viewer
- Who: a new courier-desk engineer.

## 3. Journey: one task from "a parcel arrives" to "a label prints"
| # | Step | What happens (one clause) | Why it is needed (what goes wrong without it) | Invariant it must keep | Today: how it breaks (fact id) |
|---|---|---|---|---|---|
| 1 | Scan | the scanner reads the barcode | no barcode, no parcel record | I1 one record a parcel | F3 |
| 2 | Print | the desk prints a label | a parcel with no label is lost | — | - |

## 4. Architecture that carries the task
| Part (map node) | Carries step(s) | Mechanism for each invariant it keeps | Constraint that forces it |
|---|---|---|---|
| Desk server | 1, 2 | dedupes scans by barcode (I1) | scanners go offline \\| retry |

## 5. Constraints (fixed, not chosen)
| Constraint | The mechanism it forces (a part from §4) |
|---|---|
| Scanners go offline | Desk server |

${ledger}

## 7. Cut list
Billing is not named.

## 8. Chapter order (derived from §2-§5, not from the source doc)
| Ch | Question | Spine rows it covers |
|---|---|---|
| ch2 | How does a parcel get a label? | §3.1, §3.2 |
`;

describe("parseSpine reads the story-spine template into spine/v1", () => {
  it("reads the journey, architecture, constraints, ledger and chapter tables, a dash cell as absent", () => {
    const parsed = parseSpine(spine());

    expect(parsed.id).toBe("parcel-desk-v1");
    expect(parsed.journey[1]).toEqual({ n: 2, step: "Print", what: "the desk prints a label", why: "a parcel with no label is lost", invariant: null, breaksToday: null });
    expect(parsed.architecture[0]).toMatchObject({ part: "Desk server", carries: ["1", "2"], constraint: "scanners go offline | retry" });
    expect(parsed.constraints).toEqual([{ constraint: "Scanners go offline", forces: "Desk server" }]);
    expect(parsed.ledger).toEqual([
      { item: "Scan", kind: "step", definedIn: "c2-1", reusedIn: ["c3-1", "c4-2"] },
      { item: "Desk server", kind: "part", definedIn: "c2-2", reusedIn: [] },
    ]);
    expect(parsed.chapters).toEqual([{ chapter: "ch2", question: "How does a parcel get a label?", rows: ["§3.1", "§3.2"] }]);
  });

  it("rejects a spine with no item ledger", () => {
    expect(() => parseSpine(spine(""))).toThrow(/ledger/);
  });

  it("rejects a kind outside the declared set", () => {
    expect(() => parseSpine(spine(LEDGER.replace("| step |", "| verb |")))).toThrow(/kind/);
  });

  it("rejects an item listed twice, whatever its case", () => {
    expect(() => parseSpine(spine(`${LEDGER}\n| scan | step | c2-1 | — |`))).toThrow(/duplicate ledger item \\"scan\\"/);
  });

  it("names the section of a row with the wrong number of cells", () => {
    expect(() => parseSpine(spine(`${LEDGER}\n| Ledger | part | c2-3 |`))).toThrow(/§6 \(ledger\) row 3 has 3 cells, expected 4/);
  });
});
