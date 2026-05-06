/**
 * Tracks files the agent has Read in this session so repeat reads can be
 * short-circuited with a "still unchanged since previous Read" hint instead
 * of re-sending the whole file content as a tool result.
 *
 * Also carries fingerprints into compaction summaries: when history is
 * collapsed, the summary lists the files we know about with their mtime so
 * the agent can re-Read them and immediately confirm "unchanged" without the
 * full content needing to live in conversation history.
 *
 * mtime is the change-detection primitive (one stat call, no I/O on the file
 * body). Hash is computed lazily for the compaction summary so the model has
 * a stable identifier to refer to even if mtime shifts for a benign reason.
 */

import * as fs from 'fs/promises';
import { createHash } from 'crypto';

export interface FileCacheEntry {
  path: string;
  mtimeMs: number;
  size: number;
  /** sha256 of the file content. Computed on first Read; refreshed on hash mismatch. */
  hash: string;
  /** Number of compactions that had run when this entry was last read. */
  compactionsAtRead: number;
}

export class FileCache {
  private entries = new Map<string, FileCacheEntry>();
  private compactions = 0;

  size(): number {
    return this.entries.size;
  }

  get(path: string): FileCacheEntry | undefined {
    return this.entries.get(path);
  }

  /** Stat + hash a path. Returns undefined for missing/unreadable files.
   *
   * Fast path: if `previous` is provided and its (mtimeMs, size) match the
   * current stat, the file is treated as unchanged and the cached hash is
   * returned without re-reading the body. This is the common case for the
   * Read short-circuit — files don't move under most workflows. The slow
   * path (read + sha256) only kicks in when stat differs, so a subtle
   * "same mtime, same size, content swapped via in-place edit" still gets
   * a fresh hash whenever the OS bumps mtime — which it does for any
   * normal write. */
  static async stamp(
    path: string,
    previous?: { mtimeMs: number; size: number; hash: string },
  ): Promise<{ mtimeMs: number; size: number; hash: string } | undefined> {
    try {
      const stat = await fs.stat(path);
      if (previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) {
        return { mtimeMs: stat.mtimeMs, size: stat.size, hash: previous.hash };
      }
      const buf = await fs.readFile(path);
      const hash = createHash('sha256').update(buf).digest('hex');
      return { mtimeMs: stat.mtimeMs, size: stat.size, hash };
    } catch {
      return undefined;
    }
  }

  /** Record a Read of `path` with its current fingerprint. */
  record(path: string, fingerprint: { mtimeMs: number; size: number; hash: string }): void {
    this.entries.set(path, {
      path,
      mtimeMs: fingerprint.mtimeMs,
      size: fingerprint.size,
      hash: fingerprint.hash,
      compactionsAtRead: this.compactions,
    });
  }

  /** Drop the entry for `path` — call after Edit/Write so the next Read re-hashes. */
  invalidate(path: string): void {
    this.entries.delete(path);
  }

  /** Increment the compaction counter so subsequent records are tagged with the new generation. */
  noteCompaction(): void {
    this.compactions++;
  }

  /** Returns true when the entry for `path` was recorded BEFORE any compaction
   * that has since run — i.e. the original Read result may have been summarized
   * away and we should re-send content rather than just say "unchanged". */
  wasReadBeforeCompaction(path: string): boolean {
    const entry = this.entries.get(path);
    if (!entry) return false;
    return entry.compactionsAtRead < this.compactions;
  }

  /** Snapshot of (path, hash) for every file we've fingerprinted, sorted by path
   * so compaction summaries are stable across runs. */
  fingerprints(): Array<{ path: string; hash: string }> {
    return [...this.entries.values()]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(e => ({ path: e.path, hash: e.hash }));
  }
}
