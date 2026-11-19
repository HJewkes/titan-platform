import { useRef, useState, type ReactNode } from "react";
import { HStack, Typography, VStack } from "@titan-design/react-ui";
import type { LogRow } from "../../server/log-rows.js";
import { useQuery } from "../data/rpc.js";
import { Spinner } from "../shell/Loading.js";
import { Enlarge, useNearViewport } from "./RoundFrame.js";

type Frames = NonNullable<LogRow["frames"]>;
type Side = "before" | "after";

/**
 * A visual ship row's before and after pairs (TP-6777), each side a thumbnail that opens full size. A PR whose pr-visual
 * artifact showed nothing says why in one line; a row whose frames are not captured yet says that instead.
 */
export function LogFrames({ row }: { row: LogRow }): ReactNode {
  const { frames } = row;
  if (frames === null) return <FramesLine rowKey={row.key} text="Before and after frames are not captured yet." />;
  if (frames.note !== undefined) return <FramesLine rowKey={row.key} text={frames.note} />;
  return (
    <VStack gap={2} testID={`log-frames-${row.key}`}>
      {frames.pairs.map((pair) => (
        <VStack key={pair.key} gap={1} className="min-w-0">
          <Typography variant="caption" color="secondary" className="break-words">{pair.label}</Typography>
          <HStack gap={2}>
            {(["before", "after"] as const).map((side) => (
              <Thumbnail key={side} frames={frames} frameKey={pair.key} side={side} alt={`${pair.label} ${side}`} />
            ))}
          </HStack>
        </VStack>
      ))}
    </VStack>
  );
}

function FramesLine({ rowKey, text }: { rowKey: string; text: string }): ReactNode {
  return (
    <Typography variant="caption" color="secondary" className="break-words" testID={`log-frames-${rowKey}`}>
      {text}
    </Typography>
  );
}

interface ThumbnailProps {
  frames: Frames;
  frameKey: string;
  side: Side;
  alt: string;
}

/** Fetched only once it nears the viewport, like a round's frames. */
function Thumbnail(props: ThumbnailProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref);
  return (
    <div ref={ref} className="min-h-16 w-1/2 min-w-0">
      {near ? <LoadedThumbnail {...props} /> : <Typography variant="caption" color="secondary">{props.side}</Typography>}
    </div>
  );
}

function LoadedThumbnail({ frames, frameKey, side, alt }: ThumbnailProps): ReactNode {
  const frame = useQuery("log.frame", { repo: frames.repo, pr: frames.pr, key: frameKey, side });
  const [enlarged, setEnlarged] = useState(false);
  if (frame.status === "loading") return <Spinner size="sm" label={`Loading ${alt}`} />;
  if (frame.data === undefined) return <Typography variant="caption" color="error">{`Could not load ${alt}: ${frame.error.message}`}</Typography>;
  const src = `data:${frame.data.contentType};base64,${frame.data.base64}`;
  return (
    <>
      <button type="button" className="block w-full cursor-zoom-in" aria-label={`Enlarge ${alt}`} onClick={() => setEnlarged(true)}>
        <img src={src} alt={alt} className="block h-auto w-full rounded border border-hairline-strong" />
      </button>
      {enlarged ? <Enlarge src={src} alt={alt} pins={null} onClose={() => setEnlarged(false)} /> : null}
    </>
  );
}
