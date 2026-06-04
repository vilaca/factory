import { runHook } from '../../core/hooks/index.js';
import { errorMessage } from '../../utils/errors.js';
import type { HeadlessOptions } from './types.js';
import type { HeadlessRuntime } from './setup.js';

export async function teardownHeadlessRun(
  options: HeadlessOptions,
  runtime: HeadlessRuntime,
): Promise<number> {
  process.stdout.write('\n');
  if (runtime.state.permissionDeniedTool && runtime.state.exitCode === 0) {
    process.stderr.write(
      `factory: tool '${runtime.state.permissionDeniedTool}' requires permission but stdin is not a TTY. ` +
        `Add '${runtime.state.permissionDeniedTool}' to permissions.allowAll in ~/.factory/config.json to allow it in headless mode.\n`,
    );
    runtime.state.exitCode = 3;
  }
  if (runtime.hooksEnabled) {
    try {
      const r = await runHook(
        'SessionEnd',
        { provider: options.provider.name, model: options.model, cwd: runtime.cwd },
        {
          cwd: runtime.cwd,
          config: options.agentConfig?.hooks,
          envPolicy: options.envPolicy,
          onStderr: runtime.onHookStderr,
        },
      );
      for (const e of r.errors) runtime.onHookError('SessionEnd', e);
    } catch (err: unknown) {
      runtime.onHookError('SessionEnd', errorMessage(err));
    }
  }
  runtime.sessionLogger?.logSessionEnd();
  runtime.sessionLogger?.close();
  return runtime.state.exitCode;
}
