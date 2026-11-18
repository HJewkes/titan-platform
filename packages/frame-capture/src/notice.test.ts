import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, test } from 'vitest'

const packageDir = join(import.meta.dirname, '..')
const built = existsSync(join(packageDir, 'dist', 'index.js'))

// Packs the built package the way a release does, so the assertions see the published tarball.
function packAndExtract(into: string): string {
  execFileSync('pnpm', ['pack', '--pack-destination', into], { cwd: packageDir, stdio: 'pipe' })
  const tarball = readdirSync(into).find((name) => name.endsWith('.tgz'))
  if (!tarball) throw new Error('pnpm pack produced no tarball')
  execFileSync('tar', ['-xzf', tarball], { cwd: into })
  return join(into, 'package')
}

describe.skipIf(!built)('the packed frame-capture tarball', () => {
  let scratch: string
  let unpacked: string

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'frame-capture-pack-'))
    unpacked = packAndExtract(scratch)
  }, 60_000)

  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  test('ships a NOTICE carrying the anatomy copyright and the MIT text', () => {
    const notice = readFileSync(join(unpacked, 'NOTICE'), 'utf8')

    assert.match(notice, /https:\/\/github\.com\/wheresryan22\/anatomy/)
    assert.match(notice, /kit\/turn-audit\.mjs/)
    assert.match(notice, /Copyright \(c\) 2026 Ryan/)
    assert.match(notice, /Permission is hereby granted, free of charge/)
  })

  test("keeps the pop check's anatomy header as a legal comment in dist", () => {
    const distDir = join(unpacked, 'dist')
    const bundles = readdirSync(distDir).filter((name) => name.endsWith('.js'))
    const sources = bundles.map((name) => readFileSync(join(distDir, name), 'utf8'))

    const legal = sources.filter((source) => /\/\*![^]*?anatomy[^]*?2026 Ryan[^]*?@license MIT/.test(source))
    assert.ok(legal.length > 0)
  })
})
