import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Alert, Button, ButtonText, Card, CardContent, HStack, Heading, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useInvalidate } from "../data/rpc.js";
import { useAnswerSource } from "../data/submit.js";
import { SlotForm } from "./SlotForm.js";
import { formatAt } from "./TheaterComment.js";
import { TheaterEdits } from "./TheaterEdits.js";
import { beatAt, changedFields, controlOf, idsIn, placeProblems, type Fields } from "./slot-form.js";

type BeatProps = NonNullable<ConsoleCommands["videos.props"]["result"]["props"]>;
type Beat = BeatProps["beats"][number];
type Verdict = NonNullable<ConsoleCommands["videos.edit-check"]["result"]["verdict"]>;
type Check = { status: "idle" } | { status: "checking" } | { status: "checked"; verdict: Verdict | null; gaps: readonly string[] } | { status: "failed"; error: string };

/** Long enough that a word typed on a phone keyboard is one check, short enough that the verdict follows the typing. */
const CHECK_DEBOUNCE_MS = 400;

type CheckRead = ConsoleCommands["videos.edit-check"]["result"];
type SaveRead = ConsoleCommands["videos.edit"]["result"];
/** Each edited beat's changed slot fields, as one `explainer.slot-edit/v1` carries them. */
type Batch = Record<string, { slots: Fields }>;
type Save = { status: "idle" | "sending" } | { status: "saved"; editId: string } | { status: "refused"; problems: readonly string[] };

/** The server parses its own result, so the shape is only confirmed here, not re-validated. */
function isCheckRead(data: unknown): data is CheckRead {
  return typeof data === "object" && data !== null && "verdict" in data && "gaps" in data && Array.isArray(data.gaps);
}

function isSaveRead(data: unknown): data is SaveRead {
  return typeof data === "object" && data !== null && "saved" in data && "problems" in data && Array.isArray(data.problems);
}

/** The whole draft, every edited beat, through `videos.edit-check` once typing pauses; nothing is sent while it equals the render. */
function useEditCheck(videoId: string, props: BeatProps, batch: Batch): Check {
  const source = useAnswerSource();
  const [check, setCheck] = useState<Check>({ status: "idle" });
  // Keyed by the text, not the object: a draft is a new object on every render, and only a changed draft is checked again.
  const key = JSON.stringify(batch);
  const latest = useRef(batch);
  latest.current = batch;
  useEffect(() => {
    const draft = latest.current;
    const { runId, scriptSha } = props;
    if (source === null || scriptSha === undefined || Object.keys(draft).length === 0) return setCheck({ status: "idle" });
    let live = true;
    const timer = setTimeout(() => {
      setCheck({ status: "checking" });
      const args = { videoId, runId, scriptSha, beats: draft };
      void source.call("videos.edit-check", args).then((envelope) => {
        if (!live) return;
        if (!envelope.ok) return setCheck({ status: "failed", error: envelope.error });
        setCheck(isCheckRead(envelope.data) ? { status: "checked", ...envelope.data } : { status: "failed", error: "videos.edit-check answered an unexpected shape" });
      });
    }, CHECK_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [source, videoId, props.runId, props.scriptSha, key]);
  return check;
}

/** One Save sends the whole draft as one `videos.edit`, so edits to several beats make one script and one run (Q-O1). */
function useSaveEdit(videoId: string, props: BeatProps, onSaved: () => void) {
  const source = useAnswerSource();
  const invalidate = useInvalidate();
  const [save, setSave] = useState<Save>({ status: "idle" });
  const send = useCallback(
    async (beats: Batch, fromNote: string | undefined) => {
      if (source === null || props.scriptSha === undefined) return;
      setSave({ status: "sending" });
      const args = { videoId, runId: props.runId, scriptSha: props.scriptSha, beats, ...(fromNote === undefined ? {} : { fromNote }) };
      const envelope = await source.call("videos.edit", args);
      if (!envelope.ok) return setSave({ status: "refused", problems: [envelope.error] });
      if (!isSaveRead(envelope.data)) return setSave({ status: "refused", problems: ["videos.edit answered an unexpected shape"] });
      const { saved, problems, gaps } = envelope.data;
      if (saved === null) return setSave({ status: "refused", problems: [...problems, ...gaps] });
      setSave({ status: "saved", editId: saved.editId });
      invalidate(["videos.edits"]);
      onSaved();
    },
    [source, videoId, props.runId, props.scriptSha, invalidate, onSaved],
  );
  return { available: source !== null && props.scriptSha !== undefined, save, send };
}

const shown = (value: unknown): string => (value === undefined ? "(not set)" : JSON.stringify(value, null, 1).replace(/\n\s*/g, " "));

function DiffView({ diff }: { diff: Verdict["diff"] }): ReactNode {
  if (diff.length === 0) return null;
  return (
    <VStack gap={2} className="w-full min-w-0" testID="beat-editor-diff">
      <Typography variant="subtitle2">Before and after</Typography>
      {diff.map((change) => (
        <VStack key={`${change.beat}:${change.path}`} gap={1} className="w-full min-w-0 rounded border border-divider p-2" testID={`beat-editor-diff-${change.path}`}>
          <Typography variant="caption" color="secondary">{`${change.beat} · ${change.path}`}</Typography>
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
  draft: Draft;
  onDraft: (beatId: string, value: Fields) => void;
  onSaved: () => void;
  onClose: () => void;
}

/** One template beat's slots as a form over the paused still; the draft keeps every beat edited, and Save sends them all. */
function TheaterBeatEditor({ videoId, props, beat, draft, onDraft, onSaved, onClose }: EditorProps): ReactNode {
  const value = draft.values[beat.id] ?? beat.value;
  const control = useMemo(() => controlOf(beat.schema), [beat.schema]);
  const batch = batchOf(props.beats, draft);
  const check = useEditCheck(videoId, props, batch);
  const placed = placeProblems(check.status === "checked" ? (check.verdict?.problems ?? []) : [], beat.id);
  return (
    <Card className="w-full min-w-0 max-w-3xl" testID="beat-editor">
      <CardContent>
        <VStack gap={3} className="w-full min-w-0">
          <HStack gap={2} align="center" wrap className="max-w-full">
            <Heading level={4} className="max-w-full break-words">{`Beat ${beat.id} · ${beat.spec}`}</Heading>
            <Typography variant="caption" color="secondary">{`${formatAt(beat.startS)}–${formatAt(beat.endS)}, still at ${formatAt(beat.stillS)}`}</Typography>
          </HStack>
          {draft.fromNote === undefined ? null : <Typography variant="caption" color="secondary" testID="beat-editor-from-note">{`This draft cites the note at ${formatAt(draft.fromNote.atS)}`}</Typography>}
          {control.kind === "object" ? (
            <SlotForm fields={control.fields} value={value} onChange={(next) => onDraft(beat.id, next)} locked={beat.locked} taken={idsIn(value)} problems={placed.byPath} />
          ) : (
            <Alert status="warning" message="This beat's slot schema is not an object, so it has no form." />
          )}
          <CheckStatus check={check} general={placed.general} />
          {check.status === "checked" && check.verdict ? <DiffView diff={check.verdict.diff} /> : null}
          <SaveRow videoId={videoId} props={props} batch={batch} fromNote={draft.fromNote?.id} refused={check.status === "checked" && check.verdict?.ok === false} onSaved={onSaved} onClose={onClose} />
        </VStack>
      </CardContent>
    </Card>
  );
}

interface SaveRowProps {
  videoId: string;
  props: BeatProps;
  batch: Batch;
  fromNote: string | undefined;
  /** The latest check found problems, which `edit apply` would refuse too. */
  refused: boolean;
  onSaved: () => void;
  onClose: () => void;
}

function saveCaption(saveBack: BeatProps["saveBack"], beats: number): string {
  if (!saveBack.enabled) return `Save is off: ${saveBack.reason ?? "explainer gave no reason"}`;
  if (beats === 0) return "Change a field to start a draft. Edits to several beats save together as one render.";
  return `${beats} beat${beats === 1 ? "" : "s"} in this draft render together as one run.`;
}

function SaveRow({ videoId, props, batch, fromNote, refused, onSaved, onClose }: SaveRowProps): ReactNode {
  const { available, save, send } = useSaveEdit(videoId, props, onSaved);
  const beats = Object.keys(batch).length;
  const enabled = props.saveBack.enabled && available && beats > 0 && !refused && save.status !== "sending";
  return (
    <VStack gap={1} className="w-full min-w-0">
      <HStack gap={2} wrap className="max-w-full">
        <Button isDisabled={!enabled} onPress={() => void send(batch, fromNote)} className="max-w-full" testID="beat-editor-save">
          <ButtonText>{save.status === "sending" ? "Saving" : "Save and render"}</ButtonText>
        </Button>
        <Button variant="outline" onPress={onClose} className="max-w-full" testID="beat-editor-close">
          <ButtonText>Close</ButtonText>
        </Button>
      </HStack>
      <Typography variant="caption" color="secondary" testID="beat-editor-save-reason">{saveCaption(props.saveBack, beats)}</Typography>
      {save.status === "saved" ? <Typography variant="caption" color="success" testID="beat-editor-saved">{`Saved as ${save.editId}; its run is starting.`}</Typography> : null}
      {save.status === "refused" ? save.problems.map((problem) => <Alert key={problem} status="warning" message={problem} testID="beat-editor-save-refused" />) : null}
    </VStack>
  );
}

/** The draft over one render: each edited beat's whole slot value, and the note it was turned from, if any. */
interface Draft {
  values: Record<string, Fields>;
  fromNote?: { id: string; atS: number };
}

const EMPTY_DRAFT: Draft = { values: {} };

/** Only the fields that differ from the render go into the edit, and a beat with none is left out. */
function batchOf(beats: readonly Beat[], draft: Draft): Batch {
  const changed = beats.map((beat) => [beat.id, changedFields(beat.value, draft.values[beat.id] ?? beat.value)] as const);
  return Object.fromEntries(changed.filter(([, slots]) => Object.keys(slots).length > 0).map(([id, slots]) => [id, { slots }]));
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

/** A theater note the owner turned into an edit; `seq` tells a second press on the same note from the first. */
export interface NoteEditRequest {
  noteId: string;
  atS: number;
  seq: number;
}

interface EntryProps {
  videoId: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  seek: (seconds: number) => void;
  read: { props: BeatProps | null; gaps: readonly string[] } | undefined;
  /** `?edit=1` with `?t=`: open the beat under that time once the props arrive. */
  openAt: number | null;
  /** "Turn into edit" on a note: open the beat under the note's time, and cite the note in the draft. */
  fromNote: NoteEditRequest | null;
}

/** The beat to open, once, for the `?edit=1` link and for each "Turn into edit" press. */
function useOpenRequests(props: BeatProps | null, openAt: number | null, fromNote: NoteEditRequest | null, open: (beat: Beat, note?: NoteEditRequest) => void): void {
  const handled = useRef<{ link: boolean; seq: number | null }>({ link: false, seq: null });
  useEffect(() => {
    if (props === null) return;
    if (fromNote !== null && handled.current.seq !== fromNote.seq) {
      handled.current.seq = fromNote.seq;
      const beat = beatAt(props.beats, fromNote.atS);
      if (beat !== null) open(beat, fromNote);
      return;
    }
    const beat = openAt === null || handled.current.link ? null : beatAt(props.beats, openAt);
    if (beat === null) return;
    handled.current.link = true;
    open(beat);
  });
}

/** "Edit this beat" on a paused explainer render; opening a beat seeks the player to its still. The draft outlives switching beats. */
export function BeatEditEntry({ videoId, videoRef, seek, read, openAt, fromNote }: EntryProps): ReactNode {
  const pausedAt = usePausedAt(videoRef);
  const [open, setOpen] = useState<Beat | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const props = read?.props ?? null;
  const edit = (beat: Beat, note?: NoteEditRequest): void => {
    setOpen(beat);
    if (note !== undefined) setDraft((current) => ({ ...current, fromNote: { id: note.noteId, atS: note.atS } }));
    seek(beat.stillS);
  };
  useOpenRequests(props, openAt, fromNote, edit);
  const onDraft = (beatId: string, value: Fields): void => setDraft((current) => ({ ...current, values: { ...current.values, [beatId]: value } }));
  const onSaved = useCallback(() => setDraft(EMPTY_DRAFT), []);
  const under = props === null || pausedAt === null ? null : beatAt(props.beats, pausedAt);
  return (
    <VStack gap={2} className="w-full min-w-0 max-w-3xl">
      {(read?.gaps ?? []).map((gap) => <Typography key={gap} variant="caption" color="secondary" testID="beat-editor-gap">{`Beat editor: ${gap}`}</Typography>)}
      {open !== null && props !== null ? (
        <TheaterBeatEditor key={open.id} videoId={videoId} props={props} beat={open} draft={draft} onDraft={onDraft} onSaved={onSaved} onClose={() => setOpen(null)} />
      ) : null}
      {open === null && under !== null ? (
        <Button variant="outline" onPress={() => edit(under)} className="max-w-full self-start" testID="theater-edit-beat">
          <ButtonText>{`Edit this beat (${under.id})`}</ButtonText>
        </Button>
      ) : null}
      {props === null ? null : <TheaterEdits videoId={videoId} />}
    </VStack>
  );
}
