/**
 * The page side of a live story frame (TP-3793 S4): its states, the bridge messages it trusts, its
 * url on the story origin, and the cap on how many frames are mounted at once. `LiveFrame.tsx` draws
 * them. The PNG stays the record; a live frame is a viewing aid, so nothing here changes an answer.
 */
import { z } from "zod";
import type { Manifest, Question } from "../../server/round-schema.js";
import { BRIDGE_TAG } from "../../server/story-bridge.js";
import type { RoundLive } from "../../server/storybook-build.js";

/** The frame's whole sandbox: no top navigation, popups or modals. `allow-same-origin` keeps only the story origin's own. */
export const LIVE_SANDBOX = "allow-scripts allow-same-origin allow-forms";
/** The bridge stops looking for Storybook's channel at the same point. */
export const READY_TIMEOUT_MS = 10_000;
/** A dead story remounts this many times by itself before it falls back to its PNG. */
const AUTO_REMOUNTS = 1;
/** Mounted live frames per screen (plan §5 U6); frames past the cap wait as their PNG. */
export const LIVE_CAP = { phone: 4, desktop: 8 } as const;
export const PHONE_WIDTH = "(max-width: 639px)";
/** The height a frame takes before the bridge has measured its story. */
const UNMEASURED_HEIGHT = 480;

type LivePhase = "mounting" | "live" | "dead";

export interface LiveState {
  phase: LivePhase;
  /** Bumped on every remount; the iframe is keyed by it, so a remount loads the story afresh. */
  mount: number;
  failures: number;
  height?: number;
}

export type LiveEvent = { type: "ready" } | { type: "failed" } | { type: "height"; height: number } | { type: "retry" };

export const MOUNTING: LiveState = { phase: "mounting", mount: 0, failures: 0 };

/** A failure only counts while mounting: the bridge settles once, so a frame that went live stays live. */
export function liveReducer(state: LiveState, event: LiveEvent): LiveState {
  switch (event.type) {
    case "ready":
      return state.phase === "mounting" ? { ...state, phase: "live" } : state;
    case "failed":
      if (state.phase !== "mounting") return state;
      if (state.failures >= AUTO_REMOUNTS) return { ...state, phase: "dead", failures: state.failures + 1 };
      return { phase: "mounting", mount: state.mount + 1, failures: state.failures + 1 };
    case "height":
      return { ...state, height: event.height };
    case "retry":
      return { ...MOUNTING, mount: state.mount + 1 };
  }
}

const BridgeMessageSchema = z.discriminatedUnion("type", [
  z.object({ bridge: z.literal(BRIDGE_TAG), type: z.literal("ready") }),
  z.object({ bridge: z.literal(BRIDGE_TAG), type: z.literal("error"), reason: z.string() }),
  z.object({ bridge: z.literal(BRIDGE_TAG), type: z.literal("height"), height: z.number().finite().positive() }),
]);

/**
 * A bridge message from this frame's own window on the story origin, as a state event; anything
 * else, such as another frame's message or a story's own postMessage traffic, is undefined.
 */
export function bridgeEvent(event: MessageEvent, storyOrigin: string, frame: Window | null | undefined): LiveEvent | undefined {
  if (frame === null || frame === undefined || event.source !== frame || event.origin !== storyOrigin) return undefined;
  const parsed = BridgeMessageSchema.safeParse(event.data);
  if (!parsed.success) return undefined;
  const message = parsed.data;
  if (message.type === "error") return { type: "failed" };
  return message.type === "height" ? { type: "height", height: message.height } : { type: "ready" };
}

/** The story's url on the story origin, naming the page's origin as `?parent=`, the only target the bridge posts to. */
export function liveSrc(url: string, storyOrigin: string, pageOrigin: string): string {
  const src = new URL(url, storyOrigin);
  src.searchParams.set("parent", pageOrigin);
  return src.href;
}

type FrameHeight = "auto" | number;

/** A declared height is fixed; `auto` follows the bridge's measure, capped at `maxHeight`, past which the story scrolls inside. */
export function frameHeight(declared: FrameHeight, measured: number | undefined, maxHeight: number): number {
  if (declared !== "auto") return declared;
  return Math.min(measured ?? UNMEASURED_HEIGHT, maxHeight);
}

const sha7 = (sha: string): string => sha.slice(0, 7);

/** The caption's build part: the sha a live frame runs, or that it was built from uncommitted changes there. */
export const builtAt = (buildSha: string, dirty: boolean): string => (dirty ? `built from uncommitted changes at ${sha7(buildSha)}` : `live @ ${sha7(buildSha)}`);

/** "1440px · shown at 58% · live @ abc1234", as the harness captions a frame; a frame drawn 1:1 leaves the share out. */
export function liveCaption(width: number, fit: number | undefined, built: string): string {
  const shown = fit !== undefined && fit < 1 ? [`shown at ${Math.round(fit * 100)}%`] : [];
  return [`${width}px`, ...shown, built].join(" · ");
}

type Variant = Manifest["variants"][number];

export const isShipQuestion = (question: Question): boolean => question.decision === "ship" || (question.kind === "pick-one" && question.merge !== undefined);

/** The keys a Ship approves: a Ship question's own frames and every frame of a section that holds one. */
function shipBoundKeys(manifest: Manifest): Set<string> {
  const ships = manifest.questions.filter(isShipQuestion);
  const shipIds = new Set(ships.map((question) => question.id));
  const sectionKeys = manifest.sections.filter((section) => section.questionIds.some((id) => shipIds.has(id))).flatMap((section) => section.variantKeys);
  return new Set([...ships.flatMap((question) => question.frames ?? []), ...sectionKeys]);
}

export interface LiveSizing {
  /** One live frame per manifest width, each that many CSS px wide before it is fitted. */
  widths: readonly number[];
  height: FrameHeight;
  maxHeight: number;
}

/** What one variant's live frame needs from the round. */
export interface LiveEntry {
  record: RoundLive["frames"][string];
  storyOrigin: string | null;
  sizing: LiveSizing;
  /** A Ship-bound frame shows the approved PNG first, with "Open live". */
  shipBound: boolean;
}

/** Each story variant's live entry, by key; empty for a round that carries no build. */
export function liveEntries(manifest: Manifest, live: RoundLive | undefined): Map<string, LiveEntry> {
  if (live === undefined) return new Map();
  const ship = shipBoundKeys(manifest);
  const variants = new Map<string, Variant>(manifest.variants.map((variant) => [variant.key, variant]));
  return new Map(
    Object.entries(live.frames).map(([key, record]) => {
      const sizing = { widths: manifest.widths, height: variants.get(key)?.height ?? manifest.height, maxHeight: manifest.maxHeight };
      return [key, { record, storyOrigin: live.origin, sizing, shipBound: ship.has(key) }];
    }),
  );
}

interface LiveSlots {
  request: (id: symbol) => void;
  release: (id: symbol) => void;
  granted: (id: symbol, cap: number) => boolean;
  subscribe: (listener: () => void) => () => void;
}

/** First come, first served: the first `cap` frames that asked hold a slot, and a release lets the next one in. */
export function createLiveSlots(): LiveSlots {
  let queue: readonly symbol[] = [];
  const listeners = new Set<() => void>();
  const update = (next: readonly symbol[]): void => {
    queue = next;
    listeners.forEach((listener) => listener());
  };
  return {
    request: (id) => {
      if (!queue.includes(id)) update([...queue, id]);
    },
    release: (id) => {
      if (queue.includes(id)) update(queue.filter((each) => each !== id));
    },
    granted: (id, cap) => {
      const at = queue.indexOf(id);
      return at !== -1 && at < cap;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
