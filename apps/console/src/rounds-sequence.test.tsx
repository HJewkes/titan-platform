// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource } from "@titan-design/rpc-client";
import { stagedRound, type StagedRound } from "../server/round-fixtures.js";
import { getFrame, listFrames } from "../server/round-frames.js";
import { getRound } from "../server/rounds.js";
import { App } from "./App.js";
import { AnswerSourceProvider } from "./data/submit.js";
import { checkAndSend } from "./pages/round-pager.test-helpers.js";

const ROUND = "tally-motion-r1";
/** Two synthetic motions' progress stills, drawn from the beacon fixture's solid-block PNGs. */
const STILLS = [
  ["count-p0", "beacon-idle"],
  ["count-p0_5", "beacon-busy"],
  ["count-p1", "beacon-error"],
  ["reel-p0", "beacon-muted"],
  ["reel-p0_5", "beacon-idle"],
  ["reel-p1", "beacon-busy"],
] as const;
const labelOf = (key: string): string => key.replace(/-p(\d+)(?:_(\d+))?$/, (_, whole: string, part?: string) => ` at ${part ? `${whole}.${part}` : whole}`);

const manifest = {
  schema: "titan-review/round@2",
  unit: "tally-motion",
  round: 1,
  storybookUrl: "http://127.0.0.1:6006",
  widths: [390],
  variants: STILLS.map(([key, shot]) => ({ key, image: `shots/${shot}.png`, label: labelOf(key) })),
  sections: [
    { id: "motion", title: "Tally motion", deciding: "Whether the count and reel motions read.", changed: "Both motions are new.", context: "Synthetic.", kind: "STATES", variantKeys: STILLS.map(([key]) => key), questionIds: ["motion-notes"] },
  ],
  questions: [{ id: "motion-notes", kind: "text", prompt: "Anything off in either motion?" }],
};

async function framesIndex(dir: string): Promise<unknown> {
  const sha = async (shot: string): Promise<string> => createHash("sha256").update(await readFile(path.join(dir, "shots", `${shot}.png`))).digest("hex");
  const frames = await Promise.all(STILLS.map(async ([key, shot]) => ({ key, variant: key, viewport: { width: 320, height: 180 }, file: `shots/${shot}.png`, sha256: await sha(shot) })));
  return { schema: "titan-review/frames@1", unit: "tally-motion", round: 1, frames };
}

/** jsdom has no IntersectionObserver: every frame nears the viewport as soon as it is observed. */
class NearObserver {
  constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
  observe(): void {
    this.callback([{ isIntersecting: true }]);
  }
  disconnect(): void {}
}

let staged: StagedRound;
beforeEach(async () => {
  vi.stubGlobal("IntersectionObserver", NearObserver);
  staged = await stagedRound("beacon-states-r1", ROUND, manifest);
  const dir = path.join(staged.source.dir, ROUND);
  await mkdir(path.join(dir, "frames"), { recursive: true });
  await writeFile(path.join(dir, "frames", "frames.json"), JSON.stringify(await framesIndex(dir)));
});
afterEach(async () => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  await staged.remove();
});

async function renderRound(): Promise<{ name: string; args: unknown }[]> {
  const { source } = staged;
  const frames = await Promise.all(STILLS.map(async ([key]) => [snapshotKey("rounds.frame", { id: ROUND, key, view: "head" }), successEnvelope(await getFrame(source, ROUND, key, "head"))] as const));
  const calls = {
    [snapshotKey("rounds.get", { id: ROUND })]: successEnvelope(await getRound(source, ROUND)),
    [snapshotKey("rounds.frames", { id: ROUND })]: successEnvelope(await listFrames(source, ROUND)),
    ...Object.fromEntries(frames),
  };
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls }), "text/html");
  const inner = pageDataSource({ doc: page });
  const made: { name: string; args: unknown }[] = [];
  const submitted = successEnvelope({ status: "submitted", path: "feedback.json", sha256: "0".repeat(64), headSha: null });
  const counting: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, options) => (made.push({ name, args }), name === "rounds.submit" ? Promise.resolve(submitted) : inner.call(name, args, options)),
  };
  window.location.hash = `#/rounds/${ROUND}`;
  render(
    <RpcProvider source={counting}>
      <AnswerSourceProvider value={counting}>
        <App />
      </AnswerSourceProvider>
    </RpcProvider>,
  );
  await screen.findByText("Tally motion");
  return made;
}

const viewer = (base: string): HTMLElement => screen.getByTestId(`design-sequence-${base}`);

describe("a design round with a motion's progress stills", () => {
  it("draws two stepper viewers, count and reel, not six images", async () => {
    await renderRound();

    expect(screen.getAllByTestId(/^design-sequence-/).map((each) => each.dataset.testid)).toEqual(["design-sequence-count", "design-sequence-reel"]);
    expect(screen.queryByTestId(/^design-frame-/)).toBeNull();
    expect((await screen.findAllByRole("img")).map((img) => img.getAttribute("alt"))).toEqual(["count at 0", "reel at 0"]);
  });

  it("sends a verdict for the still on screen, keyed as its own variant, and marks its step", async () => {
    const calls = await renderRound();
    await screen.findAllByRole("img");

    fireEvent.click(within(viewer("count")).getByRole("button", { name: "Next step of count" }));
    fireEvent.click(within(screen.getByTestId("frame-feedback-count-p0_5")).getByRole("button", { name: "Chosen" }));

    expect(within(viewer("count")).getByRole("button", { name: "Step to progress 0.5, has feedback" })).toBeTruthy();
    checkAndSend();
    await act(async () => screen.findByText("Answers sent"));
    expect(calls.find((call) => call.name === "rounds.submit")?.args).toMatchObject({ variants: [{ key: "count-p0_5", verdict: "chosen" }] });
  });
});

