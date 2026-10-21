/**
 * A round's story variant, live from the round's Storybook build on the story origin (TP-3793 S4).
 * The frame's captured PNG is its placeholder until the bridge in that frame posts `ready`, and its
 * fallback when the story dies. The PNG is what the owner approves; a live frame is a viewing aid.
 */
import { useEffect, useReducer, useRef, useState, useSyncExternalStore, type Dispatch, type ReactNode, type RefObject } from "react";
import { Button, ButtonText, HStack, Typography, VStack } from "@titan-design/react-ui";
import { useMediaQuery } from "./FramePins.js";
import { FrameImage, NEAR_VIEWPORT, useEscapeKey } from "./RoundFrame.js";
import { useFitScale } from "./TrueSize.js";
import {
  LIVE_CAP,
  LIVE_SANDBOX,
  MOUNTING,
  PHONE_WIDTH,
  READY_TIMEOUT_MS,
  bridgeEvent,
  builtAt,
  createLiveSlots,
  frameHeight,
  liveCaption,
  liveReducer,
  liveSrc,
  type LiveEntry,
  type LiveEvent,
  type LiveSizing,
  type LiveState,
} from "./live-frame.js";

/** One page shows one set of frames, so one queue caps them all. */
const slots = createLiveSlots();

interface PngProps {
  roundId: string;
  frameKey: string;
  alt: string;
  /** Whether the frame's captured PNG may be fetched. */
  loadable: boolean;
}

type LiveFrameProps = PngProps & LiveEntry;

/** A story variant's frame: live where its build allows, else its PNG and the reason it is not live. */
export function LiveFrame({ record, storyOrigin, sizing, shipBound, ...png }: LiveFrameProps): ReactNode {
  if ("reason" in record) return <CapturedFrame {...png} note={record.reason} />;
  if (storyOrigin === null) return <CapturedFrame {...png} note="The console serves no story origin" />;
  const story = { src: liveSrc(record.url, storyOrigin, window.location.origin), origin: storyOrigin, built: builtAt(record.buildSha, record.dirty === true) };
  return <LiveStory {...png} story={story} sizing={sizing} shipBound={shipBound} />;
}

function CapturedPng({ roundId, frameKey, alt, loadable }: PngProps): ReactNode {
  if (!loadable) return <Typography variant="caption" color="secondary">No image for this frame</Typography>;
  return <FrameImage roundId={roundId} frameKey={frameKey} view="head" alt={alt} />;
}

function CapturedFrame({ note, ...png }: PngProps & { note: string }): ReactNode {
  return (
    <VStack gap={1}>
      <CapturedPng {...png} />
      <Typography variant="caption" color="secondary">{note}</Typography>
    </VStack>
  );
}

interface Story {
  src: string;
  origin: string;
  built: string;
}

interface StoryProps extends PngProps {
  story: Story;
  sizing: LiveSizing;
}

/** A Ship-bound frame starts as the approved PNG, so the default view is what a Ship approves. */
function LiveStory({ shipBound, ...props }: StoryProps & { shipBound: boolean }): ReactNode {
  const [opened, setOpened] = useState(!shipBound);
  if (!opened) {
    return (
      <VStack gap={1}>
        <CapturedPng {...props} />
        <HStack gap={2} align="center" justify="between" wrap>
          <Typography variant="caption" color="secondary">The approved frame is the captured PNG</Typography>
          <Button size="sm" variant="outline" onPress={() => setOpened(true)}><ButtonText>Open live</ButtonText></Button>
        </HStack>
      </VStack>
    );
  }
  return (
    <VStack gap={3}>
      {props.sizing.widths.map((width) => <LiveViewport key={width} {...props} width={width} />)}
    </VStack>
  );
}

interface ViewportProps extends StoryProps {
  /** The CSS px the story is laid out at before it is fitted. */
  width: number;
}

/** Mounted only near the viewport and within the screen's cap; otherwise its PNG. */
function LiveViewport(props: ViewportProps): ReactNode {
  const box = useRef<HTMLDivElement>(null);
  const near = useInView(box);
  const granted = useLiveSlot(near);
  return (
    <div ref={box} className="min-h-16" data-testid={`live-viewport-${props.frameKey}-${props.width}`}>
      {granted ? <MountedStory {...props} fitted /> : <Waiting {...props} near={near} />}
    </div>
  );
}

function Waiting({ near, width, ...png }: ViewportProps & { near: boolean }): ReactNode {
  return (
    <VStack gap={1}>
      <CapturedPng {...png} />
      {near ? <Typography variant="caption" color="secondary">{`${width}px live frame paused: too many live frames on screen`}</Typography> : null}
    </VStack>
  );
}

/** Near the viewport while it is; unlike the PNG's latch, a frame scrolled far away unmounts and frees its slot. */
function useInView(ref: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new IntersectionObserver((entries) => {
      const last = entries.at(-1);
      if (last) setNear(last.isIntersecting);
    }, { rootMargin: NEAR_VIEWPORT });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return near;
}

function useLiveSlot(wanted: boolean): boolean {
  const [id] = useState(() => Symbol("live-frame"));
  const cap = useMediaQuery(PHONE_WIDTH) ? LIVE_CAP.phone : LIVE_CAP.desktop;
  useEffect(() => {
    if (!wanted) return;
    slots.request(id);
    return () => slots.release(id);
  }, [wanted, id]);
  return useSyncExternalStore(slots.subscribe, () => slots.granted(id, cap));
}

/** Trusts only its own frame's window on the story origin. */
function useBridge(origin: string, frame: RefObject<HTMLIFrameElement | null>, dispatch: Dispatch<LiveEvent>): void {
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const live = bridgeEvent(event, origin, frame.current?.contentWindow);
      if (live) dispatch(live);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin, frame, dispatch]);
}

/** Each mount gets its own 10 s for the bridge's `ready`. */
function useReadyTimeout({ phase, mount }: LiveState, dispatch: Dispatch<LiveEvent>): void {
  useEffect(() => {
    if (phase !== "mounting") return;
    const timer = setTimeout(() => dispatch({ type: "failed" }), READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [phase, mount, dispatch]);
}

/** `fitted` scales the story to its column; unfitted, as enlarged, it is drawn 1:1 and scrolls sideways. */
function MountedStory({ fitted, ...props }: ViewportProps & { fitted: boolean }): ReactNode {
  const [state, dispatch] = useReducer(liveReducer, MOUNTING);
  const [enlarged, setEnlarged] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const fit = useFitScale(box, props.width);
  useBridge(props.story.origin, frame, dispatch);
  useReadyTimeout(state, dispatch);
  if (state.phase === "dead") return <DeadStory {...props} onRetry={() => dispatch({ type: "retry" })} />;
  const scale = fitted ? (fit ?? 1) : 1;
  return (
    <VStack gap={1}>
      <HStack gap={2} align="center" justify="between" wrap>
        <Typography variant="caption" color="secondary">{`${liveCaption(props.width, fitted ? fit : 1, props.story.built)}${state.phase === "mounting" ? " · loading" : ""}`}</Typography>
        {fitted ? <Button size="sm" variant="outline" onPress={() => setEnlarged(true)}><ButtonText>Enlarge live</ButtonText></Button> : null}
      </HStack>
      <StoryBox {...props} box={box} frame={frame} state={state} scale={scale} fitted={fitted} />
      {enlarged ? <LiveEnlarge {...props} onClose={() => setEnlarged(false)} /> : null}
    </VStack>
  );
}

interface StoryBoxProps extends ViewportProps {
  box: RefObject<HTMLDivElement | null>;
  frame: RefObject<HTMLIFrameElement | null>;
  state: LiveState;
  scale: number;
  fitted: boolean;
}

/** The PNG holds the box's place, the story loading unseen over it, until the bridge says the story rendered. */
function StoryBox({ box, frame, state, scale, fitted, width, story, sizing, ...png }: StoryBoxProps): ReactNode {
  const live = state.phase === "live";
  const height = frameHeight(sizing.height, state.height, sizing.maxHeight);
  return (
    <div ref={box} className="relative overflow-hidden rounded border border-hairline-strong" style={{ ...(fitted ? { maxWidth: width } : { width }), ...(live && { height: height * scale }) }}>
      {live ? null : <CapturedPng {...png} />}
      <iframe
        key={state.mount}
        ref={frame}
        src={story.src}
        title={`${png.alt}, live at ${width}px`}
        sandbox={LIVE_SANDBOX}
        allow=""
        referrerPolicy="no-referrer"
        className={`absolute left-0 top-0 origin-top-left border-0 bg-white ${live ? "" : "invisible"}`}
        style={{ width, height, transform: scale === 1 ? undefined : `scale(${scale})` }}
      />
    </div>
  );
}

function DeadStory({ onRetry, width, ...png }: ViewportProps & { onRetry: () => void }): ReactNode {
  return (
    <VStack gap={1}>
      <CapturedPng {...png} />
      <HStack gap={2} align="center" justify="between" wrap>
        <Typography variant="caption" color="secondary">{`${width}px · Live story unavailable: showing the captured frame`}</Typography>
        <Button size="sm" variant="outline" onPress={onRetry}><ButtonText>Retry</ButtonText></Button>
      </HStack>
    </VStack>
  );
}

/** The story at 1:1, where a phone can interact with a wide frame by scrolling sideways. */
function LiveEnlarge({ onClose, ...props }: ViewportProps & { onClose: () => void }): ReactNode {
  useEscapeKey(onClose);
  return (
    <div role="dialog" aria-modal="true" aria-label={`${props.alt}, live`} className="fixed inset-0 z-50 flex flex-col gap-3 bg-surface-base p-4">
      <HStack gap={3} align="center" justify="between">
        <VStack gap={0}>
          <Typography variant="subtitle2">{props.alt}</Typography>
          <Typography variant="caption" color="secondary">The approved frame is the captured PNG</Typography>
        </VStack>
        <Button variant="outline" size="sm" onPress={onClose}><ButtonText>Close</ButtonText></Button>
      </HStack>
      <div className="flex-1 overflow-auto">
        <MountedStory {...props} fitted={false} />
      </div>
    </div>
  );
}
