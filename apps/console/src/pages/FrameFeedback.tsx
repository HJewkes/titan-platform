import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Button, ButtonText, Input, Typography } from "@titan-design/react-ui";
import { EMPTY_DRAFT, VERDICTS, toggledVerdict, verdictForKey, type FrameDraft, type Verdict } from "./frame-feedback.js";
import { unlessLocked } from "./RoundLock.js";
import { typedInto } from "./RoundQuestion.js";

/** What the round's keys act on: digits answer a question, letters judge a frame, never the other way round. */
export type ActiveTarget = { kind: "question"; id: string } | { kind: "frame"; key: string };

/** c, x and m set the active frame's verdict and u clears it, unless a modifier is held or the owner is typing in a field. */
function useFrameKeys(active: ActiveTarget | undefined, onVerdict: (key: string, verdict: Verdict | null) => void): void {
  useEffect(() => {
    if (active?.kind !== "frame") return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey || typedInto(event.target)) return;
      const verdict = verdictForKey(event.key);
      if (verdict === undefined) return;
      event.preventDefault();
      onVerdict(active.key, verdict);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onVerdict]);
}

/** Each frame's draft verdict and comment, which frame is active, and the setters its controls and keys call. */
export function useFrameFeedback(active: ActiveTarget | undefined, setActive: (target: ActiveTarget) => void) {
  const [drafts, setDrafts] = useState<Record<string, FrameDraft>>({});
  const update = useCallback(
    (key: string, change: (draft: FrameDraft) => Partial<FrameDraft>) => setDrafts((current) => ({ ...current, [key]: { ...(current[key] ?? EMPTY_DRAFT), ...change(current[key] ?? EMPTY_DRAFT) } })),
    [],
  );
  const setVerdict = useCallback((key: string, verdict: Verdict | null) => update(key, () => ({ verdict })), [update]);
  const pressVerdict = useCallback((key: string, verdict: Verdict) => update(key, (draft) => ({ verdict: toggledVerdict(draft.verdict, verdict) })), [update]);
  const setComment = useCallback((key: string, comment: string) => update(key, () => ({ comment })), [update]);
  const activateFrame = useCallback((key: string) => setActive({ kind: "frame", key }), [setActive]);
  useFrameKeys(active, setVerdict);
  return { drafts, activeFrame: active?.kind === "frame" ? active.key : undefined, activateFrame, pressVerdict, setComment };
}

type FrameFeedbackState = ReturnType<typeof useFrameFeedback> & { locked: boolean };

const FrameFeedbackContext = createContext<FrameFeedbackState | null>(null);

/** Lets every frame of a design round take a verdict and a comment; outside one a frame is a plain figure. */
export function FrameFeedbackProvider({ value, children }: { value: FrameFeedbackState; children: ReactNode }): ReactNode {
  return <FrameFeedbackContext.Provider value={value}>{children}</FrameFeedbackContext.Provider>;
}

const FIGURE = "flex min-w-0 flex-col gap-1";
const ACTIVE_FIGURE = "rounded outline outline-2 outline-offset-4 outline-brand-primary";

interface FrameFigureProps {
  frameKey: string;
  label: string;
  id?: string;
  testID?: string;
  children: ReactNode;
}

/** A frame's figure; inside a design round it ends in the frame's verdict and comment, and pressing it makes it the frame keys judge. */
export function FrameFigure({ frameKey, label, id, testID, children }: FrameFigureProps): ReactNode {
  const feedback = useContext(FrameFeedbackContext);
  if (feedback === null) return <figure id={id} className={FIGURE} data-testid={testID}>{children}</figure>;
  const active = !feedback.locked && feedback.activeFrame === frameKey;
  const activate = unlessLocked(feedback.locked, () => feedback.activateFrame(frameKey));
  return (
    // A frame drawn inside a question's card would hand the press on to the card, which makes the question active again.
    <figure id={id} className={active ? `${FIGURE} ${ACTIVE_FIGURE}` : FIGURE} data-testid={testID} data-active={active || undefined} onPointerDown={activate} onFocus={activate} onClick={(event) => event.stopPropagation()}>
      {children}
      <FrameControls frameKey={frameKey} label={label} active={active} feedback={feedback} />
    </figure>
  );
}

interface FrameControlsProps {
  frameKey: string;
  label: string;
  active: boolean;
  feedback: FrameFeedbackState;
}

function FrameControls({ frameKey, label, active, feedback }: FrameControlsProps): ReactNode {
  const draft = feedback.drafts[frameKey] ?? EMPTY_DRAFT;
  return (
    <div className="flex flex-col gap-1" inert={feedback.locked} data-testid={`frame-feedback-${frameKey}`}>
      <div role="group" aria-label={`Verdict on ${label}`} className="flex flex-wrap items-center gap-1">
        {VERDICTS.map(({ verdict, label: verdictLabel }) => (
          <Button key={verdict} size="sm" variant={draft.verdict === verdict ? "solid" : "outline"} color={VERDICT_COLOR[verdict]} aria-pressed={draft.verdict === verdict} onPress={unlessLocked(feedback.locked, () => feedback.pressVerdict(frameKey, verdict))}>
            <ButtonText>{verdictLabel}</ButtonText>
          </Button>
        ))}
      </div>
      {/* The hint keeps its line on every frame: a press that moved the frames below it would land on another control. */}
      <div className={active ? undefined : "invisible"} aria-hidden={!active}>
        <Typography variant="caption" color="secondary">c chosen · x rejected · m maybe · u clear</Typography>
      </div>
      <Input multiline numberOfLines={2} label="Frame comment (optional)" accessibilityLabel={`Comment on frame ${label}`} value={draft.comment} onChangeText={unlessLocked(feedback.locked, (text: string) => feedback.setComment(frameKey, text))} />
    </div>
  );
}

const VERDICT_COLOR = { chosen: "success", rejected: "error", maybe: "warning" } as const satisfies Record<Verdict, string>;
