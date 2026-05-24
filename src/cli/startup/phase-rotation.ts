import type { Config } from '../../core/config/types.js';
import { renderError } from '../../ui/renderer.js';
import { errorMessage } from '../../utils/errors.js';
import type { CliArgs } from '../args.js';
import { parseRotationChain } from './parse-rotation.js';
import { applyCliRotationOverrides, persistRotationConfig } from './config.js';

/**
 * Apply CLI rotation overrides to `config.agent.rotation` and (when
 * `--save-rotate` is set) persist the merged result to the global config.
 * Mutates config in place. Calls `process.exit(1)` on parse / persist
 * failure.
 */
export async function applyRotationPhase(config: Config, cliArgs: CliArgs): Promise<void> {
  if (
    cliArgs.rotate === undefined &&
    !cliArgs.saveRotate &&
    !cliArgs.noRotate &&
    !cliArgs.noRotateKeys &&
    !cliArgs.noRotateModels
  ) {
    return;
  }
  let next;
  try {
    next = applyCliRotationOverrides(config.agent?.rotation, cliArgs, parseRotationChain);
  } catch (err: unknown) {
    console.log(renderError(errorMessage(err)));
    process.exit(1);
  }
  config.agent = { ...config.agent, rotation: next };
  if (cliArgs.saveRotate) {
    try {
      const { updateGlobalConfig } = await import('../../core/config/index.js');
      await persistRotationConfig(next, updateGlobalConfig);
    } catch (err: unknown) {
      console.log(renderError(`Failed to save rotation config: ${errorMessage(err)}`));
      process.exit(1);
    }
  }
}
