declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked';
  export function markedTerminal(options?: any): MarkedExtension;
  export default class Renderer {}
}
