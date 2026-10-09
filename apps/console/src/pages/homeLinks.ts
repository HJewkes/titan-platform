import { refToRoute } from "../refs.js";
import { open } from "../router.js";

/** Where Home sends a queue row: agent-chat owns every answer, so the console only links to it. */
export const DEFAULT_QUEUE_URL = "http://127.0.0.1:7600/ui#queue";

export function openExternal(url: string): void {
  window.open(url, "_blank", "noopener");
}

/** react-ui's `Link` renders no anchor, so each row navigates on press instead. */
export function followRef(ref: string): void {
  const target = refToRoute(ref);
  if (target?.kind === "route") open(target.route);
  else if (target?.kind === "github") openExternal(target.url);
}

/** The broker's queue page, at whatever port the health probe reports for agent-chat. */
export function queueUrl(agentsTarget: string | undefined): string {
  return agentsTarget?.startsWith("http") ? `${agentsTarget.replace(/\/$/, "")}/ui#queue` : DEFAULT_QUEUE_URL;
}

export const isWebTarget = (target: string): boolean => /^https?:\/\//.test(target);
