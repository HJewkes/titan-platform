#!/usr/bin/env node
import { CommanderError } from 'commander';
import { formatError, EXIT } from './errors.js';
import { exitAfterFlush, exitQuietlyOnBrokenPipe } from './utils/exit.js';
import { buildProgram, emitError } from './program.js';

/**
 * Entry point. Builds the program and dispatches argv. Commander errors
 * (e.g. unknown command, missing required option) are mapped to the
 * USAGE exit code; everything else surfaces via the per-command action.
 */
export async function main(argv: string[]): Promise<void> {
  exitQuietlyOnBrokenPipe();
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // Commander already wrote to stderr for help / version. Just exit.
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
        return exitAfterFlush(0);
      }
      return exitAfterFlush(EXIT.USAGE);
    }
    const { message, code } = formatError(err);
    emitError(message, code, 'human');
    return exitAfterFlush(code);
  }
}

void main(process.argv);
