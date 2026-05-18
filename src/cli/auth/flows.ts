import chalk from 'chalk';
import type { Config, GoogleAiStudioAuthMode } from '../../core/config/types.js';
import type { ProviderDescriptor } from '../../providers/registry.js';
import { resolveToken } from '../../providers/registry.js';
import { getGlobalConfigDir, loadConfig, saveGlobalConfig } from '../../core/config/index.js';
import { appendProviderLog } from '../../core/session/session-log.js';
import { getCopilotAuthStorageNote, CopilotAuthManager } from '../../providers/copilot/auth.js';
import {
  GoogleAiStudioAuthManager,
  getGoogleAiStudioOAuthErrorMessage,
  getGoogleAiStudioOAuthStorageNote,
} from '../../providers/googleaistudio/auth.js';
import { exitStartupSelection, isExitSelection, promptText } from '../prompts.js';
import { errorMessage } from '../../utils/errors.js';
import type { AuthResult } from './types.js';

export function resolveGoogleAiStudioAuthMode(
  config: Config,
  cliToken?: string,
): GoogleAiStudioAuthMode | undefined {
  if (cliToken) return 'api-key';
  if (config.googleAiStudioAuthMode === 'oauth') return 'oauth';
  const apiKey =
    config.googleAiStudioToken ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (apiKey) return 'api-key';
  return undefined;
}

export async function ensureCopilotAuth(config: Config, cliToken?: string): Promise<AuthResult> {
  const copilotToken =
    cliToken ??
    config.copilotToken ??
    process.env.GITHUB_COPILOT_API_KEY ??
    process.env.COPILOT_API_KEY;
  if (copilotToken) {
    appendProviderLog({
      provider: 'copilot',
      category: 'auth',
      action: 'authenticate',
      outcome: 'success',
      detail: cliToken ? 'using token from --token' : 'using existing copilot token',
    });
    return { token: copilotToken, shouldSave: false };
  }

  if (config.githubToken) {
    appendProviderLog({
      provider: 'copilot',
      category: 'auth',
      action: 'authenticate',
      outcome: 'success',
      detail: 'using saved GitHub token',
    });
    return { githubToken: config.githubToken, shouldSave: false };
  }

  appendProviderLog({
    provider: 'copilot',
    category: 'auth',
    action: 'authenticate',
    outcome: 'started',
    detail: 'starting device flow',
  });
  console.log(chalk.cyan('  GitHub Copilot sign-in required.'));
  const auth = new CopilotAuthManager();
  await auth.authenticateWithDeviceFlow(async ({ verificationUri, userCode, expiresIn }) => {
    appendProviderLog({
      provider: 'copilot',
      category: 'auth',
      action: 'device-flow',
      outcome: 'started',
      detail: `verificationUri=${verificationUri} expiresIn=${expiresIn}s userCodeIssued=true`,
    });
    console.log(chalk.dim(`  Open ${verificationUri}`));
    console.log(chalk.dim(`  Enter code: ${chalk.bold(userCode)}`));
    console.log(chalk.dim(`  Code expires in ${Math.ceil(expiresIn / 60)} minute(s).`));
    console.log(chalk.dim(`  ${getCopilotAuthStorageNote()}`));
  });
  appendProviderLog({
    provider: 'copilot',
    category: 'auth',
    action: 'authenticate',
    outcome: 'success',
    detail: 'device flow completed and credentials saved',
  });
  console.log(
    chalk.dim(
      `  Signed in with GitHub and saved credentials to ${getGlobalConfigDir()}/config.json`,
    ),
  );
  const refreshed = await loadConfig(process.cwd(), {
    provider: undefined,
    model: undefined,
    host: undefined,
    token: undefined,
  });
  return { githubToken: refreshed.githubToken, shouldSave: false };
}

export async function ensureGoogleAiStudioAuth(
  descriptor: ProviderDescriptor,
  config: Config,
  cliToken?: string,
): Promise<AuthResult> {
  const configuredMode = resolveGoogleAiStudioAuthMode(config, cliToken);
  const existingToken = resolveToken(descriptor, config, cliToken);

  if (configuredMode === 'oauth') {
    appendProviderLog({
      provider: 'googleaistudio',
      category: 'auth',
      action: 'authenticate',
      outcome: 'started',
      detail: 'validating OAuth (ADC)',
    });
    const auth = new GoogleAiStudioAuthManager({ authMode: 'oauth' });
    await auth.validate();
    appendProviderLog({
      provider: 'googleaistudio',
      category: 'auth',
      action: 'authenticate',
      outcome: 'success',
      detail: 'validated OAuth (ADC)',
    });
    return { authMode: 'oauth', shouldSave: false };
  }

  if (existingToken) {
    appendProviderLog({
      provider: 'googleaistudio',
      category: 'auth',
      action: 'authenticate',
      outcome: 'success',
      detail: cliToken ? 'using token from --token' : 'using configured API key',
    });
    return { token: existingToken, authMode: 'api-key', shouldSave: false };
  }

  appendProviderLog({
    provider: 'googleaistudio',
    category: 'auth',
    action: 'authenticate',
    outcome: 'started',
    detail: 'prompting for auth method',
  });
  console.log(chalk.cyan('  Google AI Studio authentication required.'));
  console.log(chalk.cyan('    1.') + ' API key');
  console.log(chalk.cyan('    2.') + ` OAuth ${chalk.dim('(Application Default Credentials)')}`);
  console.log(chalk.cyan('    0.') + ' Exit');
  console.log(chalk.dim(`  ${getGoogleAiStudioOAuthStorageNote()}`));
  const choice = (
    await promptText(chalk.cyan('  Choose auth method (press Enter for API key, 0 to exit): '))
  ).toLowerCase();
  if (isExitSelection(choice)) exitStartupSelection();

  if (choice === '2' || choice === 'oauth') {
    appendProviderLog({
      provider: 'googleaistudio',
      category: 'auth',
      action: 'authenticate',
      outcome: 'started',
      detail: 'selected OAuth (ADC)',
    });
    const auth = new GoogleAiStudioAuthManager({ authMode: 'oauth' });
    try {
      await auth.validate();
    } catch (error: unknown) {
      const detail = errorMessage(error) || getGoogleAiStudioOAuthErrorMessage();
      appendProviderLog({
        provider: 'googleaistudio',
        category: 'auth',
        action: 'authenticate',
        outcome: 'error',
        detail,
      });
      throw new Error(detail);
    }
    await saveGlobalConfig({ googleAiStudioAuthMode: 'oauth' });
    appendProviderLog({
      provider: 'googleaistudio',
      category: 'auth',
      action: 'authenticate',
      outcome: 'success',
      detail: 'validated OAuth (ADC) and saved auth preference',
    });
    console.log(
      chalk.dim(`  Saved Google AI Studio auth preference to ${getGlobalConfigDir()}/config.json`),
    );
    return { authMode: 'oauth', shouldSave: false };
  }

  appendProviderLog({
    provider: 'googleaistudio',
    category: 'auth',
    action: 'authenticate',
    outcome: 'started',
    detail: 'prompting for API key',
  });
  const token = await promptText(descriptor.inputPrompt ?? '  Enter Google AI Studio API key: ', {
    secret: true,
  });
  if (!token) {
    appendProviderLog({
      provider: 'googleaistudio',
      category: 'auth',
      action: 'authenticate',
      outcome: 'error',
      detail: 'API key was empty',
    });
    throw new Error(descriptor.missingError ?? 'Google AI Studio API key required.');
  }
  return { token, authMode: 'api-key', shouldSave: true };
}
