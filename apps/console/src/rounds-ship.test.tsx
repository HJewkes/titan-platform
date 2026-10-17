// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { FIXTURE_ROUNDS as source } from "../server/round-fixtures.js";
import { getFrame } from "../server/round-frames.js";
import { getRound, listRounds, type RoundDetail } from "../server/rounds.js";
import { App } from "./App.js";
import { AnswerSourceProvider } from "./data/submit.js";

const SHIP = "ship-tile-r1";
const HEAD = "89abcdef0123456789abcdef0123456789abcdef";
const FRAMES = [
  { key: "tile-light", theme: "light", views: ["head", "base", "diff"] },
  { key: "tile-dark", theme: "dark", views: ["head", "base", "diff"] },
  { key: "panel-wide", theme: "light", views: ["head", "base"] },
  { key: "badge-new", views: ["head"] },
] as const;
const IMAGE_COUNT = FRAMES.reduce((sum, frame) => sum + frame.views.length, 0);

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

/** A CI packet's tile-light: its head is the montage and `after` the changed image alone. */
const PACKET_FRAMES = [{ key: "tile-light", theme: "light", views: ["head", "base", "after", "diff"] }, ...FRAMES.slice(1)];

/** The daemon's answers over the synthetic Ship fixture; `detail` overrides the recorded rounds.get fields. */
async function recorded(detail: Partial<RoundDetail> = {}, listed: readonly unknown[] = FRAMES): Promise<Snapshot> {
  const frames = await Promise.all(
    FRAMES.flatMap(({ key, views }) => views.map(async (view) => [snapshotKey("rounds.frame", { id: SHIP, key, view }), successEnvelope(await getFrame(source, SHIP, key, view))] as const)),
  );
  return {
    format: SNAPSHOT_FORMAT,
    createdAt: "2031-03-05T00:00:00.000Z",
    calls: {
      [snapshotKey("rounds.get", { id: SHIP })]: successEnvelope({ ...(await getRound(source, SHIP)), ...detail }),
      [snapshotKey("rounds.frames", { id: SHIP })]: successEnvelope({ frames: listed }),
      ...Object.fromEntries(frames),
      [snapshotKey("rounds.frame", { id: SHIP, key: "tile-light", view: "after" })]: successEnvelope(await getFrame(source, SHIP, "tile-light", "head")),
    },
  };
}

interface Rendered {
  calls: { name: string; args: unknown }[];
}

/** Renders the Ship round over a recorded snapshot; with `answers` the page may send, and rounds.submit answers "submitted". */
async function renderShip(options: { answers?: boolean; detail?: Partial<RoundDetail>; listed?: readonly unknown[] } = {}): Promise<Rendered> {
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", await recorded(options.detail, options.listed)), "text/html");
  const inner = pageDataSource({ doc: page });
  const calls: Rendered["calls"] = [];
  const submitted = successEnvelope({ status: "submitted", path: "feedback.json", sha256: "0".repeat(64), headSha: HEAD });
  const counting: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, callOptions) => (calls.push({ name, args }), name === "rounds.submit" ? Promise.resolve(submitted) : inner.call(name, args, callOptions)),
  };
  window.location.hash = `#/rounds/${SHIP}`;
  render(
    <RpcProvider source={counting}>
      <AnswerSourceProvider value={options.answers ? counting : null}>
        <App />
      </AnswerSourceProvider>
    </RpcProvider>,
  );
  await screen.findByTestId("montage-tile-light");
  return { calls };
}

const panelLabels = (key: string): string[] => within(screen.getByTestId(`montage-${key}`)).getAllByText(/^(BEFORE|AFTER|DIFF)$/).map((label) => label.textContent);
const button = (label: string): HTMLElement => screen.getByRole("button", { name: label });
const frameCalls = ({ calls }: Rendered) => calls.filter((call) => call.name === "rounds.frame");

describe("the Ship view", () => {
  it("renders a merge-bound round as the Ship view with its PR head, not the design notice", async () => {
    await renderShip();

    expect(screen.getByText("Ships example/tiles#1 at 89abcde")).toBeTruthy();
    expect(screen.queryByText("design round: open in the harness")).toBeNull();
  });

  it("labels the Ship round in the rounds list", async () => {
    const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls: { [snapshotKey("rounds.list", {})]: successEnvelope(await listRounds(source)) } }), "text/html");
    window.location.hash = "#/rounds";
    render(<RpcProvider source={pageDataSource({ doc: page })}><App /></RpcProvider>);

    expect(within(await screen.findByTestId(`round-row-${SHIP}`)).getByText("ship")).toBeTruthy();
  });

  it("shows a changed image as BEFORE, AFTER and DIFF, and a new one as NEW with AFTER only", async () => {
    await renderShip();

    expect(panelLabels("tile-light")).toEqual(["BEFORE", "AFTER", "DIFF"]);
    expect(panelLabels("badge-new")).toEqual(["AFTER"]);
    expect(within(screen.getByTestId("montage-badge-new")).getByText("NEW")).toBeTruthy();
    expect(within(screen.getByTestId("montage-tile-light")).queryByText("NEW")).toBeNull();
    expect(within(screen.getByTestId("montage-panel-wide")).getByText("No diff image: compare before and after side by side.")).toBeTruthy();
  });

  it("pairs the light and dark renders of one image", async () => {
    await renderShip();

    const pair = screen.getByTestId("theme-pair-tile-light");
    expect(within(pair).getByTestId("montage-tile-dark")).toBeTruthy();
    expect(within(pair).getByText("light")).toBeTruthy();
    expect(within(pair).getByText("dark")).toBeTruthy();
    expect(screen.queryByTestId("theme-pair-panel-wide")).toBeNull();
  });

  it("fetches no image until it nears the viewport, then one call per image", async () => {
    const rendered = await renderShip();
    expect(frameCalls(rendered)).toHaveLength(0);

    scrollAll();

    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(IMAGE_COUNT));
    expect(frameCalls(rendered)).toHaveLength(IMAGE_COUNT);
    expect(frameCalls(rendered)).toContainEqual({ name: "rounds.frame", args: { id: SHIP, key: "tile-dark", view: "diff" } });
  });

  it("reads AFTER from a CI packet's after image, not its montage head", async () => {
    const rendered = await renderShip({ listed: PACKET_FRAMES });

    scrollAll();

    await waitFor(() => expect(frameCalls(rendered)).toHaveLength(IMAGE_COUNT));
    expect(frameCalls(rendered)).toContainEqual({ name: "rounds.frame", args: { id: SHIP, key: "tile-light", view: "after" } });
    expect(frameCalls(rendered)).not.toContainEqual({ name: "rounds.frame", args: { id: SHIP, key: "tile-light", view: "head" } });
  });

  it("keeps the recommendation out of the page while the round is open", async () => {
    await renderShip();

    expect(screen.queryByText(/^Recommended:/)).toBeNull();
    expect(screen.queryByText(/nothing else shifted/)).toBeNull();
  });

  it("opens an image full size when pressed and closes on Escape", async () => {
    await renderShip();
    scrollAll();

    fireEvent.click(await screen.findByRole("button", { name: "Enlarge Badge (new), after" }));
    expect(screen.getByRole("dialog", { name: "Badge (new), after" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("answering a Ship round", () => {
  const submits = ({ calls }: Rendered) => calls.filter((call) => call.name === "rounds.submit").map((call) => call.args);

  it("sends Ship bound to the question's head sha and the round.json shown", async () => {
    const rendered = await renderShip({ answers: true });
    const detail = await getRound(source, SHIP);
    if (!detail.valid) throw new Error("the Ship fixture is not a valid round");
    const { manifestSha256 } = detail;

    fireEvent.click(button("Ship"));

    await waitFor(() => expect(submits(rendered)).toHaveLength(1));
    expect(submits(rendered)[0]).toEqual({ id: SHIP, manifestSha256, general: "", headSha: HEAD, answers: [{ questionId: "ship-tiles", pick: "Ship" }] });
    expect(await screen.findByText("Waiting for the factory")).toBeTruthy();
  });

  it("sends Send back as the other option, with the owner's note as its comment and no head sha", async () => {
    const rendered = await renderShip({ answers: true });

    fireEvent.change(screen.getByLabelText("Note for Send back"), { target: { value: "  The stripe is two pixels low.  " } });
    fireEvent.click(button("Send back"));

    await waitFor(() => expect(submits(rendered)).toHaveLength(1));
    expect(submits(rendered)[0]).toMatchObject({ answers: [{ questionId: "ship-tiles", pick: "Don't ship", comment: "The stripe is two pixels low." }] });
    expect(submits(rendered)[0]).not.toHaveProperty("headSha");
  });

  it("disables both answers on a snapshot page and sends nothing", async () => {
    const rendered = await renderShip();

    fireEvent.click(button("Ship"));
    fireEvent.click(button("Send back"));

    expect(button("Ship").getAttribute("aria-disabled")).toBe("true");
    expect(button("Send back").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("This page is a snapshot: answer from the live console.")).toBeTruthy();
    expect(submits(rendered)).toHaveLength(0);
  });

  it("never says Merging for a resolved Send back", async () => {
    await renderShip({ answers: true, detail: { status: "sent", answer: { status: "resolved", at: "2031-03-05T00:01:00.000Z", choice: "send-back" } } });

    expect(screen.getByText("Sent back: the implementer gets your note")).toBeTruthy();
    expect(screen.queryByText(/^Merging at/)).toBeNull();
  });

  it.each([
    [undefined, "Waiting for the factory"],
    [{ status: "resolved", at: "2031-03-05T00:01:00.000Z", choice: "merge" }, "Merging at 89abcde"],
    [{ status: "resolved", at: "2031-03-05T00:01:00.000Z", choice: "send-back" }, "Sent back: the implementer gets your note"],
    [{ status: "resolved", at: "2031-03-05T00:01:00.000Z" }, "Answer applied"],
    [{ status: "moved", at: "2031-03-05T00:01:00.000Z", currentHead: "fedcba9876543210fedcba9876543210fedcba98" }, "Head moved to fedcba9; a new round follows"],
    [{ status: "refused", at: "2031-03-05T00:01:00.000Z", reason: "the gate is held" }, "Not applied: the gate is held"],
  ] as const)("shows a sent round's gate outcome %j as %j in place of the buttons", async (answer, line) => {
    await renderShip({ answers: true, detail: { status: "sent", answer } });

    expect(screen.getByText(line)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ship" })).toBeNull();
  });
});
