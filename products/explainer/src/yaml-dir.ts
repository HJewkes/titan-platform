import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { z } from "zod";

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Every stage reloads the doctrine, and YAML parsing dominated those loads. Keyed on the file's text so an edit reloads;
// each call gets a clone, so no caller sees another's mutations.
const parsed = new Map<string, { text: string; document: unknown }>();

function parseYamlFile(file: string): unknown {
  const text = readFileSync(file, "utf8");
  const hit = parsed.get(file);
  if (hit?.text === text) return structuredClone(hit.document);
  const document: unknown = parse(text);
  parsed.set(file, { text, document });
  return structuredClone(document);
}

/** Reads every `<sub>/*.yaml` under `dir` through `schema`; a file is named after its key. */
export function readYamlDir<T>(dir: string, sub: string, schema: z.ZodType<T>, key: (item: T) => string): Map<string, T> {
  const path = join(dir, sub);
  const files = existsSync(path) ? readdirSync(path).filter((name) => name.endsWith(".yaml")).sort() : [];
  return new Map(
    files.map((name) => {
      const file = `${sub}/${name}`;
      let item: T;
      try {
        item = schema.parse(parseYamlFile(join(path, name)));
      } catch (error) {
        throw new Error(`${file}: ${describe(error)}`);
      }
      if (`${key(item)}.yaml` !== name) throw new Error(`${file}: names ${key(item)}, so the file is ${key(item)}.yaml`);
      return [key(item), item];
    }),
  );
}
