// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource } from "@titan-design/rpc-client";
import { RoundSchema, type Manifest } from "../../server/round-schema.js";
import { QuestionFrames, RoundFramesProvider } from "./QuestionFrames.js";
import { scaleCandidateKey } from "./TrueSize.js";

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
});

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

function renderFrames(): { name: string; args: unknown }[] {
  const keys = ["title-card", "lamp", ...captured];
  const calls = Object.fromEntries(keys.map((key) => [snapshotKey("rounds.frame", { id: ROUND, key, view: "head" }), png]));
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls }), "text/html");
  const inner = pageDataSource({ doc: page });
  const made: { name: string; args: unknown }[] = [];
  const counting: DataSource = { subscribe: inner.subscribe.bind(inner), call: (name, args, options) => (made.push({ name, args }), inner.call(name, args, options)) };
  render(
    <RpcProvider source={counting}>
      <RoundFramesProvider roundId={ROUND} manifest={manifest} indexed={new Set(captured)}>
        <QuestionFrames question={manifest.questions[0]!} />
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
