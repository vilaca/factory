import { readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

interface BuildInfo {
  version: string;
  buildTimestamp: string;
}

let cached: BuildInfo | undefined;

/**
 * Read the running binary's version from package.json and the mtime of its
 * compiled entrypoint. Used to log "what was actually loaded" at session
 * start so forensics on old logs aren't a guessing game.
 */
export function getBuildInfo(): BuildInfo {
  if (cached) return cached;
  try {
    const here = fileURLToPath(import.meta.url);
    // src/utils/build-info.ts compiles to dist/utils/build-info.js;
    // package.json is two levels up.
    const pkgPath = path.resolve(path.dirname(here), '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    const stat = statSync(here);
    cached = {
      version: pkg.version ?? 'unknown',
      buildTimestamp: stat.mtime.toISOString(),
    };
  } catch {
    cached = { version: 'unknown', buildTimestamp: 'unknown' };
  }
  return cached;
}
