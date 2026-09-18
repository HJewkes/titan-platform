// Style: camelCase vars/fns, PascalCase types, SCREAMING_SNAKE constants
// Formatting: no semicolons, single quotes
// Docs: JSDoc on exports only | Flow: early returns

import type { Router, RouteHandler } from '@app/http'
import { logger } from '@app/logging'

import { login, refresh } from './controller-auth'
import { handleWebhook } from './handler-webhook'
import { createLoggingMiddleware } from './middleware-logging'

const API_PREFIX = '/api/v1'
const WEBHOOK_PATH = '/webhooks'

interface RouteConfig {
  method: string
  path: string
  handler: RouteHandler
  auth: boolean
}

/** Registers all application routes on the given router. */
export function registerRoutes(router: Router): void {
  const routes = buildRouteTable()

  for (const route of routes) {
    const fullPath = `${API_PREFIX}${route.path}`
    router.register(route.method, fullPath, route.handler)
    logger.info(`Registered route: ${route.method} ${fullPath}`)
  }

  router.use(createLoggingMiddleware())
}

/** Returns the number of registered route definitions. */
export function getRouteCount(): number {
  return buildRouteTable().length
}

function buildRouteTable(): RouteConfig[] {
  return [
    { method: 'POST', path: '/auth/login', handler: login, auth: false },
    { method: 'POST', path: '/auth/refresh', handler: refresh, auth: true },
    { method: 'POST', path: WEBHOOK_PATH, handler: handleWebhook, auth: false },
  ]
}
