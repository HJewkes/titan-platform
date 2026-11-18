import { isRecord } from '@titan-design/rpc-protocol/narrow';
import type { BurdenConfig } from './config.js';

const CONFIG_KEYS: readonly (keyof BurdenConfig)[] = [
  'testGlobs',
  'ignoredGlobs',
  'generatedGlobs',
  'migrationGlobs',
  'apiGlobs',
  'storedDataGlobs',
  'protectedPaths',
];

function isConfigKey(key: string): key is keyof BurdenConfig {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${source}: not valid JSON`);
  }
}

/** A config file's JSON; each given key replaces its default list. Throws naming `source` on any shape error. */
export function parseBurdenConfig(text: string, source: string): Partial<BurdenConfig> {
  const parsed = parseJson(text, source);
  if (!isRecord(parsed)) throw new Error(`${source}: must be a JSON object`);
  const config: Partial<BurdenConfig> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!isConfigKey(key)) throw new Error(`${source}: unknown key ${key}`);
    if (!isStringArray(value)) throw new Error(`${source}: ${key} must be an array of strings`);
    config[key] = value;
  }
  return config;
}
