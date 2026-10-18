import { useCallback, useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Alert, BreadcrumbItem, Breadcrumbs, EmptyState, HStack, Heading, Link, Pill, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { open } from "../router.js";
import { VERDICT_LABELS, VideoBadges, type VideoRow } from "./TheaterPage.js";

type Note = ConsoleCommands["videos.notes"]["result"]["notes"][number];
type Seek = (seconds: number) => void;

/** `HAVE_METADATA`: below it, Safari ignores a `currentTime` write. */
const HAVE_METADATA = 1;

/** `t=<seconds>` from a shared link; anything else opens at the start. */
export function startTimeOf(query: string | undefined): number | null {
  const raw = new URLSearchParams(query ?? "").get("t");
  if (raw === null || raw.trim() === "") return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function formatAt(seconds: number): string {
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

/** One video with its captions and the owner's notes; `?t=` opens it paused at that time. */
export function TheaterPlayer({ id, query }: { id: string; query?: string | undefined }): ReactNode {
  const list = useQuery("videos.list");
  if (list.status === "loading") return <Spinner size="sm" label="Loading video" />;
  if (list.data === undefined) return <Framed title={id}><Alert status="error" message={`Could not load videos: ${list.error.message}`} /></Framed>;
  const video = list.data.videos.find((row) => row.id === id);
  if (video === undefined) return <Framed title={id}><Alert status="error" message="No video with this id is under the configured roots." /></Framed>;
  return <Player video={video} start={startTimeOf(query)} />;
}

function Player({ video, start }: { video: VideoRow; start: number | null }): ReactNode {
  const ref = useRef<HTMLVideoElement>(null);
  const seek = usePendingSeek(ref, start);
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

function NotesList({ videoId, seek }: { videoId: string; seek: Seek }): ReactNode {
  const notes = useQuery("videos.notes", { videoId });
  if (notes.status === "loading") return <Spinner size="sm" label="Loading notes" />;
  if (notes.data === undefined) return <Alert status="error" message={`Could not load notes: ${notes.error.message}`} />;
  const sorted = [...notes.data.notes].sort((a, b) => a.atS - b.atS);
  return (
    <VStack gap={2}>
      {notes.data.gaps.map((gap) => (
        <Alert key={gap} status="warning" message={gap} />
      ))}
      {sorted.length === 0 ? <EmptyState title="No notes on this video yet" /> : sorted.map((note) => <NoteRow key={note.id} note={note} seek={seek} />)}
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
      {note.kind === "comment" ? <Typography variant="body2">{note.text}</Typography> : <Pill variant="subtle" size="xs">{VERDICT_LABELS[note.verdict]}</Pill>}
      {note.current ? null : (
        <Typography variant="caption" color="secondary">
          earlier render
        </Typography>
      )}
    </HStack>
  );
}
