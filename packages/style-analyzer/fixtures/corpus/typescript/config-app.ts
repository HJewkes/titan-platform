// Style: camelCase vars/fns, PascalCase types, SCREAMING_SNAKE constants
// Formatting: no semicolons, single quotes
// Docs: JSDoc on exports only | Flow: early returns
import * as path from 'node:path'
import * as fs from 'node:fs'

import { z } from 'zod'

import { logger } from '@app/logging'

const DEFAULT_PORT = 3000
const DEFAULT_LOG_LEVEL = 'info'
const CONFIG_FILE_NAME = 'app.config.json'

interface AppConfig {
  port: number
  logLevel: string
  databaseUrl: string
  corsOrigins: string[]
  enableMetrics: boolean
}

const ConfigSchema = z.object({
  port: z.number().default(DEFAULT_PORT),
  logLevel: z.string().default(DEFAULT_LOG_LEVEL),
  databaseUrl: z.string(),
  corsOrigins: z.array(z.string()).default([]),
  enableMetrics: z.boolean().default(false),
})

/** Loads application config from file with environment overrides. */
export function loadConfig(configDir: string): AppConfig {
  const filePath = path.join(configDir, CONFIG_FILE_NAME)

  if (!fs.existsSync(filePath)) {
    throw new ConfigError('file_not_found', `Config not found: ${filePath}`)
  }

  const raw = fs.readFileSync(filePath, 'utf-8')
  const parsed = JSON.parse(raw)

  return applyEnvOverrides(ConfigSchema.parse(parsed))
}

/** Returns the default configuration values. */
export function getDefaults(): AppConfig {
  return {
    port: DEFAULT_PORT,
    logLevel: DEFAULT_LOG_LEVEL,
    databaseUrl: '',
    corsOrigins: [],
    enableMetrics: false,
  }
}

function applyEnvOverrides(config: AppConfig): AppConfig {
  const portOverride = process.env['PORT']
  const dbOverride = process.env['DATABASE_URL']

  return {
    ...config,
    port: portOverride ? parseInt(portOverride, 10) : config.port,
    databaseUrl: dbOverride ?? config.databaseUrl,
  }
}
