/**
 * A round's audio variant: the sound from `rounds.audio` with the clip player's controls, and the transcript the variant
 * must carry under it. It never autoplays or loops, since a sound plays aloud. Only a variant's own `audio` reaches it;
 * blind-ab rounds stay refused (`round-schema.ts`).
 */
import type { ReactNode } from "react";
import { Typography, VStack } from "@titan-design/react-ui";
import { MediaControls, useMediaControls } from "./ClipPlayer.js";

/** The URL `rounds.audio` serves a variant's sound at, with byte ranges. */
export const roundAudioUrl = (roundId: string, key: string): string => `/media/rounds/${encodeURIComponent(roundId)}/audio/${encodeURIComponent(key)}`;

interface AudioPlayerProps {
  src: string;
  label: string;
  transcript: string | undefined;
  durationMs: number | undefined;
}

export function AudioPlayer({ src, label, transcript, durationMs }: AudioPlayerProps): ReactNode {
  const sound = useMediaControls<HTMLAudioElement>(false, durationMs);
  return (
    <VStack gap={2} testID="audio-player">
      <audio ref={sound.media} src={src} aria-label={label} loop={sound.loop} preload="metadata" {...sound.events} />
      <MediaControls clip={sound} label={label} />
      {transcript === undefined ? null : <Typography variant="body2">{`“${transcript}”`}</Typography>}
    </VStack>
  );
}

interface RoundAudioProps {
  roundId: string;
  frameKey: string;
  alt: string;
  transcript: string | undefined;
  durationMs: number | undefined;
}

export function RoundAudio({ roundId, frameKey, alt, transcript, durationMs }: RoundAudioProps): ReactNode {
  return <AudioPlayer src={roundAudioUrl(roundId, frameKey)} label={alt} transcript={transcript} durationMs={durationMs} />;
}
