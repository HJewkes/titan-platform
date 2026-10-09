import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { openDatabase, type Db } from "@titan-design/store-sqlite";
import type { MetricQuery, StoreInventory, StoreRef } from "./schemas.js";

const run = promisify(execFile);
const PROBE_TIMEOUT_MS = 30_000;
const MAX_LOG_CLASSES = 40;
const MAX_JSON_ROWS = 20_000;
const ISO_DATE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

const expandHome = (path: string): string => (path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path);

function required(value: string | undefined, store: StoreRef, field: string): string {
  if (!value) throw new Error(`store ${store.id} (${store.kind}) has no ${field}`);
  return field === "path" ? expandHome(value) : value;
}

/** `mode=ro` in effect: the connection cannot write, whatever the query says. */
function withReadOnly<T>(store: StoreRef, fn: (db: Db) => T): T {
  const db = openDatabase(required(store.path, store, "path"), { readonly: true, foreignKeys: false });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** `ci-wait:0:1` and `ci-wait:2` are one family: the suffixes are rounds and iterations, not kinds. */
function jsonKeyFamilies(db: Db, table: string, column: string): string[] | undefined {
  const sample = db.prepare(`select "${column}" as v from "${table}" where "${column}" is not null limit 1`).get() as { v: unknown } | undefined;
  if (typeof sample?.v !== "string" || !sample.v.trimStart().startsWith("{")) return undefined;
  const sql = `select distinct case when instr(j.key, ':') > 0 then substr(j.key, 1, instr(j.key, ':') - 1) else j.key end as k
    from (select "${column}" as v from "${table}" limit ${MAX_JSON_ROWS}) t, json_each(t.v) j where json_valid(t.v) order by k`;
  return (db.prepare(sql).all() as { k: string }[]).map((row) => row.k);
}

function sqliteTables(db: Db): NonNullable<StoreInventory["tables"]> {
  const names = (db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name").all() as { name: string }[]).map((row) => row.name);
  return names.map((name) => {
    const columns = (db.prepare(`pragma table_info("${name}")`).all() as { name: string; type: string }[]).filter((column) => column.type.toUpperCase() !== "BLOB");
    const rows = (db.prepare(`select count(*) as n from "${name}"`).get() as { n: number }).n;
    const jsonKeys = Object.fromEntries(columns.flatMap((column) => (column.type.toUpperCase() === "TEXT" ? [[column.name, jsonKeyFamilies(db, name, column.name)]] : [])).filter(([, keys]) => keys));
    return { name, columns: columns.map((column) => column.name), rows, ...(Object.keys(jsonKeys).length > 0 && { jsonKeys }) };
  });
}

/** Numbers become `#` so `daemon started pid 41` and `pid 977` are one class. */
function logInventory(text: string): Pick<StoreInventory, "logClasses" | "timestamped" | "lines"> {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const classes = new Map<string, number>();
  for (const line of lines) {
    const key = line.replace(/\d+/g, "#").slice(0, 120);
    classes.set(key, (classes.get(key) ?? 0) + 1);
  }
  const logClasses = [...classes].sort((a, b) => b[1] - a[1]).slice(0, MAX_LOG_CLASSES).map(([classText, count]) => ({ text: classText, count }));
  return { lines: lines.length, timestamped: lines.filter((line) => ISO_DATE.test(line)).length * 2 > lines.length, logClasses };
}

function jsonlKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const line of text.split("\n").slice(0, MAX_JSON_ROWS)) {
    try {
      Object.keys(JSON.parse(line) as object).forEach((key) => keys.add(key));
    } catch {
      continue;
    }
  }
  return [...keys].sort();
}

function httpUrl(store: StoreRef, path = ""): string {
  const base = required(store.url, store, "url");
  return path.startsWith("/") ? new URL(path, base).toString() : base;
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]) });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return response.json();
}

/** Splits on whitespace and runs with no shell, so a command cannot pipe or redirect. */
export async function runReadCommand(command: string, signal: AbortSignal): Promise<string> {
  const [file, ...args] = command.trim().split(/\s+/);
  const { stdout } = await run(file!, args, { signal, timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

async function inventoryOf(store: StoreRef, signal: AbortSignal): Promise<Omit<StoreInventory, "store" | "kind">> {
  switch (store.kind) {
    case "sqlite":
      return { tables: withReadOnly(store, sqliteTables) };
    case "log":
      return logInventory(await readFile(required(store.path, store, "path"), "utf8"));
    case "jsonl":
      return { keys: jsonlKeys(await readFile(required(store.path, store, "path"), "utf8")) };
    case "http":
      return { keys: Object.keys((await fetchJson(httpUrl(store), signal)) as object).sort() };
    case "cli":
      return logInventory(await runReadCommand(`${required(store.command, store, "command")} --help`, signal));
  }
}

/** Never throws: an unreadable store is part of what the audit reports. */
export async function inventoryStore(store: StoreRef, signal: AbortSignal): Promise<StoreInventory> {
  try {
    return { store: store.id, kind: store.kind, ...(await inventoryOf(store, signal)) };
  } catch (error) {
    return { store: store.id, kind: store.kind, error: error instanceof Error ? error.message : String(error) };
  }
}

function at(value: unknown, path: string | undefined): unknown {
  return (path ?? "").split(".").filter(Boolean).reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], value);
}

function numberOf(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A row's `value` and `n` columns when it names them, else its first column and the row count. */
function sqlValue(rows: Record<string, unknown>[], valuePath: string | undefined): { value: number | null; n: number } {
  const first = rows[0];
  if (!first) return { value: null, n: 0 };
  const value = valuePath ? first[valuePath] : "value" in first ? first.value : Object.values(first)[0];
  return { value: numberOf(value), n: typeof first.n === "number" ? first.n : rows.length };
}

export async function queryStore(store: StoreRef, query: MetricQuery, signal: AbortSignal): Promise<{ value: number | null; n: number }> {
  if (query.kind === "sql") return withReadOnly(store, (db) => sqlValue(db.prepare(query.text).all() as Record<string, unknown>[], query.valuePath));
  if (query.kind === "http") return { value: numberOf(at(await fetchJson(httpUrl(store, query.text), signal), query.valuePath)), n: 1 };
  const declared = store.command;
  if (!declared || (query.text !== declared && !query.text.startsWith(`${declared} `))) throw new Error(`cli query is outside the store's declared command`);
  const output = (await runReadCommand(query.text, signal)).trim();
  return { value: numberOf(query.valuePath ? at(JSON.parse(output), query.valuePath) : Number(output)), n: 1 };
}
