// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { z } from "zod";
import { LOG_ANSWERS } from "../server/twin/log.js";
import { renderPage } from "./render-page.test-helpers.js";

const NOW = Date.parse("2031-03-05T12:00:00.000Z");

function inboxRow(id: string, byRec?: { at: string; mode: "shadow" | "live" }): Record<string, unknown> {
  return {
    id, sources: [{ system: "round", ref: `${id}#ramp` }], kind: "decide", door: "two-way", summary: `Ask ${id}`, context: "", keys: [], personal: false,
    lens: "blocking-agent", unblocks: [], openedAt: new Date(NOW - 3_600_000).toISOString(), status: "open", section: "blocking", evidence: undefined,
    action: { kind: "open-round", roundId: id }, ...(byRec && { byRec }),
  };
}

/** jsdom has no IntersectionObserver: this one reports every target in view at once, so thumbnails load. */
class InViewObserver {
  constructor(private readonly callback: (entries: Pick<IntersectionObserverEntry, "target" | "isIntersecting">[]) => void) {}
  observe(target: Element): void {
    this.callback([{ target, isIntersecting: true }]);
  }
  disconnect(): void {}
}

beforeEach(() => vi.stubGlobal("IntersectionObserver", InViewObserver));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The twin's synthetic log: #41 merged by rec (a visual gate), #38 by reviewer with a shadow row, a live deposit and a shadow round. */
function snapshot(edit: (command: string, result: unknown) => unknown = (_, result) => result): Snapshot {
  const calls = Object.fromEntries(LOG_ANSWERS.map(({ command, args, result }) => [snapshotKey(command, args), successEnvelope(edit(command, result))]));
  return { format: SNAPSHOT_FORMAT, createdAt: "2031-03-06T00:00:00.000Z", calls };
}

describe("the decisions and ships page", () => {
  it("floor exclusion has no remove control", async () => {
    renderPage(snapshot(), "#/log");

    const floor = await screen.findByTestId("log-floor");
    expect(within(floor).getByTestId("log-floor-g10-hold").textContent).toContain("Any g10 hold");
    expect(floor.textContent).toContain("To remove: an owner-approved PR");
    expect(within(floor).queryAllByRole("button")).toEqual([]);
    expect(screen.getByTestId("log-floor-unconfirmed")).toBeTruthy();
    expect(screen.getByTestId("log-added-category-naming").textContent).toContain("names stay the owner's");
  });

  it("labels a shadow row, and a ship by-rec would have merged", async () => {
    renderPage(snapshot(), "#/log");

    expect((await screen.findByTestId("log-approval-round:kiln-schedule-r2#q1")).textContent).toBe("shadow: would have gone by rec");
    expect(screen.getByTestId("log-approval-orbit/relay#38").textContent).toBe("reviewer MERGE");
    expect(screen.getByTestId("log-shadow-orbit/relay#38")).toBeTruthy();
    expect(screen.queryByTestId("log-shadow-orbit/relay#36")).toBeNull();
  });

  it("gives a ship a revert link and a live decision the overrule slot", async () => {
    renderPage(snapshot(), "#/log");

    const ship = await screen.findByTestId("log-row-orbit/relay#41");
    expect(within(ship).getByTestId("log-approval-orbit/relay#41").textContent).toBe("auto-by-rec");
    expect(within(ship).getByTestId("log-revert-orbit/relay#41")).toBeTruthy();
    expect(within(ship).getByTestId("log-frames-orbit/relay#41")).toBeTruthy();
    const decision = screen.getByTestId("log-row-deposit:dep-ceiling");
    expect(within(decision).getByTestId("log-overrule-deposit:dep-ceiling")).toBeTruthy();
    expect(screen.queryByTestId("log-frames-orbit/relay#36")).toBeNull();
  });
});

const logViewShape = z.looseObject({ days: z.array(z.looseObject({ rows: z.array(z.looseObject({ key: z.string(), frames: z.unknown() })) })) });

/** The twin's log with #41's frames replaced, as the builder writes them for a PR whose artifact showed nothing. */
function withFramesOf41(frames: unknown): Snapshot {
  return snapshot((command, result) => {
    if (command !== "log.list") return result;
    const view = logViewShape.parse(structuredClone(result));
    for (const row of view.days.flatMap((day) => day.rows)) if (row.key === "orbit/relay#41") row.frames = frames;
    return view;
  });
}

describe("the visual ship row's frames", () => {
  it("shows a before and after thumbnail that opens full size", async () => {
    renderPage(snapshot(), "#/log");

    const frames = await screen.findByTestId("log-frames-orbit/relay#41");
    expect(frames.textContent).toContain("relay-card--compact@1280");
    await within(frames).findByRole("button", { name: "Enlarge relay-card--compact@1280 before" });
    const after = await within(frames).findByRole("button", { name: "Enlarge relay-card--compact@1280 after" });
    expect([...frames.querySelectorAll("img")].map((image) => image.getAttribute("alt"))).toEqual(["relay-card--compact@1280 before", "relay-card--compact@1280 after"]);
    fireEvent.click(after);
    expect(screen.getByRole("dialog", { name: "relay-card--compact@1280 after" })).toBeTruthy();
  });

  it("shows the one reason line when the artifact gave no pairs", async () => {
    renderPage(withFramesOf41({ repo: "orbit/relay", pr: 41, pairs: [], note: "no visual evidence: no pr-visual artifact for this head" }), "#/log");

    const frames = await screen.findByTestId("log-frames-orbit/relay#41");
    expect(frames.textContent).toBe("no visual evidence: no pr-visual artifact for this head");
    expect(within(frames).queryAllByRole("img")).toEqual([]);
  });
});

describe("the inbox by-rec countdown", () => {
  it("inbox countdown shows only on eligible items", async () => {
    const items = [inboxRow("kiln-r1", { at: "2031-03-06T02:00:00.000Z", mode: "live" }), inboxRow("lantern-r1")];
    const answer = successEnvelope({ items, planningCount: 0, gaps: [], fyiCount: 0, readAt: new Date(NOW).toISOString(), derived: [], nudges: [] });
    renderPage({ format: SNAPSHOT_FORMAT, createdAt: new Date(NOW).toISOString(), calls: { [snapshotKey("inbox.list", {})]: answer } }, "#/inbox");

    expect((await screen.findByTestId("inbox-by-rec-kiln-r1")).textContent).toMatch(/^Goes with rec at /);
    expect(within(screen.getByTestId("inbox-row-lantern-r1")).queryByText(/with rec at/)).toBeNull();
  });
});
