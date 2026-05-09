import type { Provider } from '../../providers/types.js';
import { errorMessage } from '../../utils/errors.js';

type ValidationResult =
  | { mode: 'native' }
  | { mode: 'fallback'; warning: string }
  | { mode: 'unreachable'; reason: string };

export async function validateModelToolSupport(
  provider: Provider,
  model: string,
): Promise<ValidationResult> {
  if (!provider.getModelInfo) {
    return { mode: 'native' };
  }
  try {
    const info = await provider.getModelInfo(model);
    if (info.supportsTools) {
      return { mode: 'native' };
    }
    return {
      mode: 'fallback',
      warning:
        `Model "${model}" does not natively support tools. ` +
        `Falling back to text-based <tool_call> parsing — reliability may be reduced.`,
    };
  } catch (err: unknown) {
    return {
      mode: 'unreachable',
      reason: `Could not verify model capabilities: ${errorMessage(err)}`,
    };
  }
}
