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
  console.log(chalk.cyan('    0.') + ' Exit');

  const hasDefault = defaultModel ? choices.some(model => model.value === defaultModel) : false;
  const promptString = hasDefault
    ? chalk.cyan(`  Enter model number or name (press Enter for ${chalk.bold(defaultModel)}, 0 to exit): `)
    : chalk.cyan('  Enter model number or name (0 to exit): ');

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

interface PickerOption {
  descriptor: ProviderDescriptor;
  models?: string[];
}

interface ProviderSelectionResult {
  provider: StartupProviderName;
  resumeLastModel: boolean;
}

export function buildPickerOptions(
  probedModels: Map<StartupProviderName, string[] | null>,
): PickerOption[] {
  // TODO: Give Anthropic the same startup-picker/auth-prompt/save-config
  // flow parity as the other hosted providers.
  return DESCRIPTOR_LIST.flatMap(descriptor => {
    const models = probedModels.get(descriptor.name) ?? null;
    if (descriptor.showInPicker === 'when-reachable' && !models) return [];
    return [{ descriptor, models: models ?? undefined }];
  });
}

export async function selectProvider(
  options: PickerOption[],
  defaultSelection?: { provider: StartupProviderName; model?: string },
): Promise<ProviderSelectionResult> {
  const defaultProvider = defaultSelection?.provider ?? options[0]?.descriptor.name ?? 'copilot';
  console.log(chalk.bold('\n  Select a provider:'));
  options.forEach((option, index) => {
    console.log(chalk.cyan(`    ${index + 1}.`) + ` ${option.descriptor.label}`);
  });
  console.log(chalk.cyan('    0.') + ' Exit');

  const defaultLabel = options.find(o => o.descriptor.name === defaultProvider)?.descriptor.label ?? defaultProvider;
  const providerPrompt = defaultSelection?.model
    ? chalk.cyan(`  Enter provider number or name (press Enter for ${chalk.bold(`${defaultLabel} / ${defaultSelection.model}`)}, 0 to exit): `)
    : chalk.cyan(`  Enter provider number or name (press Enter for ${chalk.bold(defaultLabel)}, 0 to exit): `);

  const answer = (await promptText(providerPrompt)).toLowerCase();
  if (isExitSelection(answer)) exitStartupSelection();
  if (answer === '') {
    return { provider: defaultProvider, resumeLastModel: Boolean(defaultSelection?.model) };
  }

  const byNumber = Number.parseInt(answer, 10);
  if (!Number.isNaN(byNumber) && byNumber >= 1 && byNumber <= options.length) {
    return { provider: options[byNumber - 1].descriptor.name, resumeLastModel: false };
  }

  const matched = options.find(o => o.descriptor.aliases.includes(answer));
  if (matched) {
    return { provider: matched.descriptor.name, resumeLastModel: false };
  }

  console.log(chalk.dim(`  Provider "${answer}" not recognized, using ${defaultLabel}.`));
  return { provider: defaultProvider, resumeLastModel: Boolean(defaultSelection?.model) };
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
