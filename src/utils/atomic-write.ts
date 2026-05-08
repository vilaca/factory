import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';

/**
 * Atomically write `data` to `filePath` via the standard temp-file +
 * rename pattern. A crash mid-write leaves either the prior good content
 * intact or the new content fully on disk — never a half-written file.
 *
 * The temp file is created in the same directory as the target so
 * `rename` is a same-filesystem move (atomic on POSIX). The pid +
 * random suffix avoids collisions when two processes flush at once.
 *
 * Defaults to mode 0o600 because every caller in this codebase writes
 * sensitive material (config with API keys, trust DB, key-stats);
 * override only when the file is intentionally world-readable.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string,
  opts: { mode?: number } = {},
): Promise<void> {
  const mode = opts.mode ?? 0o600;
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `${base}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    await fs.writeFile(tmp, data, { encoding: 'utf-8', mode });
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {
      /* tmp may not exist */
    });
    throw err;
  }
}
