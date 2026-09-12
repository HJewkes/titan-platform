import { readLocatorText } from "@titan-design/locator";
import { toAbsolutePath } from "./discover.js";
import type { SpanField } from "./events.js";
import { asObject, searchText } from "./text.js";

export interface SessionTextRequest {
  path: string;
  byteOffset: number;
  byteLength: number;
  field: SpanField;
}

/** Legacy Claude read-back through the same field projection used at ingest time. */
export async function readSessionText(request: SessionTextRequest): Promise<string | null> {
  try {
    const line = await readLocatorText(toAbsolutePath(request.path), [0, request.byteOffset, request.byteLength]);
    const parsed = asObject(JSON.parse(line));
    if (!parsed) return null;
    return searchText(asObject(parsed.message), request.field);
  } catch {
    return null;
  }
}
