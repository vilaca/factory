import React from 'react';
import { Box, Text } from 'ink';
import type { DisplayItem } from '../types.js';
import { summarizeToolArgs } from '../format.js';
import { AssistantText } from './assistant-text.js';

export function DisplayItemView({ item }: { item: DisplayItem }): React.ReactElement {
  switch (item.kind) {
    case 'user-input':
      return <Text color="green" bold>{`> ${item.text}`}</Text>;
    case 'assistant-text':
      return <AssistantText text={item.text} streaming={item.streaming} />;
    case 'tool-call':
      return <ToolCallLine icon="🔧" toolName={item.toolName} args={item.args} />;
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
      return <ToolCallLine icon="🚫" toolName={item.toolName} args={item.args} denied />;
    case 'tool-planned':
      return <ToolCallLine icon="📋" toolName={item.toolName} args={item.args} />;
    case 'notice': {
      const colorMap = { info: undefined, warn: 'yellow', danger: 'red', cyan: 'cyan' } as const;
      const color = colorMap[item.level];
      if (item.level === 'info') return <Text dimColor>{item.text}</Text>;
      return <Text color={color}>{item.text}</Text>;
    }
    case 'notice-block': {
      const colorMap = { info: undefined, warn: 'yellow', danger: 'red', cyan: 'cyan' } as const;
      return (
        <Box flexDirection="column">
          {item.lines.map((line, i) => {
            if (line.level === 'info') return <Text key={i} dimColor>{line.text}</Text>;
            return <Text key={i} color={colorMap[line.level]}>{line.text}</Text>;
          })}
        </Box>
      );
    }
    default:
      return <Text>{(item as any).text ?? ''}</Text>;
  }
}

const INLINE_CHIP_THRESHOLD = 40;

function ToolCallLine({
  icon,
  toolName,
  args,
  denied,
}: {
  icon: string;
  toolName: string;
  args: Record<string, unknown>;
  denied?: boolean;
}): React.ReactElement {
  const summary = summarizeToolArgs(toolName, args);
  const nameColor = denied ? 'red' : 'cyan';
  const chipBg = denied ? 'red' : 'gray';
  if (!summary) {
    return (
      <Text>
        {icon} <Text color={nameColor} bold>{toolName}</Text>
      </Text>
    );
  }
  if (summary.length > INLINE_CHIP_THRESHOLD) {
    return (
      <Box flexDirection="column">
        <Text>
          {icon} <Text color={nameColor} bold>{toolName}</Text>:
        </Text>
        <Box width="100%" backgroundColor={chipBg}>
          <Text color="white" strikethrough={denied}>{` ${summary} `}</Text>
        </Box>
      </Box>
    );
  }
  return (
    <Text>
      {icon} <Text color={nameColor} bold>{toolName}</Text>:{' '}
      <Text backgroundColor={chipBg} color="white" strikethrough={denied}>{` ${summary} `}</Text>
    </Text>
  );
}
