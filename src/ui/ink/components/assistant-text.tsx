import React from 'react';
import { Text } from 'ink';
import { renderMarkdown } from '../../renderer.js';

interface Props {
  text: string;
  streaming: boolean;
  emojiMode?: boolean;
}

export function AssistantText({ text, streaming, emojiMode }: Props): React.ReactElement {
  const rendered = renderMarkdown(text);
  const icon = emojiMode ? '🤖 ' : '⏺ ';
  return (
    <Text>
      <Text color="cyan">{icon}</Text>
      {rendered}
      {streaming ? <Text color="cyan">▌</Text> : null}
    </Text>
  );
}
