import React from 'react';
import { render } from 'ink';
import { App, type AppProps } from './App.js';

export interface RenderAppResult {
  waitUntilExit: () => Promise<void>;
  unmount: () => void;
}

export function renderApp(options: AppProps): RenderAppResult {
  const instance = render(<App {...options} />, {
    exitOnCtrlC: false,
  });
  return {
    waitUntilExit: async () => {
      await instance.waitUntilExit();
    },
    unmount: () => instance.unmount(),
  };
}
