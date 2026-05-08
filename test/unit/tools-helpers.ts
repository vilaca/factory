// Shared helpers for the tools.* test split. Lives at .ts (not .test.ts)
// so the test runner glob (`test/unit/*.test.ts`) doesn't pick it up.

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export function tmpFile(prefix: string, content?: string): string {
  const filePath = path.join(os.tmpdir(), `oc-unit-${prefix}-${crypto.randomUUID()}.txt`);
  if (content !== undefined) {
    fs.writeFileSync(filePath, content);
  }
  return filePath;
}

export function cleanup(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

export function makeSymlink(target: string, suffix: string): string {
  const link = path.join(os.tmpdir(), `oc-unit-link-${suffix}-${crypto.randomUUID()}`);
  fs.symlinkSync(target, link);
  return link;
}
