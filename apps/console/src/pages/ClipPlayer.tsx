/**
 * A round's recorded clip, played (decision 339(2): "a play button (probably autoplay with loop) and a scrubber for
 * animations, static screenshots are not helpful"). Muted so the browser lets it autoplay; play/pause, loop, a scrubber
 * and, when the variant's motion names them, a seek button per keyframe. react-ui has no slider or video player, so the
 * scrubber is a native range input.
 */
import { useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { Button, ButtonText, HStack, Typography, VStack } from "@titan-design/react-ui";
import type { Manifest } from "../../server/round-schema.js";
import { useNearViewport } from "./RoundFrame.js";

type Motion = NonNullable<Manifest["variants"][number]["motion"]>;
export type ClipMotion = Extract<Motion, { mechanism: "clip" }>;
type Keyframe = NonNullable<ClipMotion["keyframes"]>[number];

/** The URL `rounds.clip` serves a variant's clip at, with byte ranges. */
export const roundClipUrl = (roundId: string, key: string): string => `/media/rounds/${encodeURIComponent(roundId)}/clip/${encodeURIComponent(key)}`;

const seconds = (s: number): string => `${s.toFixed(1)} s`;

interface ClipPlayerProps {
  src: string;
  label: string;
  /** Starts playing on mount, as review-schema's clip motion defaults it. */
  autoplay?: boolean;
  loop?: boolean;
  /** The clip's stated length, used until the file's own metadata loads. */
  durationMs?: number;
  keyframes?: readonly Keyframe[];
}

/** The player's state, kept in step with the video's own events, and the seeks and toggles its controls press. */
function useClip(initialLoop: boolean, durationMs: number | undefined) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(initialLoop);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(durationMs === undefined ? 0 : durationMs / 1000);
  const seek = (to: number): void => {
    if (video.current === null) return;
    video.current.currentTime = to;
    setTime(to);
  };
  const toggle = (): void => {
    const element = video.current;
    if (element === null) return;
    if (playing) element.pause();
    else void element.play().catch(() => setPlaying(false));
  };
  const events = {
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onTimeUpdate: (event: SyntheticEvent<HTMLVideoElement>) => setTime(event.currentTarget.currentTime),
    onLoadedMetadata: (event: SyntheticEvent<HTMLVideoElement>) => Number.isFinite(event.currentTarget.duration) && setDuration(event.currentTarget.duration),
  };
  return { video, events, playing, loop, time, duration, seek, toggle, toggleLoop: () => setLoop(!loop) };
}

type Clip = ReturnType<typeof useClip>;

export function ClipPlayer({ src, label, autoplay = true, loop = true, durationMs, keyframes = [] }: ClipPlayerProps): ReactNode {
  const clip = useClip(loop, durationMs);
  return (
    <VStack gap={2} testID="clip-player">
      <video
        ref={clip.video}
        src={src}
        aria-label={label}
        muted
        playsInline
        autoPlay={autoplay}
        loop={clip.loop}
        preload="metadata"
        className="block h-auto w-full rounded border border-hairline-strong bg-surface-sunken"
        {...clip.events}
      />
      <ClipControls clip={clip} label={label} />
      <Keyframes keyframes={keyframes} seek={clip.seek} />
    </VStack>
  );
}

function ClipControls({ clip, label }: { clip: Clip; label: string }): ReactNode {
  const { playing, loop, time, duration } = clip;
  return (
    <HStack gap={2} align="center" wrap>
      <Button size="sm" variant="outline" onPress={clip.toggle}><ButtonText>{playing ? "Pause" : "Play"}</ButtonText></Button>
      <Button size="sm" variant={loop ? "solid" : "outline"} aria-pressed={loop} onPress={clip.toggleLoop}><ButtonText>Loop</ButtonText></Button>
      <input
        type="range"
        aria-label={`Scrub ${label}`}
        min={0}
        max={duration}
        step={0.01}
        value={Math.min(time, duration)}
        disabled={duration === 0}
        onChange={(event) => clip.seek(Number(event.currentTarget.value))}
        className="min-w-24 flex-1"
      />
      <Typography variant="caption" color="secondary">{`${seconds(time)} / ${seconds(duration)}`}</Typography>
    </HStack>
  );
}

function Keyframes({ keyframes, seek }: { keyframes: readonly Keyframe[]; seek: (to: number) => void }): ReactNode {
  if (keyframes.length === 0) return null;
  return (
    <HStack gap={1} align="center" wrap>
      <Typography variant="caption" color="secondary">Keyframes:</Typography>
      {keyframes.map(({ atMs, label }) => (
        <Button key={atMs} size="sm" variant="outline" aria-label={`Seek to ${label}`} onPress={() => seek(atMs / 1000)}>
          <ButtonText>{`${label} · ${seconds(atMs / 1000)}`}</ButtonText>
        </Button>
      ))}
    </HStack>
  );
}

interface RoundClipProps {
  roundId: string;
  frameKey: string;
  alt: string;
  motion: Motion | undefined;
}

/** A clip variant, loaded only once it nears the viewport, with its clip motion's playback and keyframes. */
export function RoundClip({ roundId, frameKey, alt, motion }: RoundClipProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref);
  const clip = motion?.mechanism === "clip" ? motion : undefined;
  return (
    <div ref={ref} className="min-h-16">
      {near ? (
        <ClipPlayer src={roundClipUrl(roundId, frameKey)} label={alt} autoplay={clip?.autoplay} loop={clip?.loop} durationMs={clip?.durationMs} keyframes={clip?.keyframes} />
      ) : (
        <Typography variant="caption" color="secondary">Loads when scrolled into view</Typography>
      )}
    </div>
  );
}
