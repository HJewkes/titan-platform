import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Alert, BreadcrumbItem, Breadcrumbs, Chip, EmptyState, HStack, Heading, Link, Pill, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { open } from "../router.js";
import { ScrubMarkers } from "./ScrubMarkers.js";
import { BeatEditEntry } from "./TheaterBeatEditor.js";
import { TheaterComment, formatAt, type NoteAbout } from "./TheaterComment.js";
import { VERDICT_LABELS, VideoBadges } from "./TheaterFeed.js";
import type { VideoRow } from "./theater-feed.js";

type Note = ConsoleCommands["videos.notes"]["result"]["notes"][number];
type Seek = (seconds: number) => void;
const NOTE_FILTERS = ["all", "content", "video"] as const;
type NoteFilter = (typeof NOTE_FILTERS)[number];

const ABOUT_PILLS: Record<NoteAbout, string> = { content: "Content", video: "Video" };

/** `HAVE_METADATA`: below it, Safari ignores a `currentTime` write. */
const HAVE_METADATA = 1;

/** `t=<seconds>` from a shared link; anything else opens at the start. */
export function startTimeOf(query: string | undefined): number | null {
  const raw = new URLSearchParams(query ?? "").get("t");
  if (raw === null || raw.trim() === "") return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** `edit=1` beside `t=`: open the beat editor on the beat under that time. */
export function editTimeOf(query: string | undefined): number | null {
  return new URLSearchParams(query ?? "").get("edit") === "1" ? startTimeOf(query) : null;
}

/** One video with its captions and the owner's notes; `?t=` opens it paused at that time, `&edit=1` with that beat open. */
export function TheaterPlayer({ id, query }: { id: string; query?: string | undefined }): ReactNode {
  const list = useQuery("videos.list");
  if (list.status === "loading") return <Spinner size="sm" label="Loading video" />;
  if (list.data === undefined) return <Framed title={id}><Alert status="error" message={`Could not load videos: ${list.error.message}`} /></Framed>;
  const video = list.data.videos.find((row) => row.id === id);
  if (video === undefined) return <Framed title={id}><Alert status="error" message="No video with this id is under the configured roots." /></Framed>;
  return <Player video={video} start={startTimeOf(query)} editAt={editTimeOf(query)} />;
}

function Player({ video, start, editAt }: { video: VideoRow; start: number | null; editAt: number | null }): ReactNode {
  const ref = useRef<HTMLVideoElement>(null);
  const seek = usePendingSeek(ref, start);
  const duration = useDuration(ref);
  const props = useQuery("videos.props", { videoId: video.id });
  const media = `/media/videos/${encodeURIComponent(video.id)}`;
  return (
    <Framed title={video.title}>
      <HStack gap={2} align="center" wrap>
        <Heading level={3}>{video.title}</Heading>
        <VideoBadges video={video} />
      </HStack>
      <video ref={ref} src={media} controls playsInline preload="metadata" className="block h-auto w-full max-w-3xl rounded bg-black" data-testid="theater-video">
        {video.captions ? <track kind="captions" src={`${media}/captions`} srcLang="en" label="Captions" default /> : null}
      </video>
      <NoteMarkers videoId={video.id} beats={props.data?.props?.beats ?? []} duration={duration} seek={seek} />
      <BeatEditEntry videoId={video.id} videoRef={ref} seek={seek} read={props.data} openAt={editAt} />
      <TheaterComment videoId={video.id} videoRef={ref} />
      <NotesList videoId={video.id} seek={seek} />
    </Framed>
  );
}

/**
 * iOS Safari drops a seek made before the metadata arrives, so a seek waits for `loadedmetadata`
 * when it comes early. The link's start time is the first such seek; nothing calls `play`.
 */
function usePendingSeek(ref: RefObject<HTMLVideoElement | null>, start: number | null): Seek {
  const pending = useRef<number | null>(start);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const apply = (): void => {
      if (pending.current === null) return;
      element.currentTime = pending.current;
      pending.current = null;
    };
    if (element.readyState >= HAVE_METADATA) apply();
    element.addEventListener("loadedmetadata", apply);
    return () => element.removeEventListener("loadedmetadata", apply);
  }, [ref]);
  return useCallback(
    (seconds: number) => {
      const element = ref.current;
      if (element === null) return;
      if (element.readyState >= HAVE_METADATA) element.currentTime = seconds;
      else pending.current = seconds;
    },
    [ref],
  );
}

function useDuration(ref: RefObject<HTMLVideoElement | null>): number {
  const [duration, setDuration] = useState(Number.NaN);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const read = (): void => setDuration(element.duration);
    read();
    element.addEventListener("durationchange", read);
    return () => element.removeEventListener("durationchange", read);
  }, [ref]);
  return duration;
}

function NoteMarkers({ videoId, beats, duration, seek }: { videoId: string; beats: readonly { id: string; startS: number }[]; duration: number; seek: Seek }): ReactNode {
  const notes = useQuery("videos.notes", { videoId });
  return <ScrubMarkers notes={notes.data?.notes ?? []} beats={beats} duration={duration} seek={seek} />;
}

function Framed({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <VStack gap={4}>
      <Breadcrumbs>
        <BreadcrumbItem onPress={() => open({ view: "theater" })}>Theater</BreadcrumbItem>
        <BreadcrumbItem isCurrentPage>{title}</BreadcrumbItem>
      </Breadcrumbs>
      {children}
    </VStack>
  );
}

const FILTER_LABELS: Record<NoteFilter, string> = { all: "All", content: "Content", video: "Video" };

/** A filter keeps verdicts in view, since a verdict is on the render as a whole rather than one kind of comment. */
function filterNotes(notes: readonly Note[], filter: NoteFilter): Note[] {
  return filter === "all" ? [...notes] : notes.filter((note) => note.kind !== "comment" || note.about === filter);
}

function NoteFilterChips({ filter, onFilter }: { filter: NoteFilter; onFilter: (filter: NoteFilter) => void }): ReactNode {
  return (
    <HStack gap={2} align="center" wrap>
      {NOTE_FILTERS.map((each) => (
        <Chip key={each} variant={filter === each ? "solid" : "subtle"} size="sm" onPress={() => onFilter(each)} accessibilityState={{ selected: filter === each }} testID={`theater-notes-filter-${each}`}>
          {FILTER_LABELS[each]}
        </Chip>
      ))}
    </HStack>
  );
}

function NotesList({ videoId, seek }: { videoId: string; seek: Seek }): ReactNode {
  const notes = useQuery("videos.notes", { videoId });
  const [filter, setFilter] = useState<NoteFilter>("all");
  if (notes.status === "loading") return <Spinner size="sm" label="Loading notes" />;
  if (notes.data === undefined) return <Alert status="error" message={`Could not load notes: ${notes.error.message}`} />;
  const sorted = filterNotes(notes.data.notes, filter).sort((a, b) => a.atS - b.atS);
  return (
    <VStack gap={2}>
      {notes.data.gaps.map((gap) => (
        <Alert key={gap} status="warning" message={gap} />
      ))}
      {notes.data.notes.length === 0 ? null : <NoteFilterChips filter={filter} onFilter={setFilter} />}
      {sorted.length === 0 ? <EmptyState title={filter === "all" ? "No notes on this video yet" : "No notes of this kind"} /> : sorted.map((note) => <NoteRow key={note.id} note={note} seek={seek} />)}
    </VStack>
  );
}

/** A note on an earlier render is kept for history but dimmed, since its time may no longer match the cut. */
function NoteRow({ note, seek }: { note: Note; seek: Seek }): ReactNode {
  return (
    <HStack gap={2} align="center" wrap className={note.current ? undefined : "opacity-60"} testID={`theater-note-${note.id}`}>
      <Link color="primary" onPress={() => seek(note.atS)}>
        {formatAt(note.atS)}
      </Link>
      {note.kind === "comment" ? (
        <>
          <Pill variant="outline" tone="neutral" size="xs" testID={`theater-about-${note.id}`}>
            {ABOUT_PILLS[note.about]}
          </Pill>
          <Typography variant="body2">{note.text}</Typography>
        </>
      ) : (
        <Pill variant="subtle" size="xs">
          {VERDICT_LABELS[note.verdict]}
        </Pill>
      )}
      {note.current ? null : (
        <Typography variant="caption" color="secondary">
          earlier render
        </Typography>
      )}
    </HStack>
  );
}
