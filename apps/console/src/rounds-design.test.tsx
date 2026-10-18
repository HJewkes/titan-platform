// @vitest-environment jsdom
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { errorEnvelope, successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { FIXTURE_ROUNDS as source } from "../server/round-fixtures.js";
import { getFrame, listFrames } from "../server/round-frames.js";
import { getRound, readManifest, type RoundDetail } from "../server/rounds.js";
import { App } from "./App.js";
import { AnswerSourceProvider } from "./data/submit.js";

const DESIGN = "beacon-states-r1";
const STATES = [
  ["beacon-idle", "Idle"],
  ["beacon-busy", "Busy"],
  ["beacon-error", "Error"],
  ["beacon-muted", "Muted"],
] as const;

/** jsdom has no IntersectionObserver: this one fires only when a test calls `scrollAll`. */
const observers = new Set<{ fire: () => void }>();
type Entry = Pick<IntersectionObserverEntry, "target" | "isIntersecting">;
class StubObserver {
  private readonly targets: Element[] = [];
  constructor(private readonly callback: (entries: Entry[]) => void) {
    observers.add(this);
  }
  observe(target: Element): void {
    this.targets.push(target);
  }
  disconnect(): void {
    observers.delete(this);
  }
  fire(): void {
    this.callback(this.targets.map((target) => ({ target, isIntersecting: true })));
  }
}

const scrollAll = (): void => act(() => [...observers].forEach((observer) => observer.fire()));

beforeEach(() => vi.stubGlobal("IntersectionObserver", StubObserver));
afterEach(() => {
  cleanup();
  observers.clear();
  vi.unstubAllGlobals();
});

type Listing = Snapshot["calls"][string];

/** The daemon's answers over the synthetic design fixture; `detail` overrides rounds.get, `listing` replaces rounds.frames. */
async function recorded(detail: Partial<RoundDetail>, listing?: Listing): Promise<Snapshot> {
  const frames = await Promise.all(
    STATES.map(async ([key]) => [snapshotKey("rounds.frame", { id: DESIGN, key, view: "head" }), successEnvelope(await getFrame(source, DESIGN, key, "head"))] as const),
  );
  return {
    format: SNAPSHOT_FORMAT,
    createdAt: "2031-03-05T00:00:00.000Z",
    calls: {
      [snapshotKey("rounds.get", { id: DESIGN })]: successEnvelope({ ...(await getRound(source, DESIGN)), ...detail }),
      [snapshotKey("rounds.frames", { id: DESIGN })]: listing ?? successEnvelope(await listFrames(source, DESIGN)),
      ...Object.fromEntries(frames),
    },
  };
}

interface Rendered {
  calls: { name: string; args: unknown }[];
}

/** Renders the design round over a recorded snapshot; rounds.submit answers "submitted". */
async function renderDesign(options: { detail?: Partial<RoundDetail>; listing?: Listing } = {}): Promise<Rendered> {
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", await recorded(options.detail ?? {}, options.listing)), "text/html");
  const inner = pageDataSource({ doc: page });
  const calls: Rendered["calls"] = [];
  const submitted = successEnvelope({ status: "submitted", path: "feedback.json", sha256: "0".repeat(64), headSha: null });
  const counting: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, callOptions) => (calls.push({ name, args }), name === "rounds.submit" ? Promise.resolve(submitted) : inner.call(name, args, callOptions)),
  };
  window.location.hash = `#/rounds/${DESIGN}`;
  render(
    <RpcProvider source={counting}>
      <AnswerSourceProvider value={counting}>
        <App />
      </AnswerSourceProvider>
    </RpcProvider>,
  );
  await screen.findByText("Beacon states");
  return { calls };
}

const frameKeys = ({ calls }: Rendered): unknown[] => calls.filter((call) => call.name === "rounds.frame").map((call) => (call.args as { key: string }).key);
const sendButton = (): HTMLElement => screen.getByRole("button", { name: "Send answers" });

describe("a design round", () => {
  it("renders every STATES variant as a labelled frame that opens full size", async () => {
    await renderDesign();
    scrollAll();

    for (const [key, label] of STATES) {
      const figure = screen.getByTestId(`design-frame-${key}`);
      expect(within(figure).getByText(label)).toBeTruthy();
      expect(await within(figure).findByRole("img", { name: label })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "Enlarge Busy" }));
    expect(screen.getByRole("dialog", { name: "Busy" })).toBeTruthy();
    expect(screen.queryByText("design round: open in the harness")).toBeNull();
  });

  it("shows a section's seeAlso frames as labelled thumbnails", async () => {
    await renderDesign();
    scrollAll();

    for (const [key, label] of [["beacon-idle", "Idle"], ["beacon-error", "Error"]]) {
      expect(await within(screen.getByTestId(`see-also-${key}`)).findByRole("img", { name: label })).toBeTruthy();
    }
    expect(screen.queryByTestId("see-also-beacon-busy")).toBeNull();
  });

  it("names a section key frames.json does not list and never asks for it", async () => {
    const rendered = await renderDesign();
    scrollAll();
    await screen.findAllByRole("img", { name: "Idle" });

    expect(within(screen.getByTestId("design-frame-beacon-sketch")).getByText("Not in frames.json")).toBeTruthy();
    expect(frameKeys(rendered)).not.toContain("beacon-sketch");
  });

  it("sends the picks and text with the round.json shown, once the required question is answered", async () => {
    const { calls } = await renderDesign();
    expect(sendButton().getAttribute("aria-disabled")).toBe("true");

    fireEvent.keyDown(window, { key: "2" });
    fireEvent.change(screen.getByLabelText("Answer to Anything from the sketch worth keeping?"), { target: { value: "Keep the halo." } });
    fireEvent.click(sendButton());

    await screen.findByText("Answers sent");
    const manifestSha256 = ((await getRound(source, DESIGN)) as Extract<RoundDetail, { valid: true }>).manifestSha256;
    expect(calls.find((call) => call.name === "rounds.submit")?.args).toEqual({
      id: DESIGN,
      manifestSha256,
      general: "",
      answers: [{ questionId: "beacon-fill-pick", pick: "Ring" }, { questionId: "beacon-notes", text: "Keep the halo." }],
    });
  });

  it("keeps an after-answer round's recommendation out until the round is sent", async () => {
    await renderDesign();
    expect(screen.queryByText(/^Recommended:/)).toBeNull();
    expect(screen.getByText("Recommendations show once the round is answered.")).toBeTruthy();
    cleanup();

    const read = await readManifest(path.join(source.dir, DESIGN));
    if (!read.parsed.ok) throw new Error(read.parsed.reason);
    await renderDesign({ detail: { status: "sent", recommendationsWithheld: false, manifest: read.parsed.manifest } });

    expect(screen.getByText("Recommended: Filled (80%, fixture-agent)")).toBeTruthy();
    expect(screen.getByText("Answers sent")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send answers" })).toBeNull();
  });
});

describe("a design round the console cannot show", () => {
  it.each([
    ["has no frames.json", successEnvelope({ indexed: false, frames: [] })],
    ["has an invalid frames.json", errorEnvelope("frame refused: the round's frames index is not a frames@1 index", 66)],
  ])("falls back to the harness notice when it %s", async (_label, listing) => {
    const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", await recorded({}, listing)), "text/html");
    window.location.hash = `#/rounds/${DESIGN}`;
    render(
      <RpcProvider source={pageDataSource({ doc: page })}>
        <App />
      </RpcProvider>,
    );

    await waitFor(() => expect(screen.getByText("design round: open in the harness")).toBeTruthy());
    expect(screen.queryByTestId("round-question-beacon-fill-pick")).toBeNull();
    expect(screen.queryByTestId("design-frame-beacon-idle")).toBeNull();
  });
});
