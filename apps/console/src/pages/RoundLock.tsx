import type { ReactNode } from "react";
import type { Question } from "../../server/round-schema.js";

/** Runs `act` only while the question is open; `inert` already stops a pointer, this stops what reaches it anyway. */
export const unlessLocked = <A extends unknown[]>(locked: boolean, act: (...args: A) => void) => (...args: A): void => {
  if (!locked) act(...args);
};

/** One question with its comment; locked (sent or sending), it shows the answer as given and takes no more edits. */
export function LockedQuestion({ locked, testID, children }: { locked: boolean; testID: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col gap-2" inert={locked} data-testid={testID}>
      {children}
    </div>
  );
}

/** The comment as sent, read-only once locked: the page holds feedback.json's after a reload, its own while the press is in flight or just landed. */
export const sentComment = (comments: Readonly<Record<string, string>>, question: Question, locked: boolean): string | undefined =>
  locked ? (comments[question.id] ?? "").trim() : undefined;
