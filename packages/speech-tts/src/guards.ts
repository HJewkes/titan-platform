import { isRecord } from "@titan-design/rpc-protocol/narrow";

export const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

export const isStringRecord = (v: unknown): v is Record<string, string> =>
  isRecord(v) && Object.values(v).every((s) => typeof s === "string");

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
