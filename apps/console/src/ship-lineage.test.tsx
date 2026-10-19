// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ShipLineage } from "../server/ship-lineage.js";
import { ShipLineageLine } from "./pages/ShipLineage.js";

afterEach(cleanup);

const PROVEN = "abc1234".padEnd(40, "0");
const MAIN = "def5678".padEnd(40, "1");
const MERGE = "9876543".padEnd(40, "2");
const open: ShipLineage = { known: true, provenSha: PROVEN, state: "open", merged: false, mergeSha: null, headSha: PROVEN, baseRef: "main", baseSha: MAIN, behind: 0 };

const line = (lineage: ShipLineage | undefined): HTMLElement => {
  render(<ShipLineageLine lineage={lineage} />);
  return screen.getByTestId("ship-lineage");
};

describe("the Ship lineage line", () => {
  it("names a head 3 commits behind main as stale, beside the proven sha, UNMERGED and the main tip", () => {
    const shown = line({ ...open, behind: 3 });

    expect(shown.textContent).toBe("proven at abc1234UNMERGEDmain def56783 behind");
    expect(shown.dataset.state).toBe("stale");
  });

  it("calls a proven head level with main up to date, not stale", () => {
    const shown = line(open);

    expect(shown.textContent).toContain("up to date");
    expect(shown.dataset.state).toBe("fresh");
  });

  it("shows a merged head as merged with its merge sha and no behind count", () => {
    const shown = line({ ...open, merged: true, mergeSha: MERGE, behind: null });

    expect(shown.textContent).toBe("proven at abc1234merged 9876543main def5678");
    expect(shown.dataset.state).toBe("merged");
  });

  it("names a PR closed without merging and leaves behind unknown, never up to date", () => {
    const shown = line({ ...open, state: "closed", behind: null });

    expect(shown.textContent).toBe("proven at abc1234closed UNMERGEDmain def5678behind unknown");
    expect(shown.dataset.state).toBe("unknown");
  });

  it("says the head moved and leaves behind unknown rather than calling it fresh", () => {
    const shown = line({ ...open, headSha: "fedcba9".padEnd(40, "3"), behind: null });

    expect(shown.textContent).toContain("head moved to fedcba9");
    expect(shown.textContent).toContain("behind unknown");
    expect(shown.dataset.state).toBe("unknown");
  });

  it("renders missing compare data as lineage unknown with its reason, never a blank", () => {
    const shown = line({ known: false, reason: "example/tiles#1 unread: rate limited" });

    expect(shown.textContent).toBe("lineage unknownexample/tiles#1 unread: rate limited");
    expect(shown.dataset.state).toBe("unknown");
  });

  it("renders an absent lineage as lineage unknown", () => {
    expect(line(undefined).textContent).toBe("lineage unknown");
  });
});
