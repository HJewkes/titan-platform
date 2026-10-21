import { createContext, useCallback, useContext, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Button, ButtonText, Input, Pill, Typography, VStack } from "@titan-design/react-ui";
import type { RoundNotes } from "../../server/rounds.js";
import { EMPTY_DRAFT, VERDICTS, draftsFromSent, toggledVerdict, verdictForKey, type FrameDraft, type Verdict } from "./frame-feedback.js";
import { nextPinId, pinNumber, type Pin, type PngWidths } from "./frame-pins.js";
import { FramePinsProvider, PinList, useCoarsePointer, type DrawnPin, type FramePins } from "./FramePins.js";
import { typedInto } from "./typed-into.js";

/** What the round's keys act on: digits answer a question, letters judge a frame, never the other way round. */
export type ActiveTarget = { kind: "question"; id: string } | { kind: "frame"; key: string; pinning?: true };

/** The harness's annotate key: it toggles the active frame's pin mode. */
const PIN_KEY = "a";

interface FrameKeyActions {
  verdict: (key: string, verdict: Verdict | null) => void;
  togglePins: (key: string) => void;
  leavePins: () => void;
}

/**
 * c, x and m set the active frame's verdict, u clears it and a toggles pin mode, unless a modifier is held or the owner
 * is typing in a field. Escape leaves pin mode even from a pin's note, since it types nothing.
 */
function useFrameKeys(active: ActiveTarget | undefined, actions: FrameKeyActions): void {
  useEffect(() => {
    if (active?.kind !== "frame") return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") return actions.leavePins();
      if (typedInto(event.target)) return;
      if (event.key === PIN_KEY) {
        event.preventDefault();
        return actions.togglePins(active.key);
      }
      const verdict = verdictForKey(event.key);
      if (verdict === undefined) return;
      event.preventDefault();
      actions.verdict(active.key, verdict);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, actions]);
}

type SetTarget = Dispatch<SetStateAction<ActiveTarget | undefined>>;
type UpdateDraft = (key: string, change: (draft: FrameDraft) => Partial<FrameDraft>) => void;

const isFrame = (target: ActiveTarget | undefined, key: string): target is Extract<ActiveTarget, { kind: "frame" }> => target?.kind === "frame" && target.key === key;

/** Pin mode lives on the active frame, so turning to a question or another frame leaves it. A press on the same frame keeps it. */
function usePinMode(setActive: SetTarget, locked: boolean) {
  const activateFrame = useCallback((key: string) => (locked ? undefined : setActive((current) => (isFrame(current, key) ? current : { kind: "frame", key }))), [locked, setActive]);
  const togglePins = useCallback(
    (key: string) => (locked ? undefined : setActive((current) => (isFrame(current, key) && current.pinning ? { kind: "frame", key } : { kind: "frame", key, pinning: true }))),
    [locked, setActive],
  );
  const leavePins = useCallback(() => setActive((current) => (current?.kind === "frame" && current.pinning ? { kind: "frame", key: current.key } : current)), [setActive]);
  return { activateFrame, togglePins, leavePins };
}

/** Placing, noting and removing a frame's draft pins; the pin just placed is the one whose note takes focus. */
function useDraftPins(drafts: Readonly<Record<string, FrameDraft>>, update: UpdateDraft) {
  const [focusPin, setFocusPin] = useState<string>();
  const addPin = useCallback(
    (key: string, pin: Omit<Pin, "id" | "note">) => {
      const draft = drafts[key] ?? EMPTY_DRAFT;
      const id = nextPinId(key, draft.pins, draft.pinsIssued);
      update(key, (current) => ({ pins: [...current.pins, { ...pin, id, note: "" }], pinsIssued: Number(pinNumber(key, id)) }));
      setFocusPin(id);
    },
    [drafts, update],
  );
  const setPinNote = useCallback((key: string, id: string, note: string) => update(key, ({ pins }) => ({ pins: pins.map((pin) => (pin.id === id ? { ...pin, note } : pin)) })), [update]);
  const removePin = useCallback((key: string, id: string) => update(key, ({ pins }) => ({ pins: pins.filter((pin) => pin.id !== id) })), [update]);
  return { focusPin, addPin, setPinNote, removePin };
}

/**
 * Each frame's draft verdict, comment and pins, which frame is active and whether it is in pin mode, and the setters its
 * controls and keys call. Locked (sent or sending), every one of them is a no-op and no frame is active, so nothing
 * changes what was sent. A sent round's `frames` seed the drafts and carry the pins, so a reload shows what was sent.
 */
export function useFrameFeedback(active: ActiveTarget | undefined, setActive: SetTarget, locked: boolean, sent?: RoundNotes["frames"]) {
  const [drafts, setDrafts] = useState<Record<string, FrameDraft>>(() => draftsFromSent(sent));
  const update = useCallback<UpdateDraft>(
    (key, change) => {
      if (!locked) setDrafts((current) => ({ ...current, [key]: { ...(current[key] ?? EMPTY_DRAFT), ...change(current[key] ?? EMPTY_DRAFT) } }));
    },
    [locked],
  );
  const setVerdict = useCallback((key: string, verdict: Verdict | null) => update(key, () => ({ verdict })), [update]);
  const pressVerdict = useCallback((key: string, verdict: Verdict) => update(key, (draft) => ({ verdict: toggledVerdict(draft.verdict, verdict) })), [update]);
  const setComment = useCallback((key: string, comment: string) => update(key, () => ({ comment })), [update]);
  const mode = usePinMode(setActive, locked);
  const keyActions = useMemo(() => ({ verdict: setVerdict, togglePins: mode.togglePins, leavePins: mode.leavePins }), [setVerdict, mode.togglePins, mode.leavePins]);
  useFrameKeys(locked ? undefined : active, keyActions);
  const live = locked ? undefined : active;
  const activeFrame = live?.kind === "frame" ? live.key : undefined;
  const pinning = live?.kind === "frame" && live.pinning ? live.key : undefined;
  const pins = useDraftPins(drafts, update);
  return { drafts, sent, activeFrame, pinning, pressVerdict, setComment, ...mode, ...pins, locked };
}

type FrameFeedbackState = ReturnType<typeof useFrameFeedback>;
type FrameFeedbackValue = FrameFeedbackState & { widths: ReadonlyMap<string, PngWidths> };

const FrameFeedbackContext = createContext<FrameFeedbackValue | null>(null);

interface FrameFeedbackProviderProps {
  value: FrameFeedbackState;
  /** Each frame's declared widths, which its pins are measured in ahead of the PNG's own pixels. */
  widths?: ReadonlyMap<string, PngWidths>;
  children: ReactNode;
}

/** Lets every frame of a design round take a verdict, a comment and pins; outside one a frame is a plain figure. */
export function FrameFeedbackProvider({ value, widths = NO_WIDTHS, children }: FrameFeedbackProviderProps): ReactNode {
  const shared = useMemo(() => ({ ...value, widths }), [value, widths]);
  return <FrameFeedbackContext.Provider value={shared}>{children}</FrameFeedbackContext.Provider>;
}

const NO_WIDTHS: ReadonlyMap<string, PngWidths> = new Map();

const FIGURE = "flex min-w-0 flex-col gap-1";
const ACTIVE_FIGURE = "rounded outline outline-2 outline-offset-4 outline-brand-primary";

interface FrameFigureProps {
  frameKey: string;
  label: string;
  /** The figure draws the frame's PNG, so pins have somewhere to go. */
  pinnable: boolean;
  id?: string;
  testID?: string;
  children: ReactNode;
}

/** A sent round's pins for the frame; undefined while answering or checking before the send, when the draft's pins stand. */
const lockedPins = (feedback: FrameFeedbackValue, frameKey: string): readonly DrawnPin[] | undefined => (feedback.locked ? feedback.sent?.[frameKey]?.annotations : undefined);

/** The pins the frame's image draws: the draft's while answering, the sent ones once locked, placeable only in pin mode. */
function framePins(feedback: FrameFeedbackValue, frameKey: string, label: string): FramePins {
  const pins = lockedPins(feedback, frameKey) ?? (feedback.drafts[frameKey] ?? EMPTY_DRAFT).pins;
  const widths = feedback.widths.get(frameKey) ?? {};
  const notes = <DraftPinList frameKey={frameKey} feedback={feedback} focus />;
  return { frameKey, label, pins, widths, placing: feedback.pinning === frameKey, place: (pin) => feedback.addPin(frameKey, pin), leave: feedback.leavePins, notes };
}

/** A frame's draft pins with their notes; only the list on screen hands the pin just placed its focus. */
function DraftPinList({ frameKey, feedback, focus }: { frameKey: string; feedback: FrameFeedbackValue; focus: boolean }): ReactNode {
  const { pins } = feedback.drafts[frameKey] ?? EMPTY_DRAFT;
  return (
    <PinList
      frameKey={frameKey}
      pins={pins}
      focusPin={focus ? feedback.focusPin : undefined}
      onNote={(id, note) => feedback.setPinNote(frameKey, id, note)}
      onRemove={(id) => feedback.removePin(frameKey, id)}
    />
  );
}

/** A frame's figure; inside a design round it ends in the frame's verdict, comment and pins, and pressing it makes it the frame keys judge. */
export function FrameFigure({ frameKey, label, pinnable, id, testID, children }: FrameFigureProps): ReactNode {
  const feedback = useContext(FrameFeedbackContext);
  if (feedback === null) return <figure id={id} className={FIGURE} data-testid={testID}>{children}</figure>;
  const active = feedback.activeFrame === frameKey;
  const activate = (): void => feedback.activateFrame(frameKey);
  return (
    // A frame drawn inside a question's card would hand the press on to the card, which makes the question active again.
    <figure id={id} className={active ? `${FIGURE} ${ACTIVE_FIGURE}` : FIGURE} data-testid={testID} data-active={active || undefined} onPointerDown={activate} onFocus={activate} onClick={(event) => event.stopPropagation()}>
      <FramePinsProvider value={framePins(feedback, frameKey, label)}>{children}</FramePinsProvider>
      <FrameControls frameKey={frameKey} label={label} pinnable={pinnable} active={active} feedback={feedback} />
    </figure>
  );
}

interface FrameControlsProps {
  frameKey: string;
  label: string;
  pinnable: boolean;
  active: boolean;
  feedback: FrameFeedbackValue;
}

function FrameControls({ frameKey, label, pinnable, active, feedback }: FrameControlsProps): ReactNode {
  const draft = feedback.drafts[frameKey] ?? EMPTY_DRAFT;
  const coarse = useCoarsePointer();
  if (feedback.locked) return <SentFrameFeedback frameKey={frameKey} draft={draft} pins={feedback.sent?.[frameKey]?.annotations ?? draft.pins} />;
  const pinning = feedback.pinning === frameKey;
  return (
    <div className="flex flex-col gap-1" inert={feedback.locked} data-testid={`frame-feedback-${frameKey}`}>
      <div role="group" aria-label={`Verdict on ${label}`} className="flex flex-wrap items-center gap-1">
        {VERDICTS.map(({ verdict, label: verdictLabel }) => (
          <Button key={verdict} size="sm" variant={draft.verdict === verdict ? "solid" : "outline"} color={VERDICT_COLOR[verdict]} aria-pressed={draft.verdict === verdict} onPress={() => feedback.pressVerdict(frameKey, verdict)}>
            <ButtonText>{verdictLabel}</ButtonText>
          </Button>
        ))}
        {pinnable ? (
          <Button size="sm" variant={pinning ? "solid" : "ghost"} aria-pressed={pinning} accessibilityLabel={`Pin ${label}`} onPress={() => feedback.togglePins(frameKey)}>
            <ButtonText>{pinning ? "Pinning" : "Pin"}</ButtonText>
          </Button>
        ) : null}
      </div>
      {/* The hint keeps its line on every frame: a press that moved the frames below it would land on another control. */}
      <div className={active ? undefined : "invisible"} aria-hidden={!active}>
        <Typography variant="caption" color="secondary">{pinning ? PINNING_HINT : pinnable ? `${VERDICT_HINT} · a pin` : VERDICT_HINT}</Typography>
      </div>
      {/* On a phone pins are placed full size, whose own list takes the new pin's focus. */}
      <DraftPinList frameKey={frameKey} feedback={feedback} focus={!(pinning && coarse)} />
      <Input multiline numberOfLines={2} label="Frame comment (optional)" accessibilityLabel={`Comment on frame ${label}`} value={draft.comment} onChangeText={(text: string) => feedback.setComment(frameKey, text)} />
    </div>
  );
}

const VERDICT_HINT = "c chosen · x rejected · m maybe · u clear";
const PINNING_HINT = "Click the frame to place a pin · a or Esc to stop";

type SentPin = NonNullable<RoundNotes["frames"]>[string]["annotations"][number];

/** A locked frame's feedback as sent: the verdict a pill, the comment as typed, each pin a numbered line. Nothing to edit. */
function SentFrameFeedback({ frameKey, draft, pins }: { frameKey: string; draft: FrameDraft; pins: readonly SentPin[] }): ReactNode {
  const comment = draft.comment.trim();
  if (draft.verdict === null && comment === "" && pins.length === 0) return null;
  const verdict = VERDICTS.find((each) => each.verdict === draft.verdict);
  return (
    <VStack gap={1} testID={`frame-feedback-sent-${frameKey}`}>
      {verdict ? (
        <div className="self-start">
          <Pill variant="subtle" size="xs" tone={VERDICT_COLOR[verdict.verdict]}>{verdict.label}</Pill>
        </div>
      ) : null}
      {comment ? <Typography variant="body2">{comment}</Typography> : null}
      {pins.map((pin) => (
        <Typography key={pin.id} variant="caption" color="secondary">{pinLine(frameKey, pin)}</Typography>
      ))}
    </VStack>
  );
}

/** Each sent pin is drawn on the frame and also read out as its number, place and note. */
function pinLine(frameKey: string, { id, xPct, yPct, note, target }: SentPin): string {
  const place = `${Math.round(xPct * 100)}%, ${Math.round(yPct * 100)}%`;
  const on = target?.testId ? ` on #${target.testId}` : "";
  return `Pin ${pinNumber(frameKey, id)} at ${place}${on}: ${note}`;
}

const VERDICT_COLOR = { chosen: "success", rejected: "error", maybe: "warning" } as const satisfies Record<Verdict, string>;
