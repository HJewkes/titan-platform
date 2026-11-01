import type { ReactNode } from "react";
import { Alert, Badge, HStack, Pill, Section, SectionContent, SectionHeader, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import type { RoundDetail } from "../../server/rounds.js";
import { useQuery } from "../data/rpc.js";
import { FrameFigure } from "./FrameFeedback.js";
import { FrameImage, type FrameView } from "./RoundFrame.js";
import { DeltaPanel } from "./ShipDelta.js";
import { UnchangedFrames, WhatShips, splitUnchanged } from "./ShipPairs.js";
import { ShipTarget } from "./ShipTabs.js";
import { stackedLabel, stackedPrefixes } from "./ship-stack.js";

type ValidRound = Extract<RoundDetail, { valid: true }>;
type ListedFrame = ConsoleCommands["rounds.frames"]["result"]["frames"][number];
type Merge = Parameters<typeof WhatShips>[0]["merge"];

interface ShipFrame {
  key: string;
  label: string;
  theme?: ListedFrame["theme"];
  views: FrameView[];
  unchanged: boolean;
}

interface MontagesProps {
  round: ValidRound;
  /** The variants to show; absent, every one. A round with several PRs shows each PR's own (TP-3329). */
  keys?: ReadonlySet<string>;
  /** The merge the frames ship in, named above them; absent, none is named. */
  merge?: Merge;
}

/** Each image variant as main vs head, changed ones first; inside a `FrameFeedbackProvider` each takes a verdict and comment. */
export function Montages({ round, keys, merge }: MontagesProps): ReactNode {
  const listed = useQuery("rounds.frames", { id: round.id });
  if (listed.status === "loading") return <Spinner size="sm" label="Loading the round's images" />;
  if (listed.data === undefined) return <Alert status="error" message={`Could not list the round's images: ${listed.error.message}`} />;
  const byKey = new Map(listed.data.frames.map((frame) => [frame.key, frame]));
  const prefixes = stackedPrefixes(round.manifest);
  const frames = round.manifest.variants.flatMap((variant): ShipFrame[] => {
    if (variant.image === undefined || (keys !== undefined && !keys.has(variant.key))) return [];
    const frame = byKey.get(variant.key);
    const unchanged = variant.change === "unchanged" || (frame?.unchanged ?? false);
    return [{ key: variant.key, label: stackedLabel(prefixes, variant.key, variant.label), theme: frame?.theme, views: frame?.views ?? ["head"], unchanged }];
  });
  if (frames.length === 0) return null;
  const { changed, unchanged } = splitUnchanged(frames);
  return (
    <Section>
      <SectionHeader title={`Main vs head (${frames.length} images)`} subtitle="Before is main, after is the PR head. Changed images come first. Tap an image to enlarge it." />
      <SectionContent>
        <VStack gap={6}>
          {merge ? <WhatShips merge={merge} changed={changed.length} /> : null}
          <FrameGroups roundId={round.id} frames={changed} />
          <UnchangedFrames count={unchanged.length}>
            <FrameGroups roundId={round.id} frames={unchanged} />
          </UnchangedFrames>
        </VStack>
      </SectionContent>
    </Section>
  );
}

function FrameGroups({ roundId, frames }: { roundId: string; frames: readonly ShipFrame[] }): ReactNode {
  return themePairs(frames).map((group) => (group.length === 2 ? <ThemePair key={group[0].key} roundId={roundId} pair={group} /> : <FrameMontage key={group[0].key} roundId={roundId} frame={group[0]} />));
}

type FrameGroup = [ShipFrame] | [ShipFrame, ShipFrame];

const pairsWith = (last: FrameGroup | undefined, frame: ShipFrame): last is [ShipFrame] =>
  last?.length === 1 && last[0].theme !== undefined && frame.theme !== undefined && last[0].theme !== frame.theme;

/** Neighbours in opposite themes are one variant in both; round@2 0.3.0's `variantUnit` replaces this reading (TP-3232). */
function themePairs(frames: readonly ShipFrame[]): FrameGroup[] {
  const groups: FrameGroup[] = [];
  for (const frame of frames) {
    const last = groups.at(-1);
    if (pairsWith(last, frame)) groups[groups.length - 1] = [last[0], frame];
    else groups.push([frame]);
  }
  return groups;
}

function ThemePair({ roundId, pair }: { roundId: string; pair: [ShipFrame, ShipFrame] }): ReactNode {
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2" data-testid={`theme-pair-${pair[0].key}`}>
      {pair.map((frame) => <FrameMontage key={frame.key} roundId={roundId} frame={frame} />)}
    </div>
  );
}

/** A CI packet's head is its montage, so AFTER reads the `after` image whenever the round lists one. */
function panelsOf(views: readonly FrameView[]): { label: string; side: string; view: FrameView }[] {
  const after = { label: "AFTER (head)", side: "after", view: views.includes("after") ? ("after" as const) : ("head" as const) };
  if (!views.includes("base")) return [after];
  return [{ label: "BEFORE (main)", side: "before", view: "base" }, after, ...(views.includes("diff") ? [{ label: "DIFF", side: "diff", view: "diff" as const }] : [])];
}

function FrameMontage({ roundId, frame }: { roundId: string; frame: ShipFrame }): ReactNode {
  const isNew = !frame.views.includes("base");
  const measured = !isNew && !frame.unchanged;
  const panels = panelsOf(frame.views);
  const columns = measured && panels.length >= 3 ? "sm:grid-cols-2 xl:grid-cols-4" : "sm:grid-cols-3";
  return (
    <ShipTarget target={{ kind: "frame", key: frame.key }}>
      <FrameFigure frameKey={frame.key} label={frame.label} pinnable={false} testID={`montage-${frame.key}`}>
        <HStack gap={2} align="center" wrap>
          <Typography variant="subtitle2">{frame.label}</Typography>
          {frame.theme ? <Pill variant="subtle" size="xs">{frame.theme}</Pill> : null}
          {isNew ? <Badge color="info" size="sm">NEW</Badge> : null}
        </HStack>
        <div className={`grid grid-cols-1 gap-3 ${columns}`}>
          {panels.map(({ label, side, view }) => (
            <figure key={label} className="flex flex-col gap-1">
              <Typography variant="microLabel" color="secondary">{label}</Typography>
              <FrameImage roundId={roundId} frameKey={frame.key} view={view} alt={`${frame.label}, ${side}`} />
            </figure>
          ))}
          {measured ? <DeltaPanel roundId={roundId} frameKey={frame.key} label={frame.label} /> : null}
        </div>
      </FrameFigure>
    </ShipTarget>
  );
}
