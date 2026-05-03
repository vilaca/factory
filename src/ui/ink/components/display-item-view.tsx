import React from 'react';
import { Box, Text } from 'ink';
import type { DisplayItem } from '../types.js';
import { formatArgValue } from '../format.js';
import { renderMarkdown } from '../../renderer.js';

export function DisplayItemView({ item }: { item: DisplayItem }): React.ReactElement {
  switch (item.kind) {
    case 'user-input':
      return <Text color="green" bold>{`> ${item.text}`}</Text>;
    case 'assistant-text': {
      const body = item.streaming ? `${item.text}▌` : renderMarkdown(item.text);
      return (
        <Box flexDirection="row">
          <Box width={2} flexShrink={0}>
            <Text color="cyan">{item.streaming ? ' ' : '⏺'}</Text>
          </Box>
          <Box flexGrow={1} flexDirection="column">
            <Text dimColor={item.streaming}>{body}</Text>
          </Box>
        </Box>
      );
    }
    case 'tool-call':
      return (
        <Box flexDirection="column">
          <Text color="cyan">▶ <Text bold>{item.toolName}</Text></Text>
          {Object.entries(item.args).map(([k, v]) => (
            <Text dimColor key={k}>    {k}: {formatArgValue(v)}</Text>
          ))}
        </Box>
      );
    case 'tool-result': {
      const lines = item.output.split('\n');
      // Empty success (e.g. Grep with zero matches) renders distinctly so it
      // doesn't look identical to a "found something" success.
      const icon = !item.success ? '  ✗' : item.empty ? '  ○' : '  ✓';
      const color = !item.success ? 'red' : item.empty ? 'yellow' : 'green';
      return (
        <Box flexDirection="column">
          <Text color={color}>{icon}</Text>
          {lines.map((line, i) => (
            <Text dimColor key={i}>    {line}</Text>
          ))}
        </Box>
      );
    }
    case 'tool-denied':
      return <Text dimColor>  (denied)</Text>;
    case 'tool-planned':
      return (
        <Box flexDirection="column">
          <Text color="cyan">[planned] <Text bold>{item.toolName}</Text></Text>
          {Object.entries(item.args).map(([k, v]) => (
            <Text dimColor key={k}>     {k}: {formatArgValue(v)}</Text>
          ))}
        </Box>
      );
    case 'notice': {
      const colorMap = { info: undefined, warn: 'yellow', danger: 'red', cyan: 'cyan' } as const;
      const color = colorMap[item.level];
      if (item.level === 'info') return <Text dimColor>{item.text}</Text>;
      return <Text color={color}>{item.text}</Text>;
    }
    default:
      return <Text>{(item as any).text ?? ''}</Text>;
  }
}
