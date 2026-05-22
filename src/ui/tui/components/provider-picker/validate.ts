import { useEffect } from 'react';
import type { ModelDisplayInfo, Stage, ValidateResult } from './types.js';
import { prepareModels } from './prepare.js';
import { errorMessage } from '../../../../utils/errors.js';

interface UseValidateKeyEffectArgs {
  stage: Stage;
  setStage: (s: Stage) => void;
  setModelIndex: (i: number) => void;
  validateKey?: (provider: string, token: string) => Promise<ValidateResult>;
  saveKey?: (provider: string, token: string) => Promise<string>;
  getModelInfo?: (provider: string, model: string) => ModelDisplayInfo | undefined;
  onError?: (source: string, message: string) => void;
}

const VALIDATE_TIMEOUT_MS = 3000;

/**
 * Drive the key-validation step as a side effect: when stage flips into
 * `key-validating`, race the provider's validate call against a 3 s timeout
 * and transition into `model`, `error`, or `key-validate-failed`. Extracted
 * from the main component to keep `ProviderPicker`'s cognitive complexity
 * under the sonarjs cap (the validation flow alone has four success/failure
 * branches that previously inflated the parent function's count).
 */
export function useValidateKeyEffect(args: UseValidateKeyEffectArgs): void {
  const { stage, setStage, setModelIndex, validateKey, saveKey, getModelInfo, onError } = args;
  const validatingToken = stage.kind === 'key-validating' ? stage.token : null;
  const validatingProvider = stage.kind === 'key-validating' ? stage.provider : null;

  useEffect(() => {
    if (!validatingToken || !validatingProvider) return;
    if (!validateKey || !saveKey) return;
    let cancelled = false;
    const timeout = new Promise<ValidateResult>(resolve => {
      setTimeout(
        () => resolve({ ok: false, error: `validation timed out after ${VALIDATE_TIMEOUT_MS / 1000}s` }),
        VALIDATE_TIMEOUT_MS,
      );
    });

    const reportFailure = (msg: string): void => {
      onError?.(`picker:validate:${validatingProvider}`, msg);
      setStage({
        kind: 'key-validate-failed',
        provider: validatingProvider,
        token: validatingToken,
        error: msg,
        choice: 0,
      });
    };

    const onValidateOk = async (result: ValidateResult): Promise<void> => {
      try {
        const newKeyId = await saveKey(validatingProvider, validatingToken);
        const models = prepareModels(
          result.models ?? [],
          getModelInfo ? m => getModelInfo(validatingProvider, m) : undefined,
        );
        if (models.length === 0) {
          onError?.(`picker:validate:${validatingProvider}`, 'no models returned');
          setStage({ kind: 'error', provider: validatingProvider, message: 'no models returned' });
          return;
        }
        setModelIndex(0);
        setStage({ kind: 'model', provider: validatingProvider, models, keyId: newKeyId });
      } catch (err) {
        reportFailure(errorMessage(err));
      }
    };

    void Promise.race([validateKey(validatingProvider, validatingToken), timeout]).then(
      async result => {
        if (cancelled) return;
        if (result.ok) await onValidateOk(result);
        else reportFailure(result.error ?? 'unknown error');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    validatingToken,
    validatingProvider,
    validateKey,
    saveKey,
    getModelInfo,
    onError,
    setStage,
    setModelIndex,
  ]);
}
