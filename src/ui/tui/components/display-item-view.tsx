import React from 'react';
import { Box, Text } from 'ink';
import type { DisplayItem } from '../types.js';
import { summarizeToolArgs } from '../format.js';
import { AssistantText } from './assistant-text.js';
import { TOOL_NAMES } from '../../../tools/types.js';

// eslint-disable-next-line complexity -- TODO(complexity)
export function DisplayItemView({
  item,
  showFullOutput = false,
  emojiMode = false,
  userEmoji,
  continuation = false,
  failed = false,
}: {
  item: DisplayItem;
  showFullOutput?: boolean;
  emojiMode?: boolean;
  userEmoji?: string;
  /** When true and `item` is a tool-call, render only the args line (no
   *  icon + tool name header). Set by ConversationDisplay when the previous
   *  item was a tool-call of the same tool. */
  continuation?: boolean;
  /** When true and `item` is a tool-call, the matching tool-result reported
   *  failure. ConversationDisplay computes this via lookahead so the call
   *  panel can carry the failure marker (✗) at the top instead of letting
   *  the result panel be the only place that signals failure. */
  failed?: boolean;
}): React.ReactElement {
  switch (item.kind) {
    case 'user-input': {
      const icon = emojiMode ? `${userEmoji ?? '🧑🏻‍💻'} ` : '> ';
      return (
        <Text color="green" bold>
          {icon}
          {item.text}
        </Text>
      );
    }
    case 'assistant-text':
      return <AssistantText text={item.text} streaming={item.streaming} emojiMode={emojiMode} />;
    case 'tool-call': {
      const denied = item.status === 'denied';
      const icon = denied ? '🚫' : failed ? '✗' : '🔧';
      return (
        <ToolCallLine
          icon={icon}
          toolName={item.toolName}
          args={item.args}
          denied={denied}
          failed={failed}
          continuation={continuation}
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
      // Failures don't render a standalone ✗ line either — the call panel
      // header now shows ✗ in place of 🔧 (computed in ConversationDisplay
      // via lookahead), so the body alone is enough.
      // Empty-success (◌) keeps the icon-only line because nothing else
      // distinguishes "succeeded but found nothing" from a regular run.
      if (item.success && !item.empty) {
        const isEdit = item.toolName === TOOL_NAMES.Edit || item.toolName === TOOL_NAMES.Write;
        return (
          <Box flexDirection="column">
            {lines.map((line, i) => (
              <Text dimColor key={i}>
                {i === 0 && isEdit ? `  ✅ ${line}` : `    ${line}`}
              </Text>
            ))}
          </Box>
        );
      }
      if (!item.success) {
        return (
          <Box flexDirection="column">
            {lines.map((line, i) => (
              <Text dimColor key={i}>
                {' '}
                {line}
              </Text>
            ))}
          </Box>
        );
      }
      return (
        <Box flexDirection="column">
          {lines.map((line, i) => (
            <Text color="green" key={i}>
              {i === 0 ? `    ◌ ${line}` : `      ${line}`}
            </Text>
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
              return (
                <Text key={i} dimColor={!line.bold} bold={line.bold}>
                  {line.text}
                </Text>
              );
            }
            return (
              <Text key={i} color={colorMap[line.level]} bold={line.bold}>
                {line.text}
              </Text>
            );
          })}
        </Box>
      );
    }
    case 'notice-box': {
      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={item.borderColor ?? 'cyan'}
          paddingX={1}
        >
          {item.lines.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      );
    }
    default: {
      const maybeText = (item as unknown as { text?: unknown }).text;
      return <Text>{typeof maybeText === 'string' ? maybeText : ''}</Text>;
    }
  }
}

export function ToolCallLine({
  icon,
  toolName,
  args,
  denied,
  failed,
  continuation,
}: {
  icon: string;
  toolName: string;
  args: Record<string, unknown>;
  denied?: boolean;
  /** When true, the matching tool-result reported failure. Drives the red
   *  coloring (same treatment as denied) and adds a ✗ prefix on continuation
   *  rows where the header is suppressed. */
  failed?: boolean;
  /** When true, suppress the icon + tool-name header and render only the
   *  indented arg line. Used when the immediately previous item was a
   *  tool-call of the same tool — three Glob calls in a row read as one
   *  block instead of three repeated headers. */
  continuation?: boolean;
}): React.ReactElement {
  const summary = summarizeToolArgs(toolName, args);
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- both bools; want logical OR, not nullish-fallback
  const isProblem = denied || failed;
  const nameColor = isProblem ? 'red' : 'cyan';
  if (continuation && summary) {
    // Continuation rows have no header to carry the failure marker, so the
    // ✗ has to live on the args line itself. `  ✗ ` is 4 chars wide so the
    // summary stays aligned with non-continuation rows (4-space indent).
    const prefix = failed ? '  ✗ ' : '    ';
    return <Text color={isProblem ? 'red' : undefined}>{`${prefix}${summary}`}</Text>;
  }
  if (!summary) {
    return (
      <Text>
        {icon}{' '}
        <Text color={nameColor} bold>
          {toolName}
        </Text>
      </Text>
    );
  }
  // Args always render indented on the next line so the layout doesn't shift
  // based on length — short Glob patterns and long Bash commands look the
  // same shape at a glance.
  return (
    <Box flexDirection="column">
      <Text>
        {icon}{' '}
        <Text color={nameColor} bold>
          {toolName}
        </Text>
        :
      </Text>
      <Text color={isProblem ? 'red' : undefined}>{`    ${summary}`}</Text>
    </Box>
  );
}
