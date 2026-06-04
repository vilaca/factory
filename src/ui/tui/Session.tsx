import React from 'react';
import { SessionContainer } from './session/SessionContainer.js';
import type { SessionProps } from './session/types.js';

export type { SessionProps };

export function Session(props: SessionProps): React.ReactElement {
  return <SessionContainer {...props} />;
}
