// Style: camelCase vars/fns, PascalCase types, SCREAMING_SNAKE constants
// Formatting: no semicolons, single quotes
// Docs: JSDoc on exports only | Errors: typed catch | Flow: early returns
import * as crypto from 'node:crypto'

import type { IncomingMessage } from '@app/http'
import { eventBus } from '@app/events'
import { logger } from '@app/logging'

import type { WebhookPayload } from './types'

const SIGNATURE_HEADER = 'x-webhook-signature'
const MAX_PAYLOAD_BYTES = 1_048_576

interface WebhookResult {
  accepted: boolean
  eventId: string | null
}

/** Processes an incoming webhook request with signature verification. */
export async function handleWebhook(
  message: IncomingMessage,
  secret: string
): Promise<WebhookResult> {
  const signature = message.headers?.[SIGNATURE_HEADER]

  if (!signature) {
    return { accepted: false, eventId: null }
  }

  const body = await readBody(message)

  if (!verifySignature(body, signature, secret)) {
    return { accepted: false, eventId: null }
  }

  try {
    const payload: WebhookPayload = JSON.parse(body)
    await eventBus.emit(payload.event, payload.data)
    return { accepted: true, eventId: payload.id }
  } catch (error) {
    if (error instanceof SyntaxError) {
      logger.warn('Invalid webhook JSON payload')
      return { accepted: false, eventId: null }
    }
    throw error
  }
}

/** Verifies an HMAC-SHA256 webhook signature. */
export function verifySignature(
  body: string,
  signature: string,
  secret: string
): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex')

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  )
}

async function readBody(message: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of message.stream) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf-8')
}
