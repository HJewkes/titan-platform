import { ITEM_KEY, renderItemBody, type TitanItem } from "@titan-design/matrix-bus";

function headline(record: TitanItem): string {
  return renderItemBody({ ...record, text: undefined }).split("\n")[0] ?? "";
}

/** An m.replace edit of an item: a short headline and status body, with the original record in m.new_content. */
export function encodeEdit(targetEventId: string, record: TitanItem, status: string): Record<string, unknown> {
  const body = `${headline(record)}\n${status}`;
  return {
    msgtype: "m.text",
    body: `* ${body}`,
    "m.new_content": { msgtype: "m.text", body, [ITEM_KEY]: record },
    "m.relates_to": { rel_type: "m.replace", event_id: targetEventId },
  };
}
