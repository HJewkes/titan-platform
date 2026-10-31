import { useRef, useState, type ReactNode } from "react";
import { Alert, Spinner, Typography } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { Enlarge, useNearViewport } from "./RoundFrame.js";

type FrameDelta = ConsoleCommands["rounds.frameDelta"]["result"];
type Size = { width: number; height: number };

interface DeltaPanelProps {
  roundId: string;
  frameKey: string;
  label: string;
}

/** A tiny change still reads as a change, not as 0.0%. */
export function formatShare(share: number): string {
  const percent = share * 100;
  if (percent > 0 && percent < 0.1) return "<0.1%";
  return `${Number(percent.toFixed(1))}%`;
}

const sized = ({ width, height }: Size): string => `${width}×${height}`;

/** The pixels that moved from main to head, drawn server-side by pixelmatch (TP-2512); fetched once it nears the viewport. */
export function DeltaPanel({ roundId, frameKey, label }: DeltaPanelProps): ReactNode {
  const ref = useRef<HTMLElement>(null);
  const near = useNearViewport(ref);
  return (
    <figure ref={ref} className="flex min-h-16 flex-col gap-1" data-testid={`delta-${frameKey}`}>
      <Typography variant="microLabel" color="secondary">DELTA</Typography>
      {near ? <LoadedDelta roundId={roundId} frameKey={frameKey} label={label} /> : <Typography variant="caption" color="secondary">Loads when scrolled into view</Typography>}
    </figure>
  );
}

function LoadedDelta({ roundId, frameKey, label }: DeltaPanelProps): ReactNode {
  const delta = useQuery("rounds.frameDelta", { id: roundId, key: frameKey });
  if (delta.status === "loading") return <Spinner size="sm" label={`Measuring ${label}`} />;
  if (delta.data === undefined) return <Typography variant="caption" color="error">{`Could not measure ${label}: ${delta.error.message}`}</Typography>;
  return <DeltaBody delta={delta.data} label={label} />;
}

function DeltaBody({ delta, label }: { delta: FrameDelta; label: string }): ReactNode {
  if (delta.status === "sizesDiffer") {
    return <Alert status="info" size="compact" testID="delta-sizes-differ" message={`Sizes differ: main is ${sized(delta.base)}, head is ${sized(delta.head)}, so there is no pixel delta.`} />;
  }
  if (delta.status === "unchanged") return <Typography variant="caption" color="secondary">No pixels moved.</Typography>;
  if (delta.status === "unmeasured") return <Typography variant="caption" color="secondary">{`Not measured (${delta.reason}).`}</Typography>;
  const pixels = `${delta.changedPixels} ${delta.changedPixels === 1 ? "pixel" : "pixels"}`;
  return (
    <>
      <DeltaImage src={`data:${delta.contentType};base64,${delta.base64}`} alt={`${label}, pixels changed from main to head`} />
      <Typography variant="caption" testID="delta-share">{`${formatShare(delta.share)} of the content changed (${pixels})`}</Typography>
    </>
  );
}

function DeltaImage({ src, alt }: { src: string; alt: string }): ReactNode {
  const [enlarged, setEnlarged] = useState(false);
  return (
    <>
      <button type="button" className="block w-full cursor-zoom-in" aria-label={`Enlarge ${alt}`} onClick={() => setEnlarged(true)}>
        <img src={src} alt={alt} className="block h-auto w-full rounded border border-hairline-strong" />
      </button>
      {enlarged ? <Enlarge src={src} alt={alt} pins={null} onClose={() => setEnlarged(false)} /> : null}
    </>
  );
}
