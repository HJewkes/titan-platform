import assert from 'node:assert/strict'
import type { BrowserContext, CDPSession, Page } from 'playwright-core'
import { describe, test } from 'vitest'
import { partialFake } from '@titan-design/test-kit'
import { screenshotFrame } from './capture.js'

const PNG_BASE64 = Buffer.from('synthetic-png').toString('base64')

/** A page whose CDP session answers each Page.captureScreenshot with the next scripted outcome. */
function fakePage(outcomes: readonly (Error | 'ok')[]): { page: Page; calls: () => number } {
  let calls = 0
  const session = partialFake<CDPSession>({
    // @ts-expect-error the real send is generic over the protocol command; the fake answers only captureScreenshot
    send: async () => {
      const outcome = outcomes[calls++]
      if (outcome instanceof Error) throw outcome
      return { data: PNG_BASE64 }
    },
  })
  const context = partialFake<BrowserContext>({ newCDPSession: async () => session })
  const page = partialFake<Page>({ evaluate: async () => undefined, context: () => context })
  return { page, calls: () => calls }
}

const captureFailure = () => new Error('cdpSession.send: Protocol error (Page.captureScreenshot): Unable to capture screenshot')

describe('screenshotFrame retry', () => {
  // Mutation: the catch rethrows without taking the second shot.
  test('one "Unable to capture screenshot" answer is retried and the frame is returned', async () => {
    const { page, calls } = fakePage([captureFailure(), 'ok'])

    const png = await screenshotFrame(page)

    assert.equal(png.toString(), 'synthetic-png')
    assert.equal(calls(), 2)
  })

  // Mutation: the message check is dropped, so every error is retried.
  test('any other error is thrown without a retry', async () => {
    const { page, calls } = fakePage([new Error('Target closed'), 'ok'])

    await assert.rejects(screenshotFrame(page), /Target closed/)

    assert.equal(calls(), 1)
  })

  test('a second capture failure is thrown, not retried again', async () => {
    const { page, calls } = fakePage([captureFailure(), captureFailure(), 'ok'])

    await assert.rejects(screenshotFrame(page), /Unable to capture screenshot/)

    assert.equal(calls(), 2)
  })
})
