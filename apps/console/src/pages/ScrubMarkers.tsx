import type { ReactNode } from "react";
import { formatAt } from "./TheaterComment.js";

interface Marker {
  id: string;
  atS: number;
  current: boolean;
}

/** Where a note sits along the video, as a percentage; a note past the end (an earlier, longer cut) pins to the end. */
function markerPercent(atS: number, duration: number): number {
  return Math.min(100, (atS / duration) * 100);
}

/**
 * One tick per note on the render now on disk, laid along a strip under the video. The strip sits
 * outside the native controls because iOS fullscreen hides anything drawn over the video.
 */
export function ScrubMarkers({ notes, duration, seek }: { notes: readonly Marker[]; duration: number; seek: (seconds: number) => void }): ReactNode {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const current = notes.filter((note) => note.current);
  if (current.length === 0) return null;
  return (
    <div className="relative h-6 w-full max-w-3xl rounded bg-surface-raised" data-testid="theater-markers">
      {current.map((note) => (
        <button
          key={note.id}
          type="button"
          aria-label={`Seek to ${formatAt(note.atS)}`}
          onClick={() => seek(note.atS)}
          className="absolute top-0 h-6 w-4 -translate-x-1/2 after:mx-auto after:block after:h-full after:w-0.5 after:bg-brand-primary"
          style={{ left: `${markerPercent(note.atS, duration)}%` }}
          data-testid={`theater-marker-${note.id}`}
        />
      ))}
    </div>
  );
}
