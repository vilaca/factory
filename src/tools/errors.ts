/**
 * Tool-author exception signaling "valid request, no matching data."
 * The missing primitive identified in the reliability paper (§II.B):
 * current LLM tool-calling frameworks treat every successful return as
 * "step complete," so a "not found" gets marked as success and the
 * model fabricates downstream. The fix is a dedicated exception type
 * the framework recognizes:
 *
 *   - Tool author raises this from inside their callable when a lookup
 *     returns nothing, an ID doesn't resolve, the query found zero
 *     rows, etc.
 *   - The agent's tool executor catches it explicitly *before* the
 *     generic `catch (err)` branch, feeds the message back to the
 *     model as the tool result, but does NOT mark the step complete
 *     and does NOT bump the hard-error counter.
 *   - The model gets a chance to retry with different arguments, try
 *     an alternative tool, or give up — bounded only by the iteration
 *     budget, not the hard-error counter.
 *
 * Inherits from `Error` directly, NOT from the framework's
 * ReliabilityError hierarchy. The reasoning (next-steps.md §9): this
 * is a tool-author signal, not a framework failure. Sitting under the
 * framework hierarchy would conflate "the loop is unwinding" with
 * "the tool's data store said no."
 *
 * Idiom from the spec:
 *
 *     def get_alert(self, service: str) -> str:
 *         if service not in self.alerts:
 *             raise ToolResolutionError(f"No alert found for service '{service}'")
 *         return self.alerts[service]
 *
 * TypeScript equivalent:
 *
 *     async function execute(args) {
 *       const service = args.service as string;
 *       const alert = await db.findAlert(service);
 *       if (!alert) {
 *         throw new ToolResolutionError(`No alert found for service '${service}'`);
 *       }
 *       return { success: true, output: format(alert) };
 *     }
 *
 * The corresponding tool_result the model sees is the exception
 * message (not a wrapped framework error message) — so the model can
 * read "no alert for 'payments'" and try "payments-service" on the
 * next turn.
 */
export class ToolResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolResolutionError';
  }
}
