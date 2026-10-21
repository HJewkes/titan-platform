import { createContext, useContext, useEffect, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from "react";
import { Button, ButtonText, HStack, Input, VStack } from "@titan-design/react-ui";
import { useQuery } from "../data/rpc.js";
import { describeTarget, isTap, pinNumber, pngSurface, pointerPin, type Pin, type PngWidths, type TargetBox } from "./frame-pins.js";

/** Where a pin is drawn: enough of a draft or a sent pin to number and place it. */
export type DrawnPin = Pick<Pin, "id" | "xPct" | "yPct">;

/** One frame's pins as its figure shares them with the image inside it; outside a design round's figure there is none. */
export interface FramePins {
  frameKey: string;
  label: string;
  pins: readonly DrawnPin[];
  widths: PngWidths;
  /** In pin mode: a press on the image places a pin. Never true once the round is sent. */
  placing: boolean;
  place: (pin: Omit<Pin, "id" | "note">) => void;
  leave: () => void;
  /** The pins' notes, shown under the image in the full-size view where a phone places them. */
  notes?: ReactNode;
}

const FramePinsContext = createContext<FramePins | null>(null);

export function FramePinsProvider({ value, children }: { value: FramePins | null; children: ReactNode }): ReactNode {
  return <FramePinsContext.Provider value={value}>{children}</FramePinsContext.Provider>;
}

export const useFramePins = (): FramePins | null => useContext(FramePinsContext);

const COARSE_POINTER = "(pointer: coarse)";

/** A phone or tablet: its strip draws a frame too small to aim at, so pins are placed in the full-size view. */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(COARSE_POINTER).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(COARSE_POINTER);
    const onChange = (): void => setCoarse(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return coarse;
}

const LAYER = "absolute inset-0";
const PLACING = "cursor-crosshair rounded outline-dashed outline-2 outline-brand-primary";

/** The size of what the pins sit on, in its own px: a PNG's natural pixels, or a composed frame's declared size. */
type SurfaceSize = { width: number; height: number };

interface PinLayerProps {
  pins: FramePins;
  /** Read at each tap; undefined until the surface has a size. */
  size: () => SurfaceSize | undefined;
}

/** An image's natural pixels, once it has loaded. */
export const naturalSize = (image: RefObject<HTMLImageElement | null>) => (): SurfaceSize | undefined =>
  image.current ? { width: image.current.naturalWidth, height: image.current.naturalHeight } : undefined;

/**
 * The frame's pins drawn over its image, each at its share of the width and height so any scale shows it in place. In
 * pin mode a tap places one; a press that moved more than a few px was a scroll and places nothing.
 */
export function PinLayer(props: PinLayerProps): ReactNode {
  const { placing, widths } = props.pins;
  if (!placing) return <div className={`${LAYER} pointer-events-none`}><PinMarkers pins={props.pins} /></div>;
  if (widths.targetsRoundId === undefined) return <PlacingLayer {...props} />;
  return <TargetedPlacingLayer {...props} roundId={widths.targetsRoundId} />;
}

/** Pin mode on a frame with an element map: until its boxes arrive, or if the read is refused, a pin is coordinates only. */
function TargetedPlacingLayer({ roundId, ...props }: PinLayerProps & { roundId: string }): ReactNode {
  const read = useQuery("rounds.frameTargets", { id: roundId, key: props.pins.frameKey });
  return <PlacingLayer {...props} boxes={read.data?.boxes} />;
}

function PlacingLayer({ pins, size, boxes }: PinLayerProps & { boxes?: readonly TargetBox[] }): ReactNode {
  const down = useRef<{ clientX: number; clientY: number } | null>(null);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    // After a touch the browser sends a mousedown, which would take focus off the new pin's note before the owner types.
    event.preventDefault();
    down.current = { clientX: event.clientX, clientY: event.clientY };
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const start = down.current;
    down.current = null;
    const natural = size();
    if (start === null || natural === undefined || !isTap(start, event)) return;
    const surface = pngSurface(pins.widths, natural, boxes);
    if (surface) pins.place(pointerPin(event, event.currentTarget.getBoundingClientRect(), surface));
  };
  return (
    <div className={`${LAYER} ${PLACING}`} data-testid={`pin-layer-${pins.frameKey}`} aria-label={`Place a pin on ${pins.label}`} onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
      <PinMarkers pins={pins} />
    </div>
  );
}

function PinMarkers({ pins: { frameKey, pins } }: { pins: FramePins }): ReactNode {
  return pins.map((pin) => (
    <span
      key={pin.id}
      data-testid={`pin-marker-${pin.id}`}
      className="pointer-events-none absolute flex h-6 min-w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-brand-primary px-1 text-xs font-semibold text-white shadow"
      style={{ left: `${pin.xPct * 100}%`, top: `${pin.yPct * 100}%` }}
    >
      {pinNumber(frameKey, pin.id)}
    </span>
  ));
}

interface PinListProps {
  frameKey: string;
  pins: readonly Pin[];
  /** The pin just placed, whose note takes focus. */
  focusPin: string | undefined;
  onNote: (id: string, note: string) => void;
  onRemove: (id: string) => void;
}

/** Each draft pin as its number, what it sits on, its note and Remove. */
export function PinList({ frameKey, pins, focusPin, onNote, onRemove }: PinListProps): ReactNode {
  if (pins.length === 0) return null;
  return (
    <VStack gap={2} testID={`pin-list-${frameKey}`}>
      {pins.map((pin) => {
        const n = pinNumber(frameKey, pin.id);
        return (
          <HStack key={pin.id} gap={2} align="end">
            <div className="min-w-0 flex-1">
              <Input label={`Pin ${n} · ${describeTarget(pin.target)}`} accessibilityLabel={`Note for pin ${n}`} placeholder="What about this spot?" autoFocus={pin.id === focusPin} value={pin.note} onChangeText={(text: string) => onNote(pin.id, text)} />
            </div>
            <Button size="sm" variant="ghost" accessibilityLabel={`Remove pin ${n}`} onPress={() => onRemove(pin.id)}><ButtonText>Remove</ButtonText></Button>
          </HStack>
        );
      })}
    </VStack>
  );
}
