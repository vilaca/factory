import React from 'react';
import { Box, Text } from 'ink';
import type { DisplayItem } from '../types.js';
import { summarizeToolArgs } from '../format.js';
import { AssistantText } from './assistant-text.js';

export function DisplayItemView({
  item,
  showFullOutput = false,
  emojiMode = false,
  userEmoji,
}: {
  item: DisplayItem;
  showFullOutput?: boolean;
  emojiMode?: boolean;
  userEmoji?: string;
}): React.ReactElement {
  switch (item.kind) {
    case 'user-input': {
      const icon = emojiMode ? `${userEmoji ?? '🧑🏻‍💻'} ` : '> ';
      return <Text color="green" bold>{icon}{item.text}</Text>;
    }
    case 'assistant-text':
      return <AssistantText text={item.text} streaming={item.streaming} emojiMode={emojiMode} />;
    case 'tool-call': {
      const denied = item.status === 'denied';
      return (
        <ToolCallLine
          icon={denied ? '🚫' : '🔧'}
          toolName={item.toolName}
          args={item.args}
          denied={denied}
        />
      );
    }
    case 'tool-result': {
      const body = showFullOutput && item.outputFull ? item.outputFull : item.output;
      const lines = body.split('\n');
      // Successful non-empty results don't get a standalone icon line — the
      // preceding tool-call panel already shows the tool ran, so a bare ✓
      // above its output was just visual noise. Edit/Write keep an inline
      // ✅ prefix on the first body line so file-mutating successes still
      // pop out at a glance.
      // Failure (✗) and empty-success (○) keep the icon-only line — those
      // are the cases where the body alone wouldn't carry the signal.
      if (item.success && !item.empty) {
        const isEdit = item.toolName === 'Edit' || item.toolName === 'Write';
        return (
          <Box flexDirection="column">
            {lines.map((line, i) => (
              <Text dimColor key={i}>{i === 0 && isEdit ? `  ✅ ${line}` : `    ${line}`}</Text>
            ))}
          </Box>
        );
      }
      // TODO: collapse the empty-success case to a single line — `❌ No
      // matches found.` (or similar) instead of the current two-line
      // "  ○\n     No matches found." render. Requires checking item.empty
      // and either inlining the body alongside the icon or replacing the
      // generic ○ with a body-aware glyph (❌ for grep/glob misses, etc.).
      const icon = !item.success ? '  ✗' : '  ○';
      const color = !item.success ? 'red' : 'yellow';
      return (
        <Box flexDirection="column">
          <Text color={color}>{icon}</Text>
          {lines.map((line, i) => (
            <Text dimColor key={i}>    {line}</Text>
          ))}
        </Box>
      );
    }
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
            if (line.level === 'info') {
              return <Text key={i} dimColor={!line.bold} bold={line.bold}>{line.text}</Text>;
            }
            return <Text key={i} color={colorMap[line.level]} bold={line.bold}>{line.text}</Text>;
          })}
        </Box>
      );
    }
    default:
      return <Text>{(item as any).text ?? ''}</Text>;
  }
}

export function ToolCallLine({
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
  if (!summary) {
    return (
      <Text>
        {icon} <Text color={nameColor} bold>{toolName}</Text>
      </Text>
    );
  }
  // Args always render indented on the next line so the layout doesn't shift
  // based on length — short Glob patterns and long Bash commands look the
  // same shape at a glance.
  return (
    <Box flexDirection="column">
      <Text>
        {icon} <Text color={nameColor} bold>{toolName}</Text>:
      </Text>
      <Text color={denied ? 'red' : undefined}>{`    ${summary}`}</Text>
    </Box>
  );
}
