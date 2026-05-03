import readline from 'readline';
import chalk from 'chalk';
import type { Config } from '../core/config-types.js';
import type { ModelPickerInfo, Provider } from '../providers/types.js';
import type { ProviderDescriptor, StartupProviderName } from '../providers/descriptors.js';
import { DESCRIPTORS, DESCRIPTOR_LIST } from '../providers/descriptors.js';
import { renderModelList, renderError } from '../ui/renderer.js';
import { exitStartupSelection, isExitSelection, promptText } from './prompts.js';
import { probeModels, type StartupCredentials } from './auth.js';

interface ModelChoice {
  value: string;
  label: string;
  detail?: string;
  warning?: string;
}

export async function selectModel(models: string[], defaultModel?: string | null, provider?: Provider): Promise<string> {
  // TODO: Evaluate whether the picker should prefer a maintained whitelist of
  // models known to work well by default, while still letting users pick any
  // other discovered model "at their own risk". This could improve UX, but it
  // would add ongoing whitelist maintenance cost across providers.
  const choices: ModelChoice[] = models.map(model => {
    const pickerInfo: ModelPickerInfo | undefined = provider?.getModelPickerInfo?.(model);
    return {
      value: model,
      label: pickerInfo?.label ?? provider?.getDisplayModelName?.(model) ?? model,
      detail: pickerInfo?.detail,
      warning: pickerInfo?.warning,
    };
  });

  if (choices.length === 0) {
    console.log(renderError('No models available.'));
    process.exit(1);
  }

  if (choices.length === 1) {
    return choices[0].value;
  }

  console.log(renderModelList(choices));
  console.log(chalk.cyan('    Q.') + ' Exit');

  const hasDefault = defaultModel ? choices.some(model => model.value === defaultModel) : false;
  const promptString = hasDefault
    ? chalk.cyan(`  Enter model number or name (press Enter for ${chalk.bold(defaultModel)}, Q to exit): `)
    : chalk.cyan('  Enter model number or name (Q to exit): ');

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    rl.question(promptString, (answer) => {
      rl.close();
      const trimmed = answer.trim();

      if (isExitSelection(trimmed)) exitStartupSelection();

      if (trimmed === '' && hasDefault) {
        resolve(defaultModel as string);
        return;
      }

      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num >= 1 && num <= choices.length) {
        resolve(choices[num - 1].value);
        return;
      }

      const exact = choices.find(m => m.value === trimmed || m.label === trimmed);
      if (exact) {
        resolve(exact.value);
        return;
      }

      const lower = trimmed.toLowerCase();
      const partial = choices.find(m =>
        m.value.toLowerCase().includes(lower) || m.label.toLowerCase().includes(lower)
      );
      if (partial) {
        resolve(partial.value);
        return;
      }

      if (trimmed.includes('/')) {
        resolve(trimmed);
        return;
      }

      console.log(chalk.dim(`  Model "${trimmed}" not found, using ${choices[0].value}`));
      resolve(choices[0].value);
    });
  });
}

export interface PickerOption {
  descriptor: ProviderDescriptor;
  models?: string[];
  /** True when a `when-reachable` provider failed its probe — surfaced in
   * the picker as a dimmed "(offline)" entry instead of being hidden. */
  offline?: boolean;
}

export function buildPickerOptions(
  probedModels: Map<StartupProviderName, string[] | null>,
): PickerOption[] {
  return DESCRIPTOR_LIST.map(descriptor => {
    const models = probedModels.get(descriptor.name) ?? null;
    const offline = descriptor.showInPicker === 'when-reachable' && !models;
    return { descriptor, models: models ?? undefined, offline };
  }).sort((a, b) => a.descriptor.label.localeCompare(b.descriptor.label));
}

export async function findDefaultSelection(
  lastSession: { provider: string; model: string } | null,
  probedModels: Map<StartupProviderName, string[] | null>,
  config: Config,
  credentials: Map<StartupProviderName, StartupCredentials>,
): Promise<{ provider: StartupProviderName; model?: string } | undefined> {
  if (!lastSession) return undefined;
  const descriptor = (DESCRIPTORS as Record<string, ProviderDescriptor | undefined>)[lastSession.provider];
  if (!descriptor) return undefined;

  let models = probedModels.get(descriptor.name) ?? null;
  if (!models && !descriptor.probeAtStartup) {
    const creds = credentials.get(descriptor.name) ?? {};
    if (creds.token || creds.githubToken) {
      models = await probeModels(descriptor.name, {
        host: config.host,
        token: creds.token,
        githubToken: creds.githubToken,
        accountId: creds.accountId,
        googleAiStudioAuthMode: creds.authMode,
      });
    }
  }

  if (models?.includes(lastSession.model)) {
    return { provider: descriptor.name, model: lastSession.model };
  }
  return undefined;
}
