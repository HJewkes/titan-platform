import { createContext, useContext, useMemo, type MouseEvent, type ReactNode } from "react";
import { HStack, Typography, VStack } from "@titan-design/react-ui";
import type { Manifest, Question } from "../../server/round-schema.js";
import type { RoundLive } from "../../server/storybook-build.js";
import { FrameFigure } from "./FrameFeedback.js";
import { optionKey } from "./frame-link.js";
import { SequenceFigure } from "./FrameSequence.js";
import { LiveFrame } from "./LiveFrame.js";
import { isShipQuestion, liveEntries, type LiveEntry } from "./live-frame.js";
import { groupProgressStills, type FrameItem } from "./progress-stills-heuristic.js";
import { VariantFrame, pinnableFrame, playsMedia, type FrameMedia } from "./TrueSize.js";

/** What a question needs to draw the frames it names: the round, each variant's label and sizing, and which keys have an image. */
interface RoundFrames {
  roundId: string;
  labels: ReadonlyMap<string, string>;
  media: ReadonlyMap<string, FrameMedia>;
  loadable: ReadonlySet<string>;
  /** Image variants' keys, the only ones a motion's stills are guessed from. */
  images: ReadonlySet<string>;
  /** Story variants' live frames, by key; empty when the round carries no build. */
  live: ReadonlyMap<string, LiveEntry>;
}

const RoundFramesContext = createContext<RoundFrames | null>(null);

interface RoundFramesProviderProps {
  roundId: string;
  manifest: Manifest;
  /** Keys `frames/frames.json` lists, where the page has read it; an image variant loads either way. */
  indexed?: ReadonlySet<string>;
  /** `rounds.get`'s live field, where the round carries a Storybook build. */
  live?: RoundLive;
  children: ReactNode;
}

/** Lets every question of one round draw its own frames; outside a provider a question draws none. */
export function RoundFramesProvider({ roundId, manifest, indexed, live, children }: RoundFramesProviderProps): ReactNode {
  const value = useMemo(() => {
    const labels = new Map(manifest.variants.map((variant) => [variant.key, variant.label]));
    const media = new Map(manifest.variants.map(({ key, frameReference, scale, clip, motion, audio, transcript, durationMs }) => [key, { frameReference, scale, clip, motion, audio, transcript, durationMs }]));
    const images = manifest.variants.filter((variant) => variant.image !== undefined).map((variant) => variant.key);
    return { roundId, labels, media, images: new Set(images), loadable: new Set([...images, ...(indexed ?? [])]), live: liveEntries(manifest, live) };
  }, [roundId, manifest, indexed, live]);
  return <RoundFramesContext.Provider value={value}>{children}</RoundFramesContext.Provider>;
}

export const questionAnchor = (questionId: string): string => `question-${questionId}`;
export const frameAnchor = (questionId: string, key: string): string => `question-${questionId}-frame-${key}`;

/** One side of an A/B question: the option that picks it, its place among the options, and its frame. */
export interface ABSide {
  option: string;
  index: number;
  key: string;
  label: string;
}

/**
 * A pick-one whose options pick exactly two frames is an A/B: those two options are its sides. Any other option, such as
 * "Both", is an extra answer beside them; the round's own revision option is never a side.
 */
function abSides(question: Question, labels: ReadonlyMap<string, string>): [ABSide, ABSide] | null {
  if (question.kind !== "pick-one") return null;
  const sides = question.options.flatMap((option, index): ABSide[] => {
    const key = option === question.revisionOption ? undefined : optionKey(question, option, labels);
    return key === undefined ? [] : [{ option, index, key, label: labels.get(key) ?? key }];
  });
  const [a, b, ...more] = sides;
  return a && b && more.length === 0 && a.key !== b.key ? [a, b] : null;
}

/** The keys some question in the round draws above itself or in its A/B sides, so a section strip leaves them out. */
export function anchoredKeys(manifest: Manifest): Set<string> {
  const labels = new Map(manifest.variants.map((variant) => [variant.key, variant.label]));
  const sideKeys = (question: Question): string[] => abSides(question, labels)?.map((side) => side.key) ?? [];
  return new Set(manifest.questions.flatMap((question) => [...(question.frames ?? []), ...sideKeys(question)]));
}

/** The question's A/B sides inside a round's provider; null outside one or for any other question. */
export function useABSides(question: Question): [ABSide, ABSide] | null {
  const frames = useContext(RoundFramesContext);
  return useMemo(() => (frames ? abSides(question, frames.labels) : null), [frames, question]);
}

/** Whether the round has an image for `key`, so a side draws it or says it has none. */
export function useFrameSource(): { roundId: string; loadable: (key: string) => boolean } | null {
  const frames = useContext(RoundFramesContext);
  return frames && { roundId: frames.roundId, loadable: (key) => frames.loadable.has(key) };
}

/** How the round's variant `key` asks to be sized; undefined outside a provider. */
export function useFrameMedia(): (key: string) => FrameMedia | undefined {
  const frames = useContext(RoundFramesContext);
  return (key) => frames?.media.get(key);
}

interface RoundVariantFrameProps {
  frameKey: string;
  alt: string;
  /** Whether the frame's own PNG may be fetched; a scale frame asks the round for each candidate's instead. */
  loadable: boolean;
  missing: string;
}

/** A frame shows its live story only where it would otherwise be a plain PNG: a clip, a sound, a true-size or a scale frame keeps its own view. */
const liveEntry = (frames: RoundFrames, key: string): LiveEntry | undefined => {
  const media = frames.media.get(key);
  return playsMedia(media) || media?.scale !== undefined || media?.frameReference !== undefined ? undefined : frames.live.get(key);
};

/** A plain frame's live story, its PNG as placeholder and fallback; null outside a provider or for a frame with no story. */
export function useLiveFrame(key: string, alt: string): ReactNode {
  const frames = useContext(RoundFramesContext);
  const entry = frames && liveEntry(frames, key);
  if (!frames || !entry) return null;
  return <LiveFrame roundId={frames.roundId} frameKey={key} alt={alt} loadable={frames.loadable.has(key)} {...entry} />;
}

/** A round's frame drawn as its variant asks: true size, a scale question's candidates, its live story, or a plain PNG. Nothing outside a provider. */
export function RoundVariantFrame(props: RoundVariantFrameProps): ReactNode {
  const frames = useContext(RoundFramesContext);
  const live = useLiveFrame(props.frameKey, props.alt);
  if (frames === null) return null;
  if (live !== null) return live;
  return <VariantFrame {...props} roundId={frames.roundId} media={frames.media.get(props.frameKey)} candidateLoadable={(key) => frames.loadable.has(key)} />;
}

function optionFrame(question: Question, option: string, labels: ReadonlyMap<string, string>): string | undefined {
  const key = optionKey(question, option, labels);
  return key === undefined ? undefined : labels.get(key);
}

/** The label of the frame an option picks, or undefined outside a round or for an option that picks none. */
export function useOptionFrame(question: Question): (option: string) => string | undefined {
  const frames = useContext(RoundFramesContext);
  return (option) => (frames ? optionFrame(question, option, frames.labels) : undefined);
}

/** Hash routing owns `location.hash`, so an in-page link scrolls instead of navigating. */
function InPageLink({ target, children }: { target: string; children: ReactNode }): ReactNode {
  const jump = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    document.getElementById(target)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  return <a href={`#${target}`} onClick={jump} className="underline">{children}</a>;
}

/** The frames a question names, drawn above it, a motion's stills as one viewer; each links back to the question, which starts right below them. `omit` leaves out frames drawn elsewhere in the card. */
export function QuestionFrames({ question, omit = [] }: { question: Question; omit?: readonly string[] }): ReactNode {
  const frames = useContext(RoundFramesContext);
  const keys = (question.frames ?? []).filter((key) => !omit.includes(key));
  if (frames === null || keys.length === 0) return null;
  return (
    <VStack gap={2}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid={`question-frames-${question.id}`}>
        {groupProgressStills(keys, (key) => frames.images.has(key)).map((item) => (
          <QuestionFrame key={item.kind === "frame" ? item.key : item.sequence.base} item={item} questionId={question.id} frames={frames} />
        ))}
      </div>
      <span id={questionAnchor(question.id)} />
    </VStack>
  );
}

function QuestionFrame({ item, questionId, frames }: { item: FrameItem; questionId: string; frames: RoundFrames }): ReactNode {
  const pinnable = (key: string): boolean => pinnableFrame(frames.loadable.has(key), frames.media.get(key));
  const header = (label: string): ReactNode => (
    <HStack gap={2} align="center" justify="between">
      <Typography variant="subtitle2">{label}</Typography>
      <InPageLink target={questionAnchor(questionId)}><Typography variant="caption">To its question</Typography></InPageLink>
    </HStack>
  );
  const draw = (key: string, label: string): ReactNode => <RoundVariantFrame frameKey={key} alt={label} loadable={frames.loadable.has(key)} missing="No image for this frame" />;
  if (item.kind === "sequence") {
    const { sequence } = item;
    return <SequenceFigure sequence={sequence} labels={frames.labels} pinnable={pinnable} header={header} renderStep={draw} id={frameAnchor(questionId, sequence.steps[0]?.key ?? sequence.base)} />;
  }
  const label = frames.labels.get(item.key) ?? item.key;
  return (
    <FrameFigure frameKey={item.key} label={label} pinnable={pinnable(item.key)} id={frameAnchor(questionId, item.key)}>
      {header(label)}
      {draw(item.key, label)}
    </FrameFigure>
  );
}

/** Where a link to frame `key` lands: its own figure, or the viewer of the motion its still belongs to. */
function anchorKeys(keys: readonly string[], images: ReadonlySet<string>): Map<string, string> {
  const anchors = new Map<string, string>();
  for (const item of groupProgressStills(keys, (key) => images.has(key))) {
    if (item.kind === "frame") anchors.set(item.key, item.key);
    else item.sequence.steps.forEach((step) => anchors.set(step.key, item.sequence.steps[0]?.key ?? step.key));
  }
  return anchors;
}

/** A line linking to the question's frames and, on a Ship question, naming the frames a Ship approves. */
export function QuestionFrameLinks({ question }: { question: Question }): ReactNode {
  const frames = useContext(RoundFramesContext);
  if (frames === null || !question.frames) return null;
  const anchors = anchorKeys(question.frames, frames.images);
  const labelled = question.frames.map((key) => ({ key, label: frames.labels.get(key) ?? key }));
  return (
    <VStack gap={1}>
      {isShipQuestion(question) ? <Typography variant="caption">{`Ships: ${labelled.map(({ label }) => label).join(", ")}`}</Typography> : null}
      <HStack gap={2} align="center" wrap>
        <Typography variant="caption" color="secondary">Frames:</Typography>
        {labelled.map(({ key, label }) => (
          <InPageLink key={key} target={frameAnchor(question.id, anchors.get(key) ?? key)}><Typography variant="caption">{label}</Typography></InPageLink>
        ))}
      </HStack>
    </VStack>
  );
}
