import { useEffect, useRef, useState, type ReactNode, type RefObject, type SyntheticEvent } from "react";
import { Button, ButtonText, HStack, Spinner, Typography } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { PinLayer, naturalSize, useCoarsePointer, useFramePins, type FramePins } from "./FramePins.js";

export type FrameView = ConsoleCommands["rounds.frame"]["args"]["view"];

/** Frames start loading this far below the fold, so a scroll rarely shows an empty panel. */
export const NEAR_VIEWPORT = "400px";

interface FrameImageProps {
  roundId: string;
  frameKey: string;
  view: FrameView;
  alt: string;
  /** Draws the PNG this many CSS px wide, its true size, instead of fitting it to its box. */
  trueWidth?: number;
  /** Laid over the image, inside its box, such as a true-size frame's ladder. */
  overlay?: ReactNode;
  /** Told the PNG's natural pixels once it loads, such as to check them against the frame's declared size. */
  onNaturalSize?: (size: { width: number; height: number }) => void;
}

/** One PNG of a round, fetched only once it nears the viewport; pressing it opens it at full size. */
export function FrameImage(props: FrameImageProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref);
  return (
    <div ref={ref} className="min-h-16">
      {near ? <LoadedFrame {...props} /> : <Typography variant="caption" color="secondary">Loads when scrolled into view</Typography>}
    </div>
  );
}

export function useNearViewport(ref: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (near || element === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true);
    }, { rootMargin: NEAR_VIEWPORT });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, near]);
  return near;
}

function LoadedFrame({ roundId, frameKey, view, alt, trueWidth, overlay, onNaturalSize }: FrameImageProps): ReactNode {
  const frame = useQuery("rounds.frame", { id: roundId, key: frameKey, view });
  const [enlarged, setEnlarged] = useState(false);
  const pins = useFramePins();
  const coarse = useCoarsePointer();
  const image = useRef<HTMLImageElement>(null);
  const onLoad = useLoadRender(onNaturalSize);
  if (frame.status === "loading") return <Spinner size="sm" label={`Loading ${alt}`} />;
  if (frame.data === undefined) return <Typography variant="caption" color="error">{`Could not load ${alt}: ${frame.error.message}`}</Typography>;
  const src = `data:${frame.data.contentType};base64,${frame.data.base64}`;
  // On a coarse pointer the strip draws the frame too small to aim at, so pin mode places pins in the full-size view.
  const pinsFullSize = pins !== null && pins.placing && coarse;
  const close = (): void => {
    setEnlarged(false);
    if (pinsFullSize) pins.leave();
  };
  return (
    <>
      <div className="relative" style={trueWidth === undefined ? undefined : { width: trueWidth }}>
        <button type="button" className="block w-full cursor-zoom-in" aria-label={`Enlarge ${alt}`} onClick={() => setEnlarged(true)}>
          <img ref={image} src={src} alt={alt} className="block h-auto w-full rounded border border-hairline-strong" onLoad={onLoad} />
        </button>
        {overlay}
        {pins ? <PinLayer pins={{ ...pins, placing: pins.placing && !coarse }} size={naturalSize(image)} /> : null}
      </div>
      {enlarged || pinsFullSize ? <Enlarge src={src} alt={alt} pins={pinsFullSize ? pins : null} onClose={close} /> : null}
    </>
  );
}

/** Renders again once the image loads, so its pins are drawn for the width its natural pixels give it, and tells `onNaturalSize` those pixels. */
function useLoadRender(onNaturalSize?: (size: { width: number; height: number }) => void): (event: SyntheticEvent<HTMLImageElement>) => void {
  const [, setLoaded] = useState(false);
  return (event) => {
    setLoaded(true);
    onNaturalSize?.({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
  };
}

/** A full-size view leaves on Escape. */
export function useEscapeKey(onClose: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

interface EnlargeProps {
  src: string;
  alt: string;
  /** In pin mode a tap on the image places a pin at true size. */
  pins: FramePins | null;
  onClose: () => void;
}

/** The image at least as wide as the screen, scrolling sideways when it is wider; Escape or Close leaves. */
export function Enlarge({ src, alt, pins, onClose }: EnlargeProps): ReactNode {
  const image = useRef<HTMLImageElement>(null);
  const onLoad = useLoadRender();
  useEscapeKey(onClose);
  return (
    <div role="dialog" aria-modal="true" aria-label={alt} className="fixed inset-0 z-50 flex flex-col gap-3 bg-surface-base p-4">
      <HStack gap={3} align="center" justify="between">
        <Typography variant="subtitle2">{pins ? `Tap ${alt} to pin it` : alt}</Typography>
        <Button variant="outline" size="sm" onPress={onClose}><ButtonText>{pins ? "Done" : "Close"}</ButtonText></Button>
      </HStack>
      <div className="flex-1 overflow-auto">
        <div className="relative w-max min-w-full">
          <img ref={image} src={src} alt={alt} className="block h-auto w-full max-w-none" onLoad={onLoad} />
          {pins ? <PinLayer pins={pins} size={naturalSize(image)} /> : null}
        </div>
      </div>
      {pins?.notes}
    </div>
  );
}
