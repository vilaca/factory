/** Conditional stderr write when FACTORY_DEBUG=1. */
export function dbg(message: string): void {
  if (process.env.FACTORY_DEBUG === '1') process.stderr.write(`[factory:debug] ${message}\n`);
}
