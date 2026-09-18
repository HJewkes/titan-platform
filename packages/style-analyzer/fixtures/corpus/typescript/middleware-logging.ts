// Style: camelCase vars/fns, PascalCase types, SCREAMING_SNAKE constants
// Formatting: no semicolons, single quotes
// Docs: JSDoc on exports only | Flow: early returns
import { performance } from 'node:perf_hooks'

import { logger } from '@app/logging'

import type { Middleware, RequestContext, NextFunction } from './types'

const SLOW_REQUEST_THRESHOLD_MS = 2000
const HEALTH_CHECK_PATH = '/health'

interface RequestLogEntry {
  method: string
  path: string
  statusCode: number
  durationMs: number
}

/** Creates a logging middleware that records request timing. */
export function createLoggingMiddleware(): Middleware {
  return async (ctx: RequestContext, next: NextFunction) => {
    if (ctx.path === HEALTH_CHECK_PATH) {
      return next()
    }

    const startTime = performance.now()

    await next()

    const durationMs = Math.round(performance.now() - startTime)
    const entry = buildLogEntry(ctx, durationMs)

    if (durationMs > SLOW_REQUEST_THRESHOLD_MS) {
      logger.warn('Slow request detected', entry)
    } else {
      logger.info('Request completed', entry)
    }
  }
}

/** Creates a middleware that adds a request ID header. */
export function createRequestIdMiddleware(): Middleware {
  return async (ctx: RequestContext, next: NextFunction) => {
    const requestId = ctx.headers?.['x-request-id'] ?? generateId()
    ctx.state = { ...ctx.state, requestId }
    return next()
  }
}

function buildLogEntry(ctx: RequestContext, durationMs: number): RequestLogEntry {
  return {
    method: ctx.method,
    path: ctx.path,
    statusCode: ctx.status ?? 200,
    durationMs,
  }
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10)
}
