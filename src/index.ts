#!/usr/bin/env node

import { runMain } from './cli/startup/main.js';
import { renderError } from './ui/renderer.js';
import { errorMessage } from './utils/errors.js';

process.on('unhandledRejection', (reason: unknown) => {
  console.error(renderError(`unhandledRejection: ${errorMessage(reason)}`));
  process.exit(1);
});

process.on('uncaughtException', (err: Error) => {
  console.error(renderError(`uncaughtException: ${errorMessage(err)}`));
  process.exit(1);
});

runMain().catch((err: unknown) => {
  console.error(renderError(errorMessage(err)));
  process.exit(1);
});
