import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Alert, Button, ButtonText, Card, CardContent, HStack, Heading, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useAnswerSource } from "../data/submit.js";
import { SlotForm } from "./SlotForm.js";
import { formatAt } from "./TheaterComment.js";
import { beatAt, changedFields, controlOf, idsIn, placeProblems, type Fields } from "./slot-form.js";

type BeatProps = NonNullable<ConsoleCommands["videos.props"]["result"]["props"]>;
type Beat = BeatProps["beats"][number];
type Verdict = NonNullable<ConsoleCommands["videos.edit-check"]["result"]["verdict"]>;
type Check = { status: "idle" } | { status: "checking" } | { status: "checked"; verdict: Verdict | null; gaps: readonly string[] } | { status: "failed"; error: string };

/** Long enough that a word typed on a phone keyboard is one check, short enough that the verdict follows the typing. */
const CHECK_DEBOUNCE_MS = 400;

/** The draft through `videos.edit-check` once typing pauses; nothing is sent while the draft equals the render. */
function useEditCheck(videoId: string, props: BeatProps, beatId: string, slots: Fields): Check {
  const source = useAnswerSource();
  const [check, setCheck] = useState<Check>({ status: "idle" });
  // The text, not the object: a draft is a new object on every render, and only a changed draft is checked again.
  const key = JSON.stringify(slots);
  useEffect(() => {
    const draft = JSON.parse(key) as Fields;
    const { runId, scriptSha } = props;
    if (source === null || scriptSha === undefined || Object.keys(draft).length === 0) return setCheck({ status: "idle" });
    let live = true;
    const timer = setTimeout(() => {
      setCheck({ status: "checking" });
      const args = { videoId, runId, scriptSha, beats: { [beatId]: { slots: draft } } };
      void source.call("videos.edit-check", args).then((envelope) => {
        if (!live) return;
        setCheck(envelope.ok ? { status: "checked", ...(envelope.data as ConsoleCommands["videos.edit-check"]["result"]) } : { status: "failed", error: envelope.error });
      });
    }, CHECK_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [source, videoId, props.runId, props.scriptSha, beatId, key]);
  return check;
}

const shown = (value: unknown): string => (value === undefined ? "(not set)" : JSON.stringify(value, null, 1).replace(/\n\s*/g, " "));

function DiffView({ diff }: { diff: Verdict["diff"] }): ReactNode {
  if (diff.length === 0) return null;
  return (
    <VStack gap={2} className="w-full min-w-0" testID="beat-editor-diff">
      <Typography variant="subtitle2">Before and after</Typography>
      {diff.map((change) => (
        <VStack key={change.path} gap={1} className="w-full min-w-0 rounded border border-divider p-2" testID={`beat-editor-diff-${change.path}`}>
          <Typography variant="caption" color="secondary">{change.path}</Typography>
          <Typography variant="body2" className="break-words line-through opacity-70">{shown(change.before)}</Typography>
          <Typography variant="body2" className="break-words">{shown(change.after)}</Typography>
        </VStack>
      ))}
    </VStack>
  );
}

function CheckStatus({ check, general }: { check: Check; general: readonly string[] }): ReactNode {
  if (check.status === "idle") return null;
  if (check.status === "checking") return <Typography variant="caption" color="secondary">Checking the draft…</Typography>;
  if (check.status === "failed") return <Alert status="warning" message={`The draft could not be checked: ${check.error}`} />;
  return (
    <VStack gap={1} testID="beat-editor-check">
      {check.gaps.map((gap) => <Typography key={gap} variant="caption" color="secondary">{gap}</Typography>)}
      {check.verdict?.ok ? <Typography variant="caption" color="success">The draft checks out.</Typography> : null}
      {general.map((problem) => <Alert key={problem} status="warning" message={problem} />)}
    </VStack>
  );
}

interface EditorProps {
  videoId: string;
  props: BeatProps;
  beat: Beat;
  onClose: () => void;
}

/** One template beat's slots as a form over the paused still. Save is shown, and stays off until explainer says a render reads edits. */
function TheaterBeatEditor({ videoId, props, beat, onClose }: EditorProps): ReactNode {
  const [draft, setDraft] = useState<Fields>(beat.value);
  const control = useMemo(() => controlOf(beat.schema), [beat.schema]);
  const changed = changedFields(beat.value, draft);
  const check = useEditCheck(videoId, props, beat.id, changed);
  const placed = placeProblems(check.status === "checked" ? (check.verdict?.problems ?? []) : [], beat.id);
  return (
    <Card className="w-full min-w-0 max-w-3xl" testID="beat-editor">
      <CardContent>
        <VStack gap={3} className="w-full min-w-0">
          <HStack gap={2} align="center" wrap className="max-w-full">
            <Heading level={4} className="max-w-full break-words">{`Beat ${beat.id} · ${beat.spec}`}</Heading>
            <Typography variant="caption" color="secondary">{`${formatAt(beat.startS)}–${formatAt(beat.endS)}, still at ${formatAt(beat.stillS)}`}</Typography>
          </HStack>
          {control.kind === "object" ? (
            <SlotForm fields={control.fields} value={draft} onChange={setDraft} locked={beat.locked} taken={idsIn(draft)} problems={placed.byPath} />
          ) : (
            <Alert status="warning" message="This beat's slot schema is not an object, so it has no form." />
          )}
          <CheckStatus check={check} general={placed.general} />
          {check.status === "checked" && check.verdict ? <DiffView diff={check.verdict.diff} /> : null}
          <SaveRow saveBack={props.saveBack} onClose={onClose} />
        </VStack>
      </CardContent>
    </Card>
  );
}

function SaveRow({ saveBack, onClose }: { saveBack: BeatProps["saveBack"]; onClose: () => void }): ReactNode {
  return (
    <VStack gap={1} className="w-full min-w-0">
      <HStack gap={2} wrap className="max-w-full">
        <Button isDisabled className="max-w-full" testID="beat-editor-save">
          <ButtonText>Save</ButtonText>
        </Button>
        <Button variant="outline" onPress={onClose} className="max-w-full" testID="beat-editor-close">
          <ButtonText>Close</ButtonText>
        </Button>
      </HStack>
      <Typography variant="caption" color="secondary" testID="beat-editor-save-reason">
        {saveBack.enabled ? "Saving arrives with the next console release." : `Save is off: ${saveBack.reason ?? "explainer gave no reason"}`}
      </Typography>
    </VStack>
  );
}

/** The playhead while the video is paused, null while it plays; a seek while paused moves it. */
function usePausedAt(ref: RefObject<HTMLVideoElement | null>): number | null {
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const follow = (): void => setPausedAt(element.paused ? element.currentTime : null);
    const events = ["pause", "play", "seeked", "loadedmetadata"] as const;
    follow();
    events.forEach((event) => element.addEventListener(event, follow));
    return () => events.forEach((event) => element.removeEventListener(event, follow));
  }, [ref]);
  return pausedAt;
}

interface EntryProps {
  videoId: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  seek: (seconds: number) => void;
  read: { props: BeatProps | null; gaps: readonly string[] } | undefined;
  /** `?edit=1` with `?t=`: open the beat under that time once the props arrive. */
  openAt: number | null;
}

/** "Edit this beat" on a paused explainer render; opening a beat seeks the player to its still. */
export function BeatEditEntry({ videoId, videoRef, seek, read, openAt }: EntryProps): ReactNode {
  const pausedAt = usePausedAt(videoRef);
  const [open, setOpen] = useState<Beat | null>(null);
  const opened = useRef(false);
  const props = read?.props ?? null;
  const edit = (beat: Beat): void => {
    setOpen(beat);
    seek(beat.stillS);
  };
  useEffect(() => {
    const beat = props === null || openAt === null || opened.current ? null : beatAt(props.beats, openAt);
    if (beat === null) return;
    opened.current = true;
    edit(beat);
  });
  const under = props === null || pausedAt === null ? null : beatAt(props.beats, pausedAt);
  return (
    <VStack gap={2} className="w-full min-w-0 max-w-3xl">
      {(read?.gaps ?? []).map((gap) => <Typography key={gap} variant="caption" color="secondary" testID="beat-editor-gap">{`Beat editor: ${gap}`}</Typography>)}
      {open !== null && props !== null ? <TheaterBeatEditor key={open.id} videoId={videoId} props={props} beat={open} onClose={() => setOpen(null)} /> : null}
      {open === null && under !== null ? (
        <Button variant="outline" onPress={() => edit(under)} className="max-w-full self-start" testID="theater-edit-beat">
          <ButtonText>{`Edit this beat (${under.id})`}</ButtonText>
        </Button>
      ) : null}
    </VStack>
  );
}
