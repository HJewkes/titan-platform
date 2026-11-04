import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".wav": "audio/wav",
};

interface ServedTree {
  /** `http://127.0.0.1:<port>`, with no trailing slash. */
  origin: string;
  close(): Promise<void>;
}

/** The file a request names under `root`, `index.html` for a directory; a path that climbs out of `root` names none. */
function fileFor(root: string, url: string | undefined): string | undefined {
  const pathname = decodeURIComponent(new URL(url ?? "/", "http://loopback").pathname);
  const file = path.join(root, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
  return file === root || file.startsWith(`${root}${path.sep}`) ? file : undefined;
}

async function answer(root: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const file = fileFor(root, request.url);
  try {
    if (!file) throw new Error("outside the tree");
    const body = await readFile(file);
    response.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    response.writeHead(404).end();
  }
}

/** Serves a materialised page tree on loopback, read only, for the browser the qa stage drives. */
export function serveTree(dir: string): Promise<ServedTree> {
  const root = path.resolve(dir);
  const server = createServer((request, response) => void answer(root, request, response));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("the qa page server has no TCP port"));
      const close = () => new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
      resolve({ origin: `http://127.0.0.1:${address.port}`, close });
    });
  });
}
