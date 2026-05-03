import React from 'react';
import { Text } from 'ink';
import { renderMarkdown } from '../../renderer.js';

interface Props {
  text: string;
  streaming: boolean;
}

export function AssistantText({ text, streaming }: Props): React.ReactElement {
  const rendered = renderMarkdown(text);
  return (
    <Text>
      <Text color="cyan">⏺ </Text>
      {rendered}
      {streaming ? <Text color="cyan">▌</Text> : null}
    </Text>
  );
}
