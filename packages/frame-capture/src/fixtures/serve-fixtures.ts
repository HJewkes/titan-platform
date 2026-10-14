import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURE_DIR = fileURLToPath(new URL('.', import.meta.url))
const TYPES: Record<string, string> = { '.html': 'text/html', '.woff2': 'font/woff2' }

export interface Served {
  url: (page: string) => string
  close(): Promise<void>
}

function tcpAddress(address: AddressInfo | string | null): AddressInfo {
  if (address === null || typeof address === 'string') throw new Error(`fixture server is not on a TCP port: ${String(address)}`)
  return address
}

/** Serves this directory over loopback HTTP: fonts do not load from file:// URLs. */
export async function serveFixtures(): Promise<Served> {
  const server = createServer((req, res) => {
    const path = normalize(new URL(req.url ?? '/', 'http://fixture').pathname)
    readFile(join(FIXTURE_DIR, path)).then(
      (body) => res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(body),
      () => res.writeHead(404).end(),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = tcpAddress(server.address())
  return {
    url: (page) => `http://127.0.0.1:${port}/page.html?page=${page}`,
    close: () => {
      server.closeAllConnections()
      return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}
