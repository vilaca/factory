import os from 'os';
import path from 'path';

const FACTORY_DIR = '.factory';

/** Path under the user's `~/.factory/` directory.
 * `factoryHomePath()` returns the directory itself; trailing segments are
 * joined as path components (`factoryHomePath('sessions', 'foo.jsonl')`). */
export function factoryHomePath(...segments: string[]): string {
  return path.join(os.homedir(), FACTORY_DIR, ...segments);
}
