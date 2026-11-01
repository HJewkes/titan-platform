import { describe, expect, it } from "vitest";
import { untimedCueHint, untimedCues } from "./layer-cues.js";

// Synthetic: an invented parcel desk.
const cue = (target: string, atCue: string, untilCue?: string) => ({ action: "V6" as const, target, atCue, ...(untilCue ? { untilCue } : {}) });

describe("the cue words a layer times without useCue", () => {
  it("names each cue word the source never reads with useCue, with every target it times", () => {
    // Arrange
    const module = `const { t } = useBeatTime();\nconst shown = t > 2.6;\n`;

    // Act
    const untimed = untimedCues(module, [cue("scan-card", "ledger"), cue("desk-card", "ledger"), cue("parcel-card", "parcel")]);

    // Assert
    expect(untimed).toEqual([{ cue: "ledger", targets: ["scan-card", "desk-card"] }, { cue: "parcel", targets: ["parcel-card"] }]);
  });

  it("accepts a cue read in any quote style, and holds an until-cue to the same rule", () => {
    // Arrange
    const module = `const a = useCue('ledger');\nconst b = useCue(\`scan#2\`);\n`;

    // Act
    const untimed = untimedCues(module, [cue("scan-card", "ledger", "parcel"), cue("desk-card", "scan#2")]);

    // Assert
    expect(untimed).toEqual([{ cue: "parcel", targets: ["scan-card"] }]);
  });

  it("tells the rebuild each cue word and how to read it", () => {
    // Arrange
    const untimed = [{ cue: "ledger", targets: ["scan-card"] }];

    // Act
    const hint = untimedCueHint(untimed);

    // Assert
    expect(hint).toContain('"ledger" (scan-card)');
    expect(hint).toContain('const at = useCue("ledger")');
  });
});
