import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { z } from "zod";

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Reads every `<sub>/*.yaml` under `dir` through `schema`; a file is named after its key. */
export function readYamlDir<T>(dir: string, sub: string, schema: z.ZodType<T>, key: (item: T) => string): Map<string, T> {
  const path = join(dir, sub);
  const files = existsSync(path) ? readdirSync(path).filter((name) => name.endsWith(".yaml")).sort() : [];
  return new Map(
    files.map((name) => {
      const file = `${sub}/${name}`;
      let item: T;
      try {
        item = schema.parse(parse(readFileSync(join(path, name), "utf8")));
      } catch (error) {
        throw new Error(`${file}: ${describe(error)}`);
      }
      if (`${key(item)}.yaml` !== name) throw new Error(`${file}: names ${key(item)}, so the file is ${key(item)}.yaml`);
      return [key(item), item];
    }),
  );
}
