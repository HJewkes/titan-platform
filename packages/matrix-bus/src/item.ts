export const ITEM_KEY = "io.titan.item";
export const ITEM_VERSION = 1;

export const ITEM_KINDS = ["approval_request", "endorse_request", "question", "notice", "message"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** The structured record carried inside an item's m.room.message content. */
export interface TitanItem {
  v: 1;
  kind: ItemKind;
  machine: string;
  session: string;
  agent_id?: string;
  msg_id: string;
  at: number;
  tool_name?: string;
  input_preview?: string;
  recipient?: string;
  truncated: boolean;
  redacted: boolean;
}

/** An item plus the free text it shows; the text travels in `body` only. */
export interface ItemInput extends Omit<TitanItem, "v"> {
  text?: string;
}

// A type alias, not an interface, so it stays assignable to Record<string, unknown> for send().
export type ItemContent = {
  msgtype: "m.text";
  body: string;
  format?: "org.matrix.custom.html";
  formatted_body?: string;
  [ITEM_KEY]: TitanItem;
};

const LABELS: Record<ItemKind, string> = {
  approval_request: "APPR",
  endorse_request: "ENDORSE",
  question: "QUESTION",
  notice: "NOTICE",
  message: "MSG",
};

const PROMPTS: Record<ItemKind, string> = {
  approval_request: "react ✅ allow, ❌ deny",
  endorse_request: "react ✅ approve, ❌ dismiss",
  question: "reply to answer, or reply dismiss",
  notice: "react ✅ or ❌ to dismiss",
  message: "react ✅ or ❌ to dismiss",
};

export const TRUNCATED_LINE = "too large to approve from the phone; answer at the terminal";
export const REDACTED_LINE = "secrets redacted; answer at the terminal";

function headline(item: ItemInput): string {
  const to = item.recipient ? ` to ${item.recipient}` : "";
  return `${LABELS[item.kind]} from ${item.session} (${item.machine})${to}`;
}

function detail(item: ItemInput): string {
  if (item.kind === "approval_request") return `${item.tool_name ?? "tool"}: ${item.input_preview ?? ""}`;
  return item.text ?? "";
}

function footer(item: ItemInput): string {
  if (item.truncated) return TRUNCATED_LINE;
  if (item.redacted) return REDACTED_LINE;
  return PROMPTS[item.kind];
}

export function renderItemBody(item: ItemInput): string {
  return `${headline(item)}\n${detail(item)}\n\n${footer(item)}`;
}

function recordOf(item: ItemInput): TitanItem {
  const fields = Object.entries(item).filter(([key, value]) => key !== "text" && value !== undefined);
  return { v: ITEM_VERSION, ...Object.fromEntries(fields) } as TitanItem;
}

export function encodeItem(item: ItemInput, formattedBody?: string): ItemContent {
  const content: ItemContent = { msgtype: "m.text", body: renderItemBody(item), [ITEM_KEY]: recordOf(item) };
  if (formattedBody === undefined) return content;
  return { ...content, format: "org.matrix.custom.html", formatted_body: formattedBody };
}

const REQUIRED_STRINGS = ["machine", "session", "msg_id"] as const;
const OPTIONAL_STRINGS = ["agent_id", "tool_name", "input_preview", "recipient"] as const;

function isItem(value: Record<string, unknown>): boolean {
  if (value.v !== ITEM_VERSION || !ITEM_KINDS.includes(value.kind as ItemKind)) return false;
  if (!REQUIRED_STRINGS.every((key) => typeof value[key] === "string")) return false;
  if (!OPTIONAL_STRINGS.every((key) => value[key] === undefined || typeof value[key] === "string")) return false;
  return typeof value.at === "number" && typeof value.truncated === "boolean" && typeof value.redacted === "boolean";
}

/** Returns null for content without the key, an unknown version, or a malformed record. */
export function decodeItem(content: Record<string, unknown>): TitanItem | null {
  const value = content[ITEM_KEY];
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!isItem(record)) return null;
  const pick = (keys: readonly string[]) => keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]);
  const base = ["v", "kind", ...REQUIRED_STRINGS, "at", "truncated", "redacted"];
  return Object.fromEntries([...pick(base), ...pick(OPTIONAL_STRINGS)]) as TitanItem;
}
