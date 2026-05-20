// Narrowing helpers for `catch (err: unknown)` blocks.
//
// `unknown` is the safer default than `any` (a slipped `.message` is a type
// error instead of a runtime crash on non-Error throws), but it requires
// narrowing at every use. Concentrate the narrowing here so individual
// callers stay terse.

/**
 * Best-effort message extraction. Handles:
 *   - Real Error instances (`new Error(...)`, subclasses, DOMException).
 *   - Duck-typed `{ message: string }` (some libraries throw plain objects).
 *   - Anything else falls through to `String(err)`.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}

/** Type guard for real Error instances. Use when callers also need `.name`,
 *  `.stack`, or instanceof checks against subclasses. */
export function isError(err: unknown): err is Error {
  return err instanceof Error;
}

/** Construct an Error whose `.name` is `'AbortError'`. Some Node APIs
 * (signal.throwIfAborted, AbortSignal-aware fetch) throw with this shape,
 * and we mirror them so downstream catch blocks that detect aborts via
 * `err.name === 'AbortError'` stay uniform regardless of who threw. */
export function makeAbortError(message = 'aborted'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/** Read a `code` property if present (Node fs/child_process errors set
 *  `ENOENT`, `EACCES`, etc.). Returns undefined when the throw isn't a
 *  Node-style error or doesn't have one. */
export function errorCode(err: unknown): string | undefined {
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string'
  ) {
    return (err as { code: string }).code;
  }
  return undefined;
}
