import type { AgentLoopApi } from '../agent-loop/use-agent-loop.js';
import type { TabsContextValue } from '../tabs/TabsContext.js';

export interface SlashCommandContext {
  agent: AgentLoopApi;
  exit: () => void;
  tabs?: TabsContextValue;
  openPicker?: () => void;
  toggleFullOutput?: () => boolean;
  /** Opens the provider/model picker in compaction-target mode and resolves
   *  with the chosen tuple (or null on cancel). Wired by the TUI; absent in
   *  headless/test contexts that don't host the picker. */
  openCompactionPicker?: () => Promise<{ providerName: string; model: string } | null>;
}

export type SlashHandler = (arg: string, ctx: SlashCommandContext) => void | Promise<void>;

export interface SlashCommandSpec {
  name: string;
  aliases?: readonly string[];
  argSpec?: string;
  description?: string;
  handler: SlashHandler;
}
