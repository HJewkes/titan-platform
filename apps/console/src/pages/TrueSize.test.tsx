// @vitest-environment jsdom
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource } from "@titan-design/rpc-client";
import { RoundSchema, type Manifest } from "../../server/round-schema.js";
import type { FrameDraft } from "./frame-feedback.js";
import { FrameFeedbackProvider, useFrameFeedback, type ActiveTarget } from "./FrameFeedback.js";
import { QuestionFrames, RoundFramesProvider } from "./QuestionFrames.js";
import { scaleCandidateKey, shownAt } from "./TrueSize.js";

/** Every frame nears the viewport as soon as it is observed. */
class NearObserver {
  constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
  observe(): void {
    this.callback([{ isIntersecting: true }]);
  }
  disconnect(): void {}
}

beforeEach(() => vi.stubGlobal("IntersectionObserver", NearObserver));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Every observed box reports `width` CSS px of room, as a laid-out page would. react-native-web keeps the first one it makes. */
function boxesAre(width: number): void {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: (entries: { target: Element; contentRect: { width: number } }[]) => void) {}
      observe(target: Element): void {
        this.callback([{ target, contentRect: { width } }]);
      }
      unobserve(): void {}
      disconnect(): void {}
    },
  );
}

/** Every PNG decodes to `width`×`height`; jsdom decodes none. */
function pngsAre(width: number, height: number): void {
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(height);
}

/** A design round's frame feedback around the frames, so they take verdicts and pins; `seen` gets each render's drafts. */
function WithFeedback({ seen, children }: { seen: (drafts: Readonly<Record<string, FrameDraft>>) => void; children: ReactNode }): ReactNode {
  const [active, setActive] = useState<ActiveTarget>();
  const state = useFrameFeedback(active, setActive, false);
  seen(state.drafts);
  return <FrameFeedbackProvider value={state}>{children}</FrameFeedbackProvider>;
}

const ROUND = "title-sizes-r1";
const notes = { changed: "The title card gained a caption.", context: "Colour is out of scope." };

const manifest: Manifest = RoundSchema.parse({
  schema: "titan-review/round@2",
  unit: "title-sizes",
  round: 1,
  storybookUrl: "http://127.0.0.1:6006",
  widths: [390],
  variants: [
    { key: "title-card", image: "shots/title-card.png", label: "Title card", frameReference: {} },
    { key: "caption-size", storyId: "caption--card", label: "Caption size", scale: { arg: "size", candidates: [24, 32, 48] } },
    { key: "lamp", image: "shots/lamp.png", label: "Lamp" },
  ],
  sections: [{ id: "size", title: "Caption size", deciding: "How big the caption is.", ...notes, kind: "STATES", variantKeys: ["title-card", "caption-size", "lamp"], questionIds: ["size-pick"] }],
  questions: [{ id: "size-pick", kind: "pick-one", prompt: "Which caption size?", options: ["24", "32", "48"], signsOff: "title-caption", frames: ["title-card", "caption-size", "lamp"] }],
});

/** The 24 and 32 candidates were captured; 48 was not. */
const captured = [scaleCandidateKey("caption-size", "size", 24), scaleCandidateKey("caption-size", "size", 32)];
const png = successEnvelope({ contentType: "image/png", bytes: 8, sha256: "0".repeat(64), base64: "iVBORw0KGgo=" });

function renderFrames(seen?: (drafts: Readonly<Record<string, FrameDraft>>) => void): { name: string; args: unknown }[] {
  const keys = ["title-card", "lamp", ...captured];
  const calls = Object.fromEntries(keys.map((key) => [snapshotKey("rounds.frame", { id: ROUND, key, view: "head" }), png]));
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls }), "text/html");
  const inner = pageDataSource({ doc: page });
  const made: { name: string; args: unknown }[] = [];
  const counting: DataSource = { subscribe: inner.subscribe.bind(inner), call: (name, args, options) => (made.push({ name, args }), inner.call(name, args, options)) };
  const frames = <QuestionFrames question={manifest.questions[0]!} />;
  render(
    <RpcProvider source={counting}>
      <RoundFramesProvider roundId={ROUND} manifest={manifest} indexed={new Set(captured)}>
        {seen ? <WithFeedback seen={seen}>{frames}</WithFeedback> : frames}
      </RoundFramesProvider>
    </RpcProvider>,
  );
  return made;
}

/** The box the image is drawn in: its width is the frame's true width at 1:1, unset when fitted. */
const imageBox = (img: HTMLElement): HTMLElement | null => img.closest("button")?.parentElement ?? null;
const html = (node: Element | null | undefined): HTMLElement => {
  if (!(node instanceof HTMLElement)) throw new Error("expected an HTML element");
  return node;
};
const keyOf = (args: unknown): unknown => (typeof args === "object" && args !== null && "key" in args ? args.key : undefined);
const sizeButton = (label: string, view: string): HTMLElement => within(screen.getByRole("group", { name: `Size of ${label}` })).getByRole("button", { name: view });

describe("a true-size frame (frameReference)", () => {
  it("starts fitted, and 1:1 draws the PNG at its declared CSS width in a box that scrolls", async () => {
    renderFrames();
    const img = await screen.findByRole("img", { name: "Title card" });
    expect(imageBox(img)?.style.width).toBe("");
    expect(screen.getByTestId("true-size-title-card").className).not.toContain("overflow-auto");

    fireEvent.click(sizeButton("Title card", "1:1"));

    expect(imageBox(screen.getByRole("img", { name: "Title card" }))?.style.width).toBe("1920px");
    expect(screen.getByTestId("true-size-title-card").className).toContain("overflow-auto");
    expect(screen.getByText("1920×1080 · 1:1")).toBeTruthy();
  });

  it("goes back to fitted on Fit", async () => {
    renderFrames();
    await screen.findByRole("img", { name: "Title card" });
    fireEvent.click(sizeButton("Title card", "1:1"));

    fireEvent.click(sizeButton("Title card", "Fit"));

    expect(imageBox(screen.getByRole("img", { name: "Title card" }))?.style.width).toBe("");
    expect(screen.getByTestId("true-size-title-card").dataset.view).toBe("fit");
  });

  it("lays its ladder over the frame, each bar its rung's share of the frame's height", async () => {
    renderFrames();
    await screen.findByRole("img", { name: "Title card" });

    const ladder = within(screen.getByTestId("true-size-title-card")).getByTestId("frame-ladder");
    const rungs = within(ladder).getAllByRole("listitem");
    expect(rungs.map((rung) => rung.textContent)).toEqual(["caption 24px", "body 32px", "title 64px", "display 96px"]);
    expect(html(rungs[2]?.firstElementChild).style.height).toBe(`${(64 / 1080) * 100}%`);
  });
});

describe("a scale question's frame", () => {
  it("draws every candidate in one full-size frame beside the ladder, fetching only the captured ones", async () => {
    const calls = renderFrames();
    const frame = screen.getByTestId("scale-frame-caption-size");

    expect(await within(frame).findByRole("img", { name: "Caption size at size 24" })).toBeTruthy();
    expect(within(frame).getByRole("img", { name: "Caption size at size 32" })).toBeTruthy();
    expect(within(screen.getByTestId(`scale-cell-${scaleCandidateKey("caption-size", "size", 48)}`)).getByText("Not captured")).toBeTruthy();
    expect(within(frame).getByTestId("scale-ladder")).toBeTruthy();
    expect(screen.getAllByTestId(/^scale-frame-/)).toHaveLength(1);
    const fetched = calls.filter((call) => call.name === "rounds.frame").map((call) => keyOf(call.args));
    expect(fetched).not.toContain("caption-size");
    expect(fetched).not.toContain(scaleCandidateKey("caption-size", "size", 48));
  });

  it("sizes the whole frame to 1920×1080 CSS px on 1:1", () => {
    renderFrames();
    const box = screen.getByTestId("scale-box-caption-size");
    expect(html(box.firstElementChild).style.aspectRatio).toBe("1920 / 1080");

    fireEvent.click(sizeButton("Caption size", "1:1"));

    const canvas = html(box.firstElementChild);
    expect([canvas.style.width, canvas.style.height]).toEqual(["1920px", "1080px"]);
    expect(box.className).toContain("overflow-auto");
  });
});

describe("a fitted frame's caption", () => {
  it("says the share of its declared width a true-size frame is shown at, below that width", async () => {
    boxesAre(960);
    renderFrames();
    await screen.findByRole("img", { name: "Title card" });

    expect(within(screen.getByTestId("question-frames-size-pick")).getAllByText("1920×1080 · shown at 50%")).toHaveLength(2);
  });

  it("says 1:1 when the box has room for the declared width, and the fitted box never grows past it", async () => {
    boxesAre(2400);
    renderFrames();
    await screen.findByRole("img", { name: "Title card" });

    expect(within(screen.getByTestId("question-frames-size-pick")).getAllByText("1920×1080 · 1:1")).toHaveLength(2);
    expect(screen.getByTestId("true-size-title-card").style.maxWidth).toBe("1920px");
  });

  it("rounds the share, says 1:1 in the 1:1 view, and fitted before the box is measured", () => {
    expect(shownAt("fit", 0.4687)).toBe("shown at 47%");
    expect(shownAt("actual", 0.5)).toBe("1:1");
    expect(shownAt("fit", undefined)).toBe("fitted");
  });
});

describe("a loaded frame's size check", () => {
  it("warns when a true-size PNG is not the size its frame reference declares", async () => {
    pngsAre(1280, 720);
    renderFrames();

    fireEvent.load(await screen.findByRole("img", { name: "Title card" }));

    expect(screen.getByTestId("wrong-size-title-card").textContent).toBe("Image Title card is 1280×720; its frame reference declares 1920×1080");
    expect(screen.getByTestId("wrong-size-title-card").getAttribute("role")).toBe("alert");
  });

  it("warns on a scale candidate whose capture is not the scale frame's size, and on no PNG of the declared size", async () => {
    renderFrames();
    const wrong = await screen.findByRole("img", { name: "Caption size at size 24" });
    pngsAre(3840, 2160);
    fireEvent.load(wrong);
    pngsAre(1920, 1080);
    fireEvent.load(screen.getByRole("img", { name: "Caption size at size 32" }));
    fireEvent.load(screen.getByRole("img", { name: "Title card" }));

    expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual(["Capture Caption size at size 24 is 3840×2160; its frame reference declares 1920×1080"]);
  });
});

describe("pins on a scale frame", () => {
  it("places a pin on the composed frame, measured in its declared px and on no element", async () => {
    let drafts: Readonly<Record<string, FrameDraft>> = {};
    renderFrames((each) => (drafts = each));
    const figure = screen.getByTestId("scale-frame-caption-size").closest("figure");
    if (figure === null) throw new Error("expected the scale frame's figure");
    fireEvent.pointerDown(figure);
    fireEvent.click(within(figure).getByRole("button", { name: "Pin Caption size" }));
    const layer = screen.getByTestId("pin-layer-caption-size");
    vi.spyOn(layer, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 960, height: 540, right: 960, bottom: 540, x: 0, y: 0, toJSON: () => ({}) });

    act(() => {
      fireEvent.pointerDown(layer, { clientX: 480, clientY: 135 });
      fireEvent.pointerUp(layer, { clientX: 480, clientY: 135 });
    });

    expect(within(layer).getByTestId("pin-marker-caption-size-1").textContent).toBe("1");
    expect(drafts["caption-size"]?.pins).toEqual([{ id: "caption-size-1", width: 1920, x: 960, y: 270, xPct: 0.5, yPct: 0.25, note: "" }]);
    expect(screen.getByLabelText("Note for pin 1")).toBeTruthy();
  });
});

describe("a frame with neither field", () => {
  it("draws its PNG fitted as before, with no size toggle and no ladder", async () => {
    renderFrames();
    const img = await screen.findByRole("img", { name: "Lamp" });

    expect(imageBox(img)?.style.width).toBe("");
    expect(screen.queryByRole("group", { name: "Size of Lamp" })).toBeNull();
    expect(img.closest("figure")?.querySelector('[data-testid="frame-ladder"]')).toBeNull();
  });
});

describe("scaleCandidateKey", () => {
  it("names a candidate as the harness names its capture, with unsafe characters folded", () => {
    expect(scaleCandidateKey("caption-size", "size", 1.5)).toBe("caption-size-size-1_5");
    expect(scaleCandidateKey("caption-size", "tone", "extra bold")).toBe("caption-size-tone-extra_bold");
  });
});
