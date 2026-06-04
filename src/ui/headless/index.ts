import { readAllStdin } from './io.js';
import { runHeadlessEventPump } from './event-pump.js';
import { setupHeadlessRuntime } from './setup.js';
import { teardownHeadlessRun } from './teardown.js';
import type { HeadlessOptions } from './types.js';

export type { HeadlessOptions };

export async function runHeadless(options: HeadlessOptions): Promise<void> {
  const userInput = await readAllStdin();
  if (!userInput) {
    process.stderr.write('factory: no input on stdin\n');
    process.exit(2);
  }

  const runtime = await setupHeadlessRuntime(options, userInput);
  try {
    await runHeadlessEventPump(userInput, options, runtime);
  } finally {
    const exitCode = await teardownHeadlessRun(options, runtime);
    process.exit(exitCode);
  }
}
