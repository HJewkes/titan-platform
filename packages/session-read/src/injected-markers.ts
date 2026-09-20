/**
 * The blocks the harness injects into a `user` record. Two consumers share this
 * list: the wake-cause rules label an arriving record by it, and TP-108 strips
 * the same blocks out of indexed user text.
 */

export type InjectedMarkerName =
  | "channel"
  | "task_notification"
  | "system_reminder"
  | "local_command"
  | "compaction_summary"
  | "image_meta"
  | "loop_wakeup"
  | "spawn_brief";

export interface InjectedMarker {
  readonly name: InjectedMarkerName;
  /** Matched against the head of the record text. */
  readonly open: RegExp;
  /** Closing tag, when the marker opens a block that can be cut out whole. */
  readonly close: string | null;
  /** True when the marker only counts at the very start of the text. */
  readonly anchored: boolean;
}

/** cf_extract.py scans this far into a record for an injected tag; keep its window. */
export const MARKER_SCAN_CHARS = 400;

export const INJECTED_MARKERS: Readonly<Record<InjectedMarkerName, InjectedMarker>> = {
  channel: { name: "channel", open: /<channel\s+source="/, close: "</channel>", anchored: false },
  task_notification: { name: "task_notification", open: /<task-notification>/, close: "</task-notification>", anchored: false },
  system_reminder: { name: "system_reminder", open: /<system-reminder>/, close: "</system-reminder>", anchored: false },
  local_command: { name: "local_command", open: /^<local-command/, close: null, anchored: true },
  compaction_summary: { name: "compaction_summary", open: /^This session is being continued from a previous conversation/, close: null, anchored: true },
  image_meta: { name: "image_meta", open: /^\[Image:/, close: null, anchored: true },
  loop_wakeup: { name: "loop_wakeup", open: /^\[\d+ prior \/loop wakeup/, close: null, anchored: true },
  spawn_brief: { name: "spawn_brief", open: /Injected automatically by `agent_spawn`/, close: null, anchored: false },
};

export function hasMarker(text: string, name: InjectedMarkerName): boolean {
  const marker = INJECTED_MARKERS[name];
  const head = text.trimStart().slice(0, MARKER_SCAN_CHARS);
  return marker.open.test(head);
}

/** The first marker present in the head of `text`, in declaration order. */
export function findInjectedMarker(text: string): InjectedMarkerName | null {
  for (const name of Object.keys(INJECTED_MARKERS) as InjectedMarkerName[]) {
    if (hasMarker(text, name)) return name;
  }
  return null;
}

export interface ChannelTag {
  readonly source: string;
  readonly from: string | null;
  readonly msgId: string | null;
  readonly isSystem: boolean;
}

const CHANNEL_TAG = /<channel\s+source="([^"]+)"([^>]*)>/;
const ATTRIBUTE = (name: string) => new RegExp(`\\b${name}="([^"]*)"`);

export function parseChannelTag(text: string): ChannelTag | null {
  const head = text.trimStart().slice(0, MARKER_SCAN_CHARS);
  const tag = CHANNEL_TAG.exec(head);
  if (!tag) return null;
  const attributes = tag[2] ?? "";
  return {
    source: tag[1] ?? "",
    from: ATTRIBUTE("from").exec(attributes)?.[1] || null,
    msgId: ATTRIBUTE("msg_id").exec(attributes)?.[1] || null,
    isSystem: ATTRIBUTE("system").exec(attributes)?.[1] === "true",
  };
}
