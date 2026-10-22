// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RpcProvider } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import type { DataSource } from "@titan-design/rpc-client";
import type { ReactNode } from "react";
import { RoundSchema, type Manifest, type Question } from "../../server/round-schema.js";
import { BRIDGE_TAG } from "../../server/story-bridge.js";
import type { RoundLive } from "../../server/storybook-build.js";
import { LiveViewedProvider } from "../data/live-viewed.js";
import { AnswerSourceProvider, useSubmit } from "../data/submit.js";
import { QuestionFrames, RoundFramesProvider } from "./QuestionFrames.js";

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

const ROUND = "lantern-cards-r1";
const STORY_ORIGIN = "http://127.0.0.1:7501";
const KEYS = ["compact", "roomy"];
const notes = { changed: "Two densities replace the single card.", context: "Card colours are out of scope." };
const manifest: Manifest = RoundSchema.parse({
  schema: "titan-review/round@2",
  unit: "lantern-cards",
  round: 1,
  storybookUrl: "http://127.0.0.1:6006",
  widths: [390],
  variants: KEYS.map((key) => ({ key, storyId: `lantern-card--${key}`, label: `Card ${key}` })),
  sections: [{ id: "density", title: "Card density", deciding: "Which density the cards use.", ...notes, kind: "CHOICE", variantKeys: KEYS, questionIds: ["density-pick"] }],
  questions: [{ id: "density-pick", kind: "pick-one", prompt: "Which density?", options: KEYS, frames: KEYS, signsOff: "card-density" }],
});
const found: Question | undefined = manifest.questions.find((each) => each.id === "density-pick");
if (found === undefined) throw new Error("no question density-pick");
const question: Question = found;
const live: RoundLive = { origin: STORY_ORIGIN, frames: Object.fromEntries(KEYS.map((key) => [key, { url: `/sb/${"b".repeat(64)}/iframe.html?id=lantern-card--${key}&viewMode=story`, buildSha: "a".repeat(40) }])) };

function recordingSource(): { source: DataSource; submits: unknown[] } {
  const submits: unknown[] = [];
  const source: DataSource = {
    subscribe: () => ({ close: () => undefined }),
    call: (name, args) => {
      if (name === "rounds.submit") submits.push(args);
      return Promise.resolve(successEnvelope(name === "rounds.submit" ? { status: "submitted" } : { contentType: "image/png", bytes: 8, sha256: "c".repeat(64), base64: "iVBORw0KGgo=" }));
    },
  };
  return { source, submits };
}

function SendButton(): ReactNode {
  const { submit } = useSubmit();
  return <button type="button" onClick={() => void submit({ id: ROUND, manifestSha256: "d".repeat(64), answers: [] })}>Send</button>;
}

function renderRound(source: DataSource): void {
  render(
    <RpcProvider source={source}>
      <AnswerSourceProvider value={source}>
        <LiveViewedProvider>
          <RoundFramesProvider roundId={ROUND} manifest={manifest} indexed={new Set(KEYS)} live={live}>
            <QuestionFrames question={question} />
          </RoundFramesProvider>
          <SendButton />
        </LiveViewedProvider>
      </AnswerSourceProvider>
    </RpcProvider>,
  );
}

function storyRendered(key: string): void {
  const frame = screen.getByTitle(`Card ${key}, live at 390px`);
  if (!(frame instanceof HTMLIFrameElement)) throw new Error("expected an iframe");
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { bridge: BRIDGE_TAG, type: "ready" }, origin: STORY_ORIGIN, source: frame.contentWindow }));
  });
}

async function send(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await Promise.resolve();
  });
}

describe("the variants a round page sends as viewed live (TP-3793 S7)", () => {
  it("sends only the keys whose live story rendered", async () => {
    const { source, submits } = recordingSource();
    renderRound(source);
    await screen.findByAltText("Card compact");

    storyRendered("compact");
    await send();

    expect(submits).toEqual([expect.objectContaining({ liveViewed: ["compact"] })]);
  });

  it("leaves liveViewed out when no story rendered", async () => {
    const { source, submits } = recordingSource();
    renderRound(source);
    await screen.findByAltText("Card compact");

    await send();

    expect(submits).toHaveLength(1);
    expect(submits[0]).not.toHaveProperty("liveViewed");
  });
});
