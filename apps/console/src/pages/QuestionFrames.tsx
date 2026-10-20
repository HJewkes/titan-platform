import { createContext, useContext, useMemo, type MouseEvent, type ReactNode } from "react";
import { HStack, Typography, VStack } from "@titan-design/react-ui";
import type { Manifest, Question } from "../../server/round-schema.js";
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

/** The keys some question in the round draws above itself, so a section strip leaves them out. */
export function anchoredKeys(manifest: Manifest): Set<string> {
  return new Set(manifest.questions.flatMap((question) => question.frames ?? []));
}

/** The frame picking `option` picks: its `optionVariants` entry, or the option itself when it is a frame key. */
function optionFrame(question: Question, option: string, labels: ReadonlyMap<string, string>): string | undefined {
  if (question.kind !== "pick-one" && question.kind !== "pick-many") return undefined;
  const key = question.optionVariants?.[option] ?? option;
  return labels.get(key);
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

/** The frames a question names, drawn above it; each links back to the question, which starts right below them. */
export function QuestionFrames({ question }: { question: Question }): ReactNode {
  const frames = useContext(RoundFramesContext);
  if (frames === null || !question.frames) return null;
  return (
    <VStack gap={2}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid={`question-frames-${question.id}`}>
        {question.frames.map((key) => {
          const label = frames.labels.get(key) ?? key;
          return (
            <figure key={key} id={frameAnchor(question.id, key)} className="flex min-w-0 flex-col gap-1">
              <HStack gap={2} align="center" justify="between">
                <Typography variant="subtitle2">{label}</Typography>
                <InPageLink target={questionAnchor(question.id)}><Typography variant="caption">To its question</Typography></InPageLink>
              </HStack>
              {frames.loadable.has(key) ? (
                <FrameImage roundId={frames.roundId} frameKey={key} view="head" alt={label} />
              ) : (
                <Typography variant="caption" color="secondary">No image for this frame</Typography>
              )}
            </figure>
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
