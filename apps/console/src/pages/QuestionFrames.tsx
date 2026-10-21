import { createContext, useContext, useMemo, type MouseEvent, type ReactNode } from "react";
import { HStack, Typography, VStack } from "@titan-design/react-ui";
import type { Manifest, Question } from "../../server/round-schema.js";
import { FrameFigure } from "./FrameFeedback.js";
import { FrameImage } from "./RoundFrame.js";

/** What a question needs to draw the frames it names: the round, each variant's label, and which keys have an image. */
interface RoundFrames {
  roundId: string;
  labels: ReadonlyMap<string, string>;
  loadable: ReadonlySet<string>;
}

const RoundFramesContext = createContext<RoundFrames | null>(null);

interface RoundFramesProviderProps {
  roundId: string;
  manifest: Manifest;
  /** Keys `frames/frames.json` lists, where the page has read it; an image variant loads either way. */
  indexed?: ReadonlySet<string>;
  children: ReactNode;
}

/** Lets every question of one round draw its own frames; outside a provider a question draws none. */
export function RoundFramesProvider({ roundId, manifest, indexed, children }: RoundFramesProviderProps): ReactNode {
  const value = useMemo(() => {
    const labels = new Map(manifest.variants.map((variant) => [variant.key, variant.label]));
    const images = manifest.variants.filter((variant) => variant.image !== undefined).map((variant) => variant.key);
    return { roundId, labels, loadable: new Set([...images, ...(indexed ?? [])]) };
  }, [roundId, manifest, indexed]);
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

/** The variant key picking `option` picks: its `optionVariants` entry, or the option itself when it is a frame key. */
function optionKey(question: Question, option: string, labels: ReadonlyMap<string, string>): string | undefined {
  if (question.kind !== "pick-one" && question.kind !== "pick-many") return undefined;
  const key = question.optionVariants?.[option] ?? option;
  return labels.has(key) ? key : undefined;
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

function optionFrame(question: Question, option: string, labels: ReadonlyMap<string, string>): string | undefined {
  const key = optionKey(question, option, labels);
  return key === undefined ? undefined : labels.get(key);
}

/** The label of the frame an option picks, or undefined outside a round or for an option that picks none. */
export function useOptionFrame(question: Question): (option: string) => string | undefined {
  const frames = useContext(RoundFramesContext);
  return (option) => (frames ? optionFrame(question, option, frames.labels) : undefined);
}

const isShip = (question: Question): boolean => question.decision === "ship" || (question.kind === "pick-one" && question.merge !== undefined);

/** Hash routing owns `location.hash`, so an in-page link scrolls instead of navigating. */
function InPageLink({ target, children }: { target: string; children: ReactNode }): ReactNode {
  const jump = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    document.getElementById(target)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  return <a href={`#${target}`} onClick={jump} className="underline">{children}</a>;
}

/** The frames a question names, drawn above it; each links back to the question, which starts right below them. `omit` leaves out frames drawn elsewhere in the card. */
export function QuestionFrames({ question, omit = [] }: { question: Question; omit?: readonly string[] }): ReactNode {
  const frames = useContext(RoundFramesContext);
  const keys = (question.frames ?? []).filter((key) => !omit.includes(key));
  if (frames === null || keys.length === 0) return null;
  return (
    <VStack gap={2}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid={`question-frames-${question.id}`}>
        {keys.map((key) => {
          const label = frames.labels.get(key) ?? key;
          return (
            <FrameFigure key={key} frameKey={key} label={label} id={frameAnchor(question.id, key)}>
              <HStack gap={2} align="center" justify="between">
                <Typography variant="subtitle2">{label}</Typography>
                <InPageLink target={questionAnchor(question.id)}><Typography variant="caption">To its question</Typography></InPageLink>
              </HStack>
              {frames.loadable.has(key) ? (
                <FrameImage roundId={frames.roundId} frameKey={key} view="head" alt={label} />
              ) : (
                <Typography variant="caption" color="secondary">No image for this frame</Typography>
              )}
            </FrameFigure>
          );
        })}
      </div>
      <span id={questionAnchor(question.id)} />
    </VStack>
  );
}

/** A line linking to the question's frames and, on a Ship question, naming the frames a Ship approves. */
export function QuestionFrameLinks({ question }: { question: Question }): ReactNode {
  const frames = useContext(RoundFramesContext);
  if (frames === null || !question.frames) return null;
  const labelled = question.frames.map((key) => ({ key, label: frames.labels.get(key) ?? key }));
  return (
    <VStack gap={1}>
      {isShip(question) ? <Typography variant="caption">{`Ships: ${labelled.map(({ label }) => label).join(", ")}`}</Typography> : null}
      <HStack gap={2} align="center" wrap>
        <Typography variant="caption" color="secondary">Frames:</Typography>
        {labelled.map(({ key, label }) => (
          <InPageLink key={key} target={frameAnchor(question.id, key)}><Typography variant="caption">{label}</Typography></InPageLink>
        ))}
      </HStack>
    </VStack>
  );
}
