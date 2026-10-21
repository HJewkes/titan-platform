import { useMemo, type ReactNode } from "react";
import { Alert, HStack, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import type { Section } from "../../server/round-schema.js";
import type { RoundDetail } from "../../server/rounds.js";
import { useQuery } from "../data/rpc.js";
import { FrameFeedbackProvider, FrameFigure } from "./FrameFeedback.js";
import { frameDrafts } from "./frame-feedback.js";
import type { PngWidths } from "./frame-pins.js";
import { RoundFramesProvider, RoundVariantFrame, anchoredKeys, useFrameMedia } from "./QuestionFrames.js";
import { DraftDiscarded, type DraftBinding } from "./RoundDraft.js";
import { FrameImage } from "./RoundFrame.js";
import { RoundSend, useRoundSend } from "./RoundSend.js";
import { PagedSections } from "./RoundPager.js";
import { pinnableFrame } from "./TrueSize.js";
import { orderedQuestions, useRoundAnswers } from "./RoundSections.js";

type ValidRound = Extract<RoundDetail, { valid: true }>;
type FramesList = ConsoleCommands["rounds.frames"]["result"];

/**
 * A design round: each section's frames as a labelled strip, its `seeAlso` frames as thumbnails, and its questions,
 * sent together through `rounds.submit`. Only keys frames.json lists are fetched; without a valid frames.json the
 * harness answers the round.
 */
export function DesignRound({ round }: { round: ValidRound }): ReactNode {
  const listed = useQuery("rounds.frames", { id: round.id });
  if (listed.status === "loading") return <Spinner size="sm" label="Loading the round's frames" />;
  if (listed.data === undefined || !listed.data.indexed) return <DesignNotice storybookUrl={round.storybookUrl} />;
  return <DesignBody round={round} listed={listed.data} />;
}

/** The fallback for a design round whose frames/frames.json is missing or invalid. */
function DesignNotice({ storybookUrl }: { storybookUrl: string | null }): ReactNode {
  return (
    <Alert status="info" message="design round: open in the harness">
      {storybookUrl ? <Typography variant="caption" color="secondary">{`Its frames come from Storybook at ${storybookUrl}`}</Typography> : null}
    </Alert>
  );
}

function DesignBody({ round, listed }: { round: ValidRound; listed: FramesList }): ReactNode {
  const { submitting, check, checking, locked, frozen, draft } = useRoundSend(round);
  const state = useDesignAnswers(round, frozen, draft);
  const indexed = useMemo(() => new Set(listed.frames.filter((frame) => frame.indexed).map((frame) => frame.key)), [listed]);
  const { labels, ...strips } = useStrips(round, indexed);
  const variants = frameDrafts([...labels.keys()], state.frames.drafts);
  const widths = useMemo(() => declaredWidths(round, listed), [round, listed]);
  return (
    <RoundFramesProvider roundId={round.id} manifest={round.manifest} indexed={indexed}>
      <FrameFeedbackProvider value={state.frames} widths={widths}>
        <VStack gap={4}>
          <DesignNotes discarded={state.draftDiscarded} withheld={round.recommendationsWithheld} />
          <PagedSections
            manifest={round.manifest}
            state={state}
            textAnswers
            locked={locked}
            {...strips}
            check={check}
            checking={checking}
            send={<RoundSend round={round} state={state} submitting={submitting} check={check} variants={variants} />}
          />
        </VStack>
      </FrameFeedbackProvider>
    </RoundFramesProvider>
  );
}

function DesignNotes({ discarded, withheld }: { discarded: boolean; withheld: boolean }): ReactNode {
  return (
    <>
      <DraftDiscarded discarded={discarded} />
      <Typography variant="caption" color="secondary">Tap a frame to open it full size.</Typography>
      {withheld ? <Typography variant="caption" color="secondary">Recommendations are hidden until you answer; reveal one first with r.</Typography> : null}
    </>
  );
}

/** The round's answers; an option picking one of its frames stays in step with that frame's Chosen verdict. */
function useDesignAnswers(round: ValidRound, frozen: boolean, draft: DraftBinding) {
  const frameKeys = useMemo(() => round.manifest.variants.map((variant) => variant.key), [round.manifest]);
  return useRoundAnswers(frozen ? [] : orderedQuestions(round.manifest).flatMap((group) => group.questions), round.notes, frozen, frameKeys, draft);
}

/** Each frame's frames.json viewport width and true-size frameReference width, which its pins are measured in, and whether it has an element map. */
function declaredWidths({ id, manifest }: ValidRound, listed: FramesList): Map<string, PngWidths> {
  const records = new Map(listed.frames.map((frame) => [frame.key, frame]));
  return new Map(
    manifest.variants.map((variant) => {
      const referenceWidth = variant.frameReference?.frame.width;
      const { viewportWidth, targets } = records.get(variant.key) ?? {};
      return [variant.key, { ...(viewportWidth !== undefined && { viewportWidth }), ...(referenceWidth !== undefined && { referenceWidth }), ...(targets && { targetsRoundId: id }) }];
    }),
  );
}

/** Each section's strip. */
function useStrips(round: ValidRound, indexed: ReadonlySet<string>) {
  const labels = new Map(round.manifest.variants.map((variant) => [variant.key, variant.label]));
  const strip = { roundId: round.id, indexed, labels };
  const anchored = useMemo(() => anchoredKeys(round.manifest), [round.manifest]);
  return {
    labels,
    frames: (section: Section) => <SectionFrames section={section} anchored={anchored} {...strip} />,
  };
}

interface StripProps {
  roundId: string;
  indexed: ReadonlySet<string>;
  labels: ReadonlyMap<string, string>;
}

/** A section's strip leaves out the frames a question draws above itself. */
function SectionFrames({ section, anchored, ...strip }: StripProps & { section: Section; anchored: ReadonlySet<string> }): ReactNode {
  const keys = section.variantKeys.filter((key) => !anchored.has(key));
  if (keys.length === 0 && section.seeAlso.length === 0) return null;
  return (
    <VStack gap={3}>
      {keys.length > 0 && section.kind ? <StripKind section={section.id} kind={section.kind} /> : null}
      {keys.length > 0 ? <FrameStrip keys={keys} size="strip" {...strip} /> : null}
      {section.seeAlso.length > 0 ? (
        <VStack gap={1}>
          <Typography variant="microLabel" color="secondary">SEE ALSO</Typography>
          <FrameStrip keys={section.seeAlso} size="thumb" {...strip} />
        </VStack>
      ) : null}
    </VStack>
  );
}

type StripKindName = NonNullable<Section["kind"]>;

/** The harness's words for what a strip's frames are, so a set of states never reads as a choice. */
const STRIP_KIND_LABEL: Record<StripKindName, string> = {
  CHOICE: "these frames differ only in what is being decided",
  STATES: "one design in several states; nothing to choose between",
};

function StripKind({ section, kind }: { section: string; kind: StripKindName }): ReactNode {
  return (
    <HStack gap={2} align="center" wrap testID={`strip-kind-${section}`}>
      <Typography variant="microLabel" color="secondary">{kind}</Typography>
      <Typography variant="caption" color="secondary">{STRIP_KIND_LABEL[kind]}</Typography>
    </HStack>
  );
}

const STRIP_GRID = {
  strip: "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3",
  thumb: "grid grid-cols-3 gap-2 sm:grid-cols-4 xl:grid-cols-6",
} as const;

/** One figure per key, labelled from its variant; a key frames.json does not list is named and never fetched. */
function FrameStrip({ keys, size, roundId, indexed, labels }: StripProps & { keys: readonly string[]; size: keyof typeof STRIP_GRID }): ReactNode {
  const media = useFrameMedia();
  return (
    <div className={STRIP_GRID[size]}>
      {keys.map((key) => {
        const label = labels.get(key) ?? key;
        const body = (
          <>
            <Typography variant={size === "strip" ? "subtitle2" : "caption"}>{label}</Typography>
            {size === "strip" ? (
              <RoundVariantFrame frameKey={key} alt={label} loadable={indexed.has(key)} missing="Not in frames.json" />
            ) : indexed.has(key) ? (
              <FrameImage roundId={roundId} frameKey={key} view="head" alt={label} />
            ) : (
              <Typography variant="caption" color="secondary">Not in frames.json</Typography>
            )}
          </>
        );
        // A see-also thumbnail points at a frame judged where it is drawn full width, so it takes no verdict of its own.
        if (size === "thumb") return <figure key={key} className="flex min-w-0 flex-col gap-1" data-testid={`see-also-${key}`}>{body}</figure>;
        return <FrameFigure key={key} frameKey={key} label={label} pinnable={pinnableFrame(indexed.has(key), media(key))} testID={`design-frame-${key}`}>{body}</FrameFigure>;
      })}
    </div>
  );
}
