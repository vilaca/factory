/**
 * Strongly-typed config writers. Avoids hand-rolled JSON.stringify scattered
 * across each test file and keeps the schema reference in one place.
 */

import fs from 'fs';
import path from 'path';
import type { Config } from '../../src/core/config/types.js';

export function writeGlobalConfig(home: string, cfg: Partial<Config>): void {
  const dir = path.join(home, '.config', 'factory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
}

export function writeProjectConfig(cwd: string, cfg: Partial<Config>): void {
  const dir = path.join(cwd, '.factory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
}
