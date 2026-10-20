// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { RoundSchema, type Manifest } from "../../server/round-schema.js";
import { RoundFramesProvider, frameAnchor, questionAnchor } from "./QuestionFrames.js";
import { RoundSections, orderedQuestions, useRoundAnswers } from "./RoundSections.js";

/** Frames stay unfetched: this observer never reports an intersection. */
class IdleObserver {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => vi.stubGlobal("IntersectionObserver", IdleObserver));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const notes = { changed: "The lamp gained a glow.", context: "The shade is out of scope." };

const manifest: Manifest = RoundSchema.parse({
  schema: "titan-review/round@2",
  unit: "lamp-glow",
  round: 1,
  storybookUrl: "http://127.0.0.1:6006",
  widths: [390],
  variants: [
    { key: "lamp-subtle", image: "shots/lamp-subtle.png", label: "Subtle glow" },
    { key: "lamp-built", image: "shots/lamp-built.png", label: "As built" },
    { key: "lamp-off", image: "shots/lamp-off.png", label: "Unlit" },
    { key: "lamp-sketch", storyId: "lamp--sketch", label: "Sketch" },
  ],
  sections: [
    { id: "glow", title: "Lamp glow", deciding: "How strong the glow is.", ...notes, kind: "CHOICE", variantKeys: ["lamp-subtle", "lamp-built", "lamp-off"], questionIds: ["glow-pick"] },
    { id: "ship", title: "Ship it", deciding: "Whether the lamp ships.", ...notes, kind: "STATES", variantKeys: ["lamp-sketch"], questionIds: ["glow-ship"] },
    { id: "notes", title: "Notes", deciding: "Anything else.", ...notes, questionIds: ["glow-notes"] },
  ],
  questions: [
    { id: "glow-pick", kind: "pick-one", prompt: "Which glow?", options: ["Subtle", "Bright", "Off"], optionVariants: { Subtle: "lamp-subtle", Bright: "lamp-built", Off: "lamp-off" }, frames: ["lamp-subtle", "lamp-built"], signsOff: "lamp-glow" },
    { id: "glow-ship", kind: "pick-one", decision: "ship", prompt: "Ship the lamp?", options: ["Release the sketched lamp", "Hold the lamp"], frames: ["lamp-sketch"], signsOff: "lamp-release" },
    { id: "glow-notes", kind: "text", prompt: "Anything else about the lamp?" },
  ],
});

function Page({ framed = true }: { framed?: boolean }): ReactNode {
  const state = useRoundAnswers(orderedQuestions(manifest).flatMap((group) => group.questions));
  const sections = <RoundSections manifest={manifest} state={state} textAnswers />;
  return framed ? <RoundFramesProvider roundId="lamp-glow-r1" manifest={manifest}>{sections}</RoundFramesProvider> : sections;
}

const questionCard = (id: string): HTMLElement => screen.getByTestId(`round-question-${id}`);
const targetOf = (link: HTMLElement): HTMLElement | null => document.getElementById((link.closest("a")?.getAttribute("href") ?? "").slice(1));

describe("a question with frames", () => {
  it("draws its frames inside its own block, above its prompt", () => {
    render(<Page />);
    const card = questionCard("glow-pick");
    const strip = within(card).getByTestId("question-frames-glow-pick");
    expect(within(strip).getByText("Subtle glow")).toBeTruthy();
    expect(within(strip).getByText("As built")).toBeTruthy();
    expect(strip.compareDocumentPosition(within(card).getByText("Which glow?")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("links each frame back to its question, and the question to each frame", () => {
    render(<Page />);
    const card = questionCard("glow-pick");
    const back = within(card).getAllByText("To its question");
    expect(back.map((link) => targetOf(link)?.id)).toEqual([questionAnchor("glow-pick"), questionAnchor("glow-pick")]);
    const toFrame = within(card).getAllByRole("link").find((link) => link.textContent === "As built");
    expect(toFrame && targetOf(toFrame)?.id).toBe(frameAnchor("glow-pick", "lamp-built"));
  });

  it("names the frame each option picks", () => {
    render(<Page />);
    expect(within(questionCard("glow-pick")).getByText("1 Subtle (frame: Subtle glow)")).toBeTruthy();
    expect(within(questionCard("glow-pick")).getByText("2 Bright (frame: As built)")).toBeTruthy();
  });

  it("on a Ship question, says which frames a Ship approves", () => {
    render(<Page />);
    expect(within(questionCard("glow-ship")).getByText("Ships: Sketch")).toBeTruthy();
    expect(within(questionCard("glow-pick")).queryByText(/^Ships:/)).toBeNull();
  });

  it("marks a frame with no image instead of fetching one", () => {
    render(<Page />);
    expect(within(questionCard("glow-ship")).getByText("No image for this frame")).toBeTruthy();
    expect(within(questionCard("glow-pick")).getAllByText("Loads when scrolled into view")).toHaveLength(2);
  });
});

describe("a question without frames", () => {
  it("keeps today's layout: no strip, no frame links, plain option labels", () => {
    render(<Page />);
    const card = questionCard("glow-notes");
    expect(within(card).queryByTestId("question-frames-glow-notes")).toBeNull();
    expect(within(card).queryByText("Frames:")).toBeNull();
  });

  it("outside a round's provider, every question draws as before", () => {
    render(<Page framed={false} />);
    expect(screen.queryByTestId("question-frames-glow-pick")).toBeNull();
    expect(screen.getByText("1 Subtle")).toBeTruthy();
    expect(screen.queryByText(/^Ships:/)).toBeNull();
  });
});
