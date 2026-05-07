declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked';
  // Narrow to the subset of options this codebase actually uses. Extend
  // when a new option is needed — type errors here are intentional, not
  // permission to add `any`.
  export interface MarkedTerminalOptions {
    reflowText?: boolean;
    width?: number;
    showSectionPrefix?: boolean;
  }
  export function markedTerminal(options?: MarkedTerminalOptions): MarkedExtension;
  export default class Renderer {}
}
