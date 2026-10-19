import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Alert, Button, ButtonText, HStack, Input, VStack } from "@titan-design/react-ui";
import { useInvalidate } from "../data/rpc.js";
import { useAnswerSource } from "../data/submit.js";

type Verdict = "ship" | "needs-changes";
type NoteInput = { atS: number } & ({ kind: "comment"; text: string } | { kind: "verdict"; verdict: Verdict });
type VideoRef = RefObject<HTMLVideoElement | null>;

export function formatAt(seconds: number): string {
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * The time of the frame on screen. `currentTime` runs ahead of the presented frame while playing,
 * so the last frame callback's `mediaTime` wins; a seek forgets it until the next frame arrives,
 * and a browser without frame callbacks falls back to `currentTime`.
 */
function usePresentedTime(ref: VideoRef): () => number {
  const presented = useRef<number | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (element === null || !("requestVideoFrameCallback" in element)) return undefined;
    const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
      presented.current = metadata.mediaTime;
      handle = element.requestVideoFrameCallback(onFrame);
    };
    const forget = (): void => void (presented.current = null);
    let handle = element.requestVideoFrameCallback(onFrame);
    element.addEventListener("seeking", forget);
    return () => {
      element.cancelVideoFrameCallback(handle);
      element.removeEventListener("seeking", forget);
    };
  }, [ref]);
  return useCallback(() => presented.current ?? ref.current?.currentTime ?? 0, [ref]);
}

/** The playhead for the button's label, following `timeupdate` and seeks. */
function usePlayhead(ref: VideoRef): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const follow = (): void => setSeconds(element.currentTime);
    element.addEventListener("timeupdate", follow);
    element.addEventListener("seeked", follow);
    return () => {
      element.removeEventListener("timeupdate", follow);
      element.removeEventListener("seeked", follow);
    };
  }, [ref]);
  return seconds;
}

/** Sends one `videos.note`; resolves to the server's refusal verbatim, or null once the notes are read again. */
function useSendNote(videoId: string): { available: boolean; send: (input: NoteInput) => Promise<string | null> } {
  const source = useAnswerSource();
  const invalidate = useInvalidate();
  const send = useCallback(
    async (input: NoteInput) => {
      if (source === null) return null;
      const envelope = await source.call("videos.note", { videoId, ...input });
      if (!envelope.ok) return envelope.error;
      invalidate(["videos.notes", "videos.list"]);
      return null;
    },
    [source, videoId, invalidate],
  );
  return { available: source !== null, send };
}

/** The bar's draft and send state. The pause comes before the time is read, so the stamp is the frame the owner stopped on. */
function useNoteBar(videoId: string, videoRef: VideoRef) {
  const { available, send } = useSendNote(videoId);
  const frameTime = usePresentedTime(videoRef);
  const [draftAt, setDraftAt] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deliver = async (input: NoteInput): Promise<boolean> => {
    setSending(true);
    const refused = await send(input);
    setSending(false);
    setError(refused);
    return refused === null;
  };
  const startComment = (): void => {
    videoRef.current?.pause();
    setDraftAt(frameTime());
  };
  const submitComment = async (atS: number): Promise<void> => {
    if (!(await deliver({ kind: "comment", atS, text }))) return;
    setDraftAt(null);
    setText("");
  };
  const markVerdict = (verdict: Verdict): void => void deliver({ kind: "verdict", atS: frameTime(), verdict });
  return { available, draftAt, setDraftAt, text, setText, sending, error, startComment, submitComment, markVerdict };
}

/** Pause-to-comment and the verdict buttons; a fixed bar along the bottom of a phone, inline on a wider screen. */
export function TheaterComment({ videoId, videoRef }: { videoId: string; videoRef: VideoRef }): ReactNode {
  const { available, draftAt, setDraftAt, text, setText, sending, error, startComment, submitComment, markVerdict } = useNoteBar(videoId, videoRef);
  const playhead = usePlayhead(videoRef);
  if (!available) return null;
  return (
    <>
      <div aria-hidden className="h-32 md:hidden" />
      <VStack gap={2} className="fixed inset-x-0 bottom-0 z-10 border-t border-divider bg-surface-base p-3 md:static md:max-w-3xl md:border-0 md:p-0" testID="theater-comment-bar">
        {error === null ? null : <Alert status="warning" message={error} testID="theater-comment-error" />}
        {draftAt === null ? null : <Draft atS={draftAt} text={text} onText={setText} sending={sending} onSend={() => void submitComment(draftAt)} onCancel={() => setDraftAt(null)} />}
        <HStack gap={2} wrap>
          <Button onPress={startComment} isDisabled={sending || draftAt !== null} testID="theater-comment-start">
            <ButtonText>{`Comment at ${formatAt(playhead)}`}</ButtonText>
          </Button>
          <Button color="success" variant="outline" onPress={() => markVerdict("ship")} isDisabled={sending} testID="theater-verdict-ship">
            <ButtonText>Ship</ButtonText>
          </Button>
          <Button color="warning" variant="outline" onPress={() => markVerdict("needs-changes")} isDisabled={sending} testID="theater-verdict-needs-changes">
            <ButtonText>Needs changes</ButtonText>
          </Button>
        </HStack>
      </VStack>
    </>
  );
}

interface DraftProps {
  atS: number;
  text: string;
  onText: (text: string) => void;
  sending: boolean;
  onSend: () => void;
  onCancel: () => void;
}

function Draft({ atS, text, onText, sending, onSend, onCancel }: DraftProps): ReactNode {
  return (
    <VStack gap={2}>
      <Input multiline numberOfLines={3} autoFocus label={`Comment at ${formatAt(atS)}`} accessibilityLabel="Comment text" value={text} onChangeText={onText} testID="theater-comment-text" />
      <HStack gap={2}>
        <Button onPress={onSend} isDisabled={sending || text.trim() === ""} testID="theater-comment-send">
          <ButtonText>{sending ? "Sending" : "Send"}</ButtonText>
        </Button>
        <Button variant="outline" onPress={onCancel} isDisabled={sending} testID="theater-comment-cancel">
          <ButtonText>Cancel</ButtonText>
        </Button>
      </HStack>
    </VStack>
  );
}
