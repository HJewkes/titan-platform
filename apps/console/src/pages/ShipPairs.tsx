import type { ReactNode } from "react";
import { Typography } from "@titan-design/react-ui";

interface Merge {
  repo: string;
  pr: number;
  headSha: string;
}

/** Changed frames lead and unchanged ones fold away, so a Ship round reads as what main gains at this head (TP-3520). */
export function splitUnchanged<F extends { unchanged: boolean }>(frames: readonly F[]): { changed: F[]; unchanged: F[] } {
  return { changed: frames.filter((frame) => !frame.unchanged), unchanged: frames.filter((frame) => frame.unchanged) };
}

export function WhatShips({ merge, changed }: { merge: Merge; changed: number }): ReactNode {
  const frames = `${changed} changed ${changed === 1 ? "frame" : "frames"}`;
  return (
    <div data-testid="what-ships">
      <Typography variant="subtitle2">{`What ships: ${merge.repo}#${merge.pr} at ${merge.headSha.slice(0, 7)}, ${frames}`}</Typography>
    </div>
  );
}

export function UnchangedFrames({ count, children }: { count: number; children: ReactNode }): ReactNode {
  if (count === 0) return null;
  return (
    <details className="flex flex-col gap-6" data-testid="unchanged-frames">
      <summary className="cursor-pointer">
        <Typography variant="subtitle2" color="secondary">{`${count} unchanged: main and head render the same`}</Typography>
      </summary>
      <div className="mt-4 flex flex-col gap-6">{children}</div>
    </details>
  );
}
