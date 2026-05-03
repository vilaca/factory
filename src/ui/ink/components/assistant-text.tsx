import React from 'react';
import { Box, Text } from 'ink';
import { renderMarkdown } from '../../renderer.js';

interface Props {
  text: string;
  streaming: boolean;
}

export function AssistantText({ text, streaming }: Props): React.ReactElement {
  const rendered = renderMarkdown(text);
  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text color="cyan">⏺</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <Text>
          {rendered}
          {streaming ? <Text color="cyan">▌</Text> : null}
        </Text>
      </Box>
    </Box>
  );
}
