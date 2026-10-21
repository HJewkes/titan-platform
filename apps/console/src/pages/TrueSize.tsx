/**
 * True-size frames and scale questions (decision 339(2): "questions of scale need reference"), ported from the review
 * harness's TrueSize.tsx and ScaleFrame.tsx. The harness renders a scale question's candidates as live stories; the
 * console draws the PNG captured for each candidate, keyed as `scaleCandidateKey` names it.
 */
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button, ButtonText, HStack, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { Manifest } from "../../server/round-schema.js";
import { useQuery } from "../data/rpc.js";
import { FrameImage, useNearViewport } from "./RoundFrame.js";

type Variant = Manifest["variants"][number];
type FrameReference = NonNullable<Variant["frameReference"]>;
type ScaleReference = NonNullable<Variant["scale"]>;
type FrameSize = FrameReference["frame"];
type LadderRung = FrameReference["ladder"][number];
type Candidate = ScaleReference["candidates"][number];

/** How a variant asks to be sized: a true-size `frameReference`, or a `scale` question's candidates. */
export type FrameMedia = Pick<Variant, "frameReference" | "scale">;

/** Fit draws the frame across its box; actual draws it at its declared CSS px and scrolls. */
const SIZE_VIEWS = [
  ["fit", "Fit"],
  ["actual", "1:1"],
] as const;
type SizeView = (typeof SIZE_VIEWS)[number][0];

/** The ladder's column inside a scale frame, in the frame's px, wide enough for its largest sample. */
const LADDER_WIDTH = 360;

/** The harness's file stem suffix for a captured candidate (`-<arg>-<candidate>`), on the variant's key. */
export function scaleCandidateKey(variantKey: string, arg: string, candidate: Candidate): string {
  return `${variantKey}-${arg}-${String(candidate).replace(/[^A-Za-z0-9_-]+/g, "_")}`;
}

/** "64px · 5.9% of 1080": a size and the share of the frame's height it takes. */
export function sizeLabel(px: number, frameHeight: number): string {
  return `${Number(px.toFixed(1))}px · ${((px / frameHeight) * 100).toFixed(1)}% of ${frameHeight}`;
}

/** The ladder column, then one equal column per candidate, in the frame's own px. */
function scaleColumns({ frame, candidates }: ScaleReference): { ladder: number; cell: number } {
  const ladder = Math.min(LADDER_WIDTH, Math.floor(frame.width / 4));
  return { ladder, cell: Math.floor((frame.width - ladder) / candidates.length) };
}

const share = (px: number, of: number): string => `${(px / of) * 100}%`;

interface VariantFrameProps {
  roundId: string;
  frameKey: string;
  alt: string;
  media: FrameMedia | undefined;
  /** Whether the frame's own PNG may be fetched. */
  loadable: boolean;
  /** Whether a scale candidate's captured PNG may be fetched, by its `scaleCandidateKey`. */
  candidateLoadable: (key: string) => boolean;
  missing: string;
}

/** A frame as its variant asks: a scale question's candidates in one frame, a true-size PNG, or the PNG fitted as before. */
export function VariantFrame({ roundId, frameKey, alt, media, loadable, candidateLoadable, missing }: VariantFrameProps): ReactNode {
  if (media?.scale) return <ScaleFrame roundId={roundId} frameKey={frameKey} alt={alt} scale={media.scale} loadable={candidateLoadable} />;
  if (!loadable) return <Typography variant="caption" color="secondary">{missing}</Typography>;
  if (media?.frameReference) return <TrueSizeFrame roundId={roundId} frameKey={frameKey} alt={alt} reference={media.frameReference} />;
  return <FrameImage roundId={roundId} frameKey={frameKey} view="head" alt={alt} />;
}

function SizeHeader({ label, frame, view, onChange }: { label: string; frame: FrameSize; view: SizeView; onChange: (view: SizeView) => void }): ReactNode {
  return (
    <HStack gap={2} align="center" justify="between" wrap>
      <Typography variant="caption" color="secondary">{`${frame.width}×${frame.height} · ${view === "fit" ? "fitted" : "1:1"}`}</Typography>
      <div role="group" aria-label={`Size of ${label}`} className="flex gap-1">
        {SIZE_VIEWS.map(([each, text]) => (
          <Button key={each} size="sm" variant={view === each ? "solid" : "outline"} aria-pressed={view === each} onPress={() => onChange(each)}>
            <ButtonText>{text}</ButtonText>
          </Button>
        ))}
      </div>
    </HStack>
  );
}

/** At 1:1 the box scrolls both ways, no taller than the screen, so the frame's controls stay in reach. */
function SizeBox({ view, testID, children }: { view: SizeView; testID: string; children: ReactNode }): ReactNode {
  return (
    <div data-testid={testID} data-view={view} className={view === "actual" ? "max-h-[80vh] max-w-full overflow-auto" : undefined}>
      {children}
    </div>
  );
}

/** The ladder drawn into a true-size frame's top-right corner: each bar its rung's share of the frame's height, at any view. */
function LadderOverlay({ frame, ladder }: { frame: FrameSize; ladder: readonly LadderRung[] }): ReactNode {
  return (
    <ol aria-label="Size ladder" data-testid="frame-ladder" className="pointer-events-none absolute inset-y-0 right-2 flex items-start gap-2">
      {ladder.map((rung) => (
        <li key={rung.label} className="flex h-full flex-col items-center gap-0.5">
          <span className="w-2 shrink-0 bg-brand-primary shadow" style={{ height: share(rung.px, frame.height) }} />
          <span className="rounded bg-surface-base px-1 text-xs leading-tight">{`${rung.label} ${Number(rung.px.toFixed(1))}px`}</span>
        </li>
      ))}
    </ol>
  );
}

/** A recorded frame of a declared size: Fit or 1:1, with its reference ladder laid over it. */
function TrueSizeFrame({ roundId, frameKey, alt, reference }: { roundId: string; frameKey: string; alt: string; reference: FrameReference }): ReactNode {
  const [view, setView] = useState<SizeView>("fit");
  const { frame, ladder } = reference;
  return (
    <VStack gap={1}>
      <SizeHeader label={alt} frame={frame} view={view} onChange={setView} />
      <SizeBox view={view} testID={`true-size-${frameKey}`}>
        <FrameImage roundId={roundId} frameKey={frameKey} view="head" alt={alt} trueWidth={view === "actual" ? frame.width : undefined} overlay={<LadderOverlay frame={frame} ladder={ladder} />} />
      </SizeBox>
    </VStack>
  );
}

interface ScaleFrameProps {
  roundId: string;
  frameKey: string;
  alt: string;
  scale: ScaleReference;
  loadable: (key: string) => boolean;
}

/** A scale question's candidates side by side in one full-size frame, beside a ladder of text at known sizes. */
function ScaleFrame({ roundId, frameKey, alt, scale, loadable }: ScaleFrameProps): ReactNode {
  const [view, setView] = useState<SizeView>("fit");
  const canvas = useRef<HTMLDivElement>(null);
  const near = useNearViewport(canvas);
  const { frame, arg, candidates, ladder } = scale;
  const columns = scaleColumns(scale);
  const size: CSSProperties = view === "fit" ? { width: "100%", aspectRatio: `${frame.width} / ${frame.height}` } : { width: frame.width, height: frame.height };
  return (
    <VStack gap={1} testID={`scale-frame-${frameKey}`}>
      <SizeHeader label={alt} frame={frame} view={view} onChange={setView} />
      <ScaleLegend scale={scale} />
      <SizeBox view={view} testID={`scale-box-${frameKey}`}>
        <div ref={canvas} className="flex overflow-hidden rounded border border-hairline-strong bg-surface-raised" style={size}>
          <ScaleLadder rungs={ladder} width={columns.ladder} frame={frame} />
          {candidates.map((candidate) => {
            const key = scaleCandidateKey(frameKey, arg, candidate);
            const label = `${alt} at ${arg} ${String(candidate)}`;
            return <ScaleCell key={key} roundId={roundId} frameKey={key} label={label} tag={`${arg} = ${String(candidate)}`} width={share(columns.cell, frame.width)} near={near} captured={loadable(key)} />;
          })}
        </div>
      </SizeBox>
    </VStack>
  );
}

function ScaleLegend({ scale: { arg, candidates, ladder, frame } }: { scale: ScaleReference }): ReactNode {
  return (
    <Typography variant="caption" color="secondary">
      {`${arg}: ${candidates.map(String).join(", ")} · ladder: ${ladder.map((rung) => `${rung.label} ${sizeLabel(rung.px, frame.height)}`).join("; ")}`}
    </Typography>
  );
}

/** Each rung's sample baseline, then its caption's, stacked down the ladder column in the frame's px. */
function ladderRows(rungs: readonly LadderRung[]): { rung: LadderRung; sample: number; caption: number }[] {
  const rows: { rung: LadderRung; sample: number; caption: number }[] = [];
  let top = 24;
  for (const rung of rungs) {
    rows.push({ rung, sample: top + rung.px, caption: top + rung.px + 28 });
    top += rung.px + 52;
  }
  return rows;
}

/** Text at each rung's size, in the frame's px: the SVG scales with the frame, so Fit shrinks it as it shrinks the candidates. */
function ScaleLadder({ rungs, width, frame }: { rungs: readonly LadderRung[]; width: number; frame: FrameSize }): ReactNode {
  const frameHeight = frame.height;
  return (
    <svg role="img" aria-label="Size ladder" data-testid="scale-ladder" viewBox={`0 0 ${width} ${frameHeight}`} className="h-full shrink-0" style={{ width: share(width, frame.width) }} preserveAspectRatio="xMinYMin meet">
      {ladderRows(rungs).map(({ rung, sample, caption }) => (
        <g key={rung.label} fill="currentColor">
          <text x={16} y={sample} fontSize={rung.px}>Ag 1080</text>
          <text x={16} y={caption} fontSize={20}>{`${rung.label} ${sizeLabel(rung.px, frameHeight)}`}</text>
        </g>
      ))}
    </svg>
  );
}

interface ScaleCellProps {
  roundId: string;
  frameKey: string;
  label: string;
  tag: string;
  width: string;
  near: boolean;
  captured: boolean;
}

/** One candidate's column: its capture at the frame's full height, cropped to the column from the middle, so its text stays true size. */
function ScaleCell({ roundId, frameKey, label, tag, width, near, captured }: ScaleCellProps): ReactNode {
  return (
    <div className="relative h-full shrink-0 overflow-hidden border-l border-hairline-strong" style={{ width }} data-testid={`scale-cell-${frameKey}`}>
      {near && captured ? <CandidateImage roundId={roundId} frameKey={frameKey} label={label} /> : null}
      {captured ? null : <Typography variant="caption" color="secondary">Not captured</Typography>}
      <span className="absolute left-1 top-1 rounded bg-surface-base px-1 text-xs">{tag}</span>
    </div>
  );
}

function CandidateImage({ roundId, frameKey, label }: { roundId: string; frameKey: string; label: string }): ReactNode {
  const frame = useQuery("rounds.frame", { id: roundId, key: frameKey, view: "head" });
  if (frame.status === "loading") return <Spinner size="sm" label={`Loading ${label}`} />;
  if (frame.data === undefined) return <Typography variant="caption" color="error">{`Could not load ${label}: ${frame.error.message}`}</Typography>;
  return <img src={`data:${frame.data.contentType};base64,${frame.data.base64}`} alt={label} className="block h-full w-full max-w-none object-cover" />;
}
