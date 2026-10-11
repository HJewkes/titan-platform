import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { z } from "zod";
import { createRegistry, defineCommand, type BaseContext, type CommandRegistry } from "@titan-design/registry";
import type { Surface } from "./surface.js";

export interface TestContext extends BaseContext {
  surface: Surface;
}

export const createTestContext = (surface: Surface): TestContext => ({ warnings: [], format: "json", surface });

/** Two commands: one that succeeds with a warning, one that throws with a numeric code. */
export function createTestRegistry(): CommandRegistry<TestContext> {
  const registry = createRegistry<TestContext>();

  registry.register(
    defineCommand<{ name: string }, { greeting: string }, TestContext>({
      name: "greet",
      description: "Greet someone",
      args: z.object({ name: z.string() }),
      result: z.object({ greeting: z.string() }),
      async run(args, ctx) {
        ctx.warnings.push(`via ${ctx.surface}`);
        return { greeting: `hello ${args.name}` };
      },
    }),
  );

  registry.register(
    defineCommand<Record<string, never>, never, TestContext>({
      name: "boom",
      description: "Always throws",
      args: z.object({}),
      result: z.never(),
      async run() {
        throw Object.assign(new Error("kaboom"), { code: 78 });
      },
    }),
  );

  return registry;
}

export interface SelfSignedPair {
  certFile: string;
  keyFile: string;
  /** The PEM certificate, for a client's `ca` option. */
  cert: string;
}

/** A one-day self-signed pair in `dir`, covering each DNS name and IP; the key is mode 0600. */
export function writeSelfSignedCert(dir: string, names: readonly string[], { prefix = "remote", days = 1 } = {}): SelfSignedPair {
  const certFile = path.join(dir, `${prefix}.crt`);
  const keyFile = path.join(dir, `${prefix}.key`);
  const san = names.map((name) => (isIP(name) ? `IP:${name}` : `DNS:${name}`)).join(",");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", String(days), "-subj", `/CN=${names[0]}`, "-addext", `subjectAltName=${san}`], { stdio: "ignore" });
  chmodSync(keyFile, 0o600);
  return { certFile, keyFile, cert: readFileSync(certFile, "utf8") };
}
