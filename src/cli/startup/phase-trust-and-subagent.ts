import chalk from 'chalk';
import type { Provider } from '../../providers/types.js';
import type { Config, HookEntry } from '../../core/config/types.js';
import type { McpServerConfig } from '../../mcp/types.js';
import type { ToolRegistry } from '../../tools/registry.js';

/**
 * First-run trust check for project-local hooks AND MCP servers. The merged
 * config already folds project entries into `config.agent.hooks` and
 * `config.mcp.servers`, but we need the project-only slices (without
 * user-level entries) to fingerprint and prompt against — user-level config
 * is implicitly trusted (the user wrote it in their own home dir).
 *
 * Both threats share the same shape: project config → command execution at
 * startup. We bundle them into one trust prompt so the user makes one
 * decision per project.
 *
 * On reject (or non-TTY default 'n'), strips project hook entries AND
 * project MCP server entries from the merged config so neither fires for
 * this session.
 */
type ProjectHooks = NonNullable<NonNullable<Config['agent']>['hooks']>;

/** Render the trust-prompt summary listing project hooks + MCP servers. */
function printTrustSummary(
  projectHooks: ProjectHooks | undefined,
  projectMcp: McpServerConfig[] | undefined,
  hasHooks: boolean,
  hasMcp: boolean,
): void {
  console.log('');
  console.log(chalk.yellow(' ⚠ This project declares startup automation in .factory/config.json:'));
  if (hasHooks && projectHooks) {
    console.log(chalk.yellow('   hooks:'));
    for (const [event, entries] of Object.entries(projectHooks)) {
      for (const entry of (entries as HookEntry[] | undefined) ?? []) {
        const matcher = entry.matcher ? ` [${entry.matcher}]` : '';
        console.log(chalk.dim(`     ${event}${matcher}: ${entry.command}`));
      }
    }
  }
  if (hasMcp && projectMcp) {
    console.log(chalk.yellow('   MCP servers (auto-spawned at startup):'));
    for (const s of projectMcp) {
      const args = s.args && s.args.length > 0 ? ' ' + s.args.join(' ') : '';
      const cmd = s.command ?? s.url ?? '<none>';
      console.log(chalk.dim(`     ${s.name} [${s.transport}]: ${cmd}${args}`));
    }
  }
  console.log(
    chalk.yellow(' These run programs on your machine automatically. Trust this project? [y/N]'),
  );
}

/** Remove project-declared hooks and MCP servers from the merged config so
 *  the rejected session doesn't fire them. User-level entries survive. */
function stripProjectAutomation(
  config: Config,
  projectHooks: ProjectHooks | undefined,
  projectMcp: McpServerConfig[] | undefined,
  hasHooks: boolean,
  hasMcp: boolean,
): void {
  if (hasHooks && projectHooks && config.agent?.hooks) {
    const userOnlyHooks: typeof config.agent.hooks = {};
    for (const [event, entries] of Object.entries(config.agent.hooks) as Array<
      [string, HookEntry[] | undefined]
    >) {
      const projectEntries = projectHooks[event as keyof typeof projectHooks] ?? [];
      const projectCommands = new Set(projectEntries.map(e => e.command));
      const filtered = (entries ?? []).filter(e => !projectCommands.has(e.command));
      if (filtered.length > 0) {
        (userOnlyHooks as Record<string, unknown>)[event] = filtered;
      }
    }
    config.agent.hooks = userOnlyHooks;
  }
  if (hasMcp && projectMcp && config.mcp?.servers) {
    const projectNames = new Set(projectMcp.map(s => s.name));
    config.mcp = { servers: config.mcp.servers.filter(s => !projectNames.has(s.name)) };
  }
}

export async function handleProjectTrust(config: Config, cwd: string): Promise<void> {
  const { loadProjectConfig } = await import('../../core/config/index.js');
  const projectOnly = await loadProjectConfig(cwd);
  const projectHooks = projectOnly.agent?.hooks;
  const projectMcp = projectOnly.mcp?.servers;
  const hasHooks = !!projectHooks && Object.keys(projectHooks).length > 0;
  const hasMcp = !!projectMcp && projectMcp.length > 0;
  if (!hasHooks && !hasMcp) return;

  const { isProjectTrusted, recordTrust } = await import('../../core/hooks/trust.js');
  const trustables = {
    hooks: projectHooks,
    mcpServers: projectMcp,
  };
  if (await isProjectTrusted(cwd, trustables)) return;

  const { promptText } = await import('../prompts.js');
  printTrustSummary(projectHooks, projectMcp, hasHooks, hasMcp);
  const answer =
    process.stdout.isTTY && process.stdin.isTTY ? (await promptText(' > ')).toLowerCase() : 'n';
  if (answer === 'y' || answer === 'yes') {
    await recordTrust(cwd, trustables);
    console.log(
      chalk.dim(' Trusted. Will not prompt again unless the hook or MCP config changes.'),
    );
    return;
  }
  // Strip the project hooks from the merged config. User hooks
  // (from ~/.factory/config.json) survive — those came from a
  // different file and aren't in question.
  // Project MCP servers stripped the same way so the spawn step in main()
  // doesn't launch them.
  stripProjectAutomation(config, projectHooks, projectMcp, hasHooks, hasMcp);
  const rejected = [hasHooks ? 'hooks' : null, hasMcp ? 'MCP servers' : null]
    .filter(Boolean)
    .join(' and ');
  console.log(chalk.dim(` Project ${rejected} rejected for this session.`));
}

/**
 * Register the Delegate tool when the `subagents` experimental flag is
 * on. The subagent runs on the provider's weak-tier model (Haiku /
 * Llama-3.1-8B / Gemini-Flash) when a mapping exists, falling back to
 * the parent's model otherwise.
 */
export async function registerSubagentTool(
  provider: Provider,
  parentModel: string,
  registry: ToolRegistry,
): Promise<void> {
  const [{ createDelegateTool }, { selectWeakTier }] = await Promise.all([
    import('../../tools/delegate.js'),
    import('../../core/agent/call-model/weak-tier.js'),
  ]);
  const weakModel = selectWeakTier(provider, parentModel);
  registry.register(
    createDelegateTool({
      provider,
      parentModel,
      ...(weakModel ? { weakModel } : {}),
    }),
  );
}
