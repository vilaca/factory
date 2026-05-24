import type { Provider } from '../../providers/types.js';
import type { Config } from '../../core/config/types.js';
import { validateModelToolSupport } from '../../core/auth/model-validation.js';
import { renderError } from '../../ui/renderer.js';
import { dbg } from '../../utils/debug.js';
import { selectModelInk } from './menu.js';
import type { ModelSelection } from '../../core/selection/types.js';

export interface ValidatedModel {
  model: string;
  useTextToolFallback: boolean;
  validationWarning?: string;
  validationMode: 'native' | 'fallback' | 'unreachable';
}

/**
 * Pick the model (config / resume / picker) and validate the provider's
 * tool-support claim against a real probe call. Calls `process.exit(1)`
 * if validation reports the provider is unreachable.
 */
export async function selectAndValidateModel(
  provider: Provider,
  providerName: string,
  config: Config,
  resumeModel: string | null,
  lastSession: ModelSelection | null,
  availableModels: string[] | null,
): Promise<ValidatedModel> {
  let model: string;
  if (config.model) {
    model = config.model;
    dbg(`model from config: ${model}`);
  } else if (resumeModel && availableModels?.includes(resumeModel)) {
    model = resumeModel;
    dbg(`resuming model from picker: ${model}`);
  } else {
    const lastModelForProvider = lastSession?.provider === providerName ? lastSession.model : null;
    dbg(`opening selectModel (default=${lastModelForProvider ?? '<none>'})`);
    model = await selectModelInk(
      availableModels ?? [],
      lastModelForProvider,
      provider,
      providerName,
    );
    dbg(`selectModel returned: ${model}`);
  }

  dbg(`validating model capabilities for ${model}`);
  const validation = await validateModelToolSupport(provider, model);
  dbg(`validation mode=${validation.mode}`);
  if (validation.mode === 'unreachable') {
    console.log(renderError(validation.reason));
    process.exit(1);
  }
  const useTextToolFallback = validation.mode === 'fallback';
  return {
    model,
    useTextToolFallback,
    ...(useTextToolFallback ? { validationWarning: validation.warning } : {}),
    validationMode: validation.mode,
  };
}
