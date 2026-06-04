import type { SlashCommandSpec } from './types.js';
import { dispatchRotate } from './rotate.js';
import { dispatchKeys } from './keys.js';
import { dispatchStats } from './stats.js';
import { printHelp } from './help.js';
import { handleCompactionModel, handleModel } from './handlers/model.js';
import { handleApprove, handleCancel, handlePlan, printPlanQueue } from './handlers/plan.js';
import {
  handleCorrect,
  handleEmoji,
  handleExpCommand,
  handleFull,
  handleHooks,
  handleLog,
  handleSkillsList,
  handleSkillShow,
} from './handlers/diagnostics.js';
import { handleClose, handleExit, handleNew, handleSwitch, handleTabs } from './handlers/tabs.js';

/** Single-source-of-truth declaration for every slash command. The
 *  dispatch map and `printHelp`'s text output are both derived from
 *  this array, so adding a command is one entry in this table — drift
 *  between dispatch and help is no longer possible.
 *
 *  Field semantics:
 *  - `name`        : canonical form, including the leading `/`. The
 *                    synopsis shown by `/help` lists this first.
 *  - `aliases`     : extra dispatch-only names that resolve to the same
 *                    handler. Listed alongside `name` in the synopsis.
 *                    Omit for commands without aliases.
 *  - `argSpec`     : free-form arg syntax shown after the synopsis,
 *                    e.g. `'[<name>]'`, `'<n|label>'`, `'on|off'`. Omit
 *                    for arg-less commands.
 *  - `description` : line shown under the command in `/help`. Omitting
 *                    `description` makes the command an **easter egg**:
 *                    registered in the dispatcher but invisible to
 *                    `/help`.
 *  - `handler`     : the function called by `dispatchSlashCommand`.
 *
 *  Ordering matters: `/help` renders entries in this array's order.
 *  Group commands by purpose (tabs → conversation/model → rotation /
 *  diagnostics → per-tab → plan-mode → misc → help) to keep the output
 *  scannable. */
export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  {
    name: '/exit',
    aliases: ['/quit', '/q'],
    description: 'Exit (or close active tab if multiple open)',
    handler: handleExit,
  },
  {
    name: '/new',
    argSpec: '[label]',
    description: 'Open a new tab',
    handler: handleNew,
  },
  { name: '/close', description: 'Close the active tab', handler: handleClose },
  { name: '/tabs', description: 'List open tabs', handler: handleTabs },
  {
    name: '/switch',
    argSpec: '<n|label>',
    description: 'Switch to tab by index, label, or unique prefix',
    handler: handleSwitch,
  },
  {
    name: '/clear',
    description: 'Clear conversation history',
    handler: (_arg, { agent }) => agent.clearConversation(),
  },
  {
    name: '/model',
    argSpec: '[<provider>:<model>]',
    description: 'Open the provider/model picker, or switch with <provider>:<model>',
    handler: handleModel,
  },

  {
    name: '/compaction-model',
    argSpec: '[show|clear]',
    description:
      'Open the picker to choose a provider/model for context compaction (defaults to primary). `show` prints current; `clear` resets to primary.',
    handler: handleCompactionModel,
  },
  {
    name: '/rotate',
    description: 'Manage the rotation chain (provider/model fallbacks)',
    handler: (arg, { agent }) => dispatchRotate(arg, agent),
  },
  {
    name: '/keys',
    argSpec: '[<provider>]',
    description: 'Show saved keys with usage / rate-limit / cache-hit counters',
    handler: (arg, { agent }) => dispatchKeys(arg, agent),
  },
  {
    name: '/stats',
    description: 'Cache hit rate, compaction events, largest tool results for the current session',
    handler: (arg, { agent }) => dispatchStats(arg, agent),
  },
  {
    name: '/hooks',
    description: 'List configured hooks from agent.hooks config',
    handler: handleHooks,
  },
  {
    name: '/full',
    description: 'Toggle full vs preview tool output (going forward)',
    handler: handleFull,
  },
  {
    name: '/cwd',
    argSpec: '[dir]',
    description: "Show or change this tab's working directory",
    handler: (arg, { agent }) => agent.setCwd(arg),
  },
  {
    name: '/permissions',
    description: 'Reset tool permissions',
    handler: (_arg, { agent }) => {
      agent.resetPermissions();
      agent.addNotice('info', 'Permissions reset.');
    },
  },
  {
    name: '/plan',
    description: 'Toggle plan mode (or show queue if one exists)',
    handler: (_arg, ctx) => handlePlan(ctx),
  },
  {
    name: '/queue',
    description: 'Show the queued plan',
    handler: (_arg, { agent }) => printPlanQueue(agent),
  },
  // `/approve, y` and `/cancel, n` — the `y` / `n` are keyboard
  // shortcuts handled outside the slash dispatcher (plan-mode input
  // layer). Documented in the synopsis via a manually-written argSpec
  // so the help text reads `/approve, y` exactly as before. They are
  // NOT aliases (no `y` / `n` handler entry).
  {
    name: '/approve',
    argSpec: ', y',
    description: 'Execute the queued plan',
    handler: handleApprove,
  },
  {
    name: '/cancel',
    argSpec: ', n',
    description: 'Drop the queued plan',
    handler: (_arg, ctx) => handleCancel(ctx),
  },
  {
    name: '/log',
    description: 'Show the current session log path',
    handler: (_arg, ctx) => handleLog(ctx),
  },
  {
    name: '/correct',
    argSpec: 'on|off',
    description: 'Toggle the LLM tool-call corrector',
    handler: handleCorrect,
  },
  {
    name: '/exp',
    argSpec: '[name on|off]',
    description: 'List or toggle experimental flags',
    handler: (arg, { agent }) => handleExpCommand(agent, arg),
  },
  {
    name: '/skills',
    description: 'List loaded skills (when experimental.skills is on)',
    handler: (_arg, { agent }) => handleSkillsList(agent),
  },
  {
    name: '/skill',
    argSpec: '<name>',
    description: 'Print the body of a loaded skill',
    handler: (arg, { agent }) => handleSkillShow(agent, arg),
  },
  {
    name: '/help',
    description: 'Show this help',
    handler: (_arg, { agent }) => printHelp(agent, SLASH_COMMANDS),
  },
  // Easter egg — `description` omitted, so `/emoji` is dispatched but
  // never appears in `/help`. `/emoji` toggles emoji mode;
  // `/emoji <glyph>` overrides the user prompt icon.
  { name: '/emoji', handler: handleEmoji },
];
