import { describe, expect, it } from "vitest";
import { parseSpine } from "../spine-schema.js";
import { chapterOf, factPlaces, factsSlice } from "./script-facts.js";

// A synthetic kite workshop; nothing here quotes a real video.
const SPINE = `# Story spine: kite-shop

## 3. Journey
| # | Step | What | Why | Invariant | Today |
|---|---|---|---|---|---|
| 1 | Cut | the cutter shapes the sail | the kite would not lift | — | — |

## 4. Architecture
| Part | Carries | Mechanism | Constraint |
|---|---|---|---|
| Frame | 1 | — | — |

## 5. Constraints
| Constraint | Forces |
|---|---|

## 6. Ledger
| Item | Kind | Defined in | Reused in |
|---|---|---|---|
| frame | part | ch1 | ch3 |
| sail | part | ch2 | — |
| tail | part | ch9 | — |

## Cites
| Item | Facts |
|---|---|
| frame | K1 |
| sail | K2 |
| tail | K3 |

## 8. Chapter order
| Ch | Question | Rows |
|---|---|---|
| ch1 | What holds the kite? | §3 |
| ch2 | What catches the wind? | §3 |
| ch3 | How does it fly? | §3 |
`;

const FACTS = `# Facts

| Id | Claim |
|---|---|
| K1 | A frame weighs 80 grams. |
| K2 | A sail spans 1.2 metres. |
| K3 | A tail is 3 metres long. |
| K4 | The shop opens at nine. |
`;

const ids = (text: string): string[] => ["K1", "K2", "K3", "K4"].filter((id) => text.includes(id));

describe("chapter facts slice", () => {
  it("places a beat in the chapter whose id or number it carries, never in a chapter whose number only starts the same", () => {
    const chapters = ["ch1", "ch3", "ch3b", "ch10"];

    expect([chapterOf("r3b-1-run", chapters), chapterOf("r10-2", chapters), chapterOf("r1-hook", chapters)]).toEqual(["ch3b", "ch10", "ch1"]);
    expect([chapterOf("ch3-b", chapters), chapterOf("ch3b-a", chapters), chapterOf("ch10", chapters)]).toEqual(["ch3", "ch3b", "ch10"]);
    expect(chapterOf("hook", chapters)).toBeUndefined();
  });

  it("slices by the spine's Cites table through the ledger, keeping a fact cited in no chapter or an unknown one everywhere", () => {
    const places = factPlaces(SPINE, parseSpine(SPINE), FACTS);

    expect(ids(factsSlice(FACTS, places, "ch1"))).toEqual(["K1", "K3", "K4"]);
    expect(ids(factsSlice(FACTS, places, "ch2"))).toEqual(["K2", "K3", "K4"]);
    expect(ids(factsSlice(FACTS, places, "ch3"))).toEqual(["K1", "K3", "K4"]);
    expect(factsSlice(FACTS, places, "ch2")).toContain("# Facts\n\n| Id | Claim |\n|---|---|\n");
  });

  it("slices a JSON lines pack line by line", () => {
    const jsonl = ['{"id":"K1","text":"A frame weighs 80 grams."}', '{"id":"K2","text":"A sail spans 1.2 metres."}'].join("\n");

    const slice = factsSlice(jsonl, factPlaces(SPINE, parseSpine(SPINE), jsonl), "ch2");

    expect(ids(slice)).toEqual(["K2"]);
  });
});
