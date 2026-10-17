import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button, ButtonText, HStack, Spinner, Typography } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";

export type FrameView = ConsoleCommands["rounds.frame"]["args"]["view"];

/** Frames start loading this far below the fold, so a scroll rarely shows an empty panel. */
const NEAR_VIEWPORT = "400px";

interface FrameImageProps {
  roundId: string;
  frameKey: string;
  view: FrameView;
  alt: string;
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

function useNearViewport(ref: RefObject<HTMLElement | null>): boolean {
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

function LoadedFrame({ roundId, frameKey, view, alt }: FrameImageProps): ReactNode {
  const frame = useQuery("rounds.frame", { id: roundId, key: frameKey, view });
  const [enlarged, setEnlarged] = useState(false);
  if (frame.status === "loading") return <Spinner size="sm" label={`Loading ${alt}`} />;
  if (frame.data === undefined) return <Typography variant="caption" color="error">{`Could not load ${alt}: ${frame.error.message}`}</Typography>;
  const src = `data:${frame.data.contentType};base64,${frame.data.base64}`;
  return (
    <>
      <button type="button" className="block w-full cursor-zoom-in" aria-label={`Enlarge ${alt}`} onClick={() => setEnlarged(true)}>
        <img src={src} alt={alt} className="block h-auto w-full rounded border border-hairline-strong" />
      </button>
      {enlarged ? <Enlarge src={src} alt={alt} onClose={() => setEnlarged(false)} /> : null}
    </>
  );
}

/** The image at least as wide as the screen, scrolling sideways when it is wider; Escape or Close leaves. */
function Enlarge({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }): ReactNode {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={alt} className="fixed inset-0 z-50 flex flex-col gap-3 bg-surface-base p-4">
      <HStack gap={3} align="center" justify="between">
        <Typography variant="subtitle2">{alt}</Typography>
        <Button variant="outline" size="sm" onPress={onClose}><ButtonText>Close</ButtonText></Button>
      </HStack>
      <div className="flex-1 overflow-auto">
        <img src={src} alt={alt} className="h-auto min-w-full max-w-none" />
      </div>
    </div>
  );
}
